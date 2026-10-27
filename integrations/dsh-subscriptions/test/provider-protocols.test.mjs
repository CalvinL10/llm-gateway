import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {BlockAssembler,createAssistantMessage} from '@deepseek-ai/dsh-llm';
import {MemoryTokenStore,OAuthService,ResponsesClient,AntigravityAdapter,AccountPoolStore,ClaudeAdapter,ClaudeCredentialStore,ClaudeModelSettingsStore} from '../../../.local/subscription-test-adapters.mjs';

const scratch=resolve(import.meta.dirname,'../../../.local/provider-protocol-tests');
const memory=()=>{let value=null;return {load:async()=>structuredClone(value),save:async next=>{value=structuredClone(next);},clear:async()=>{value=null;}};};
const sse=frames=>new Response(frames.map(frame=>'data: '+JSON.stringify(frame)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
const tools=[{name:'lookup',parameters:{type:'object',properties:{key:{type:'string'}},required:['key']}}];
async function collect(stream){const result=new BlockAssembler();for await(const chunk of stream)result.push(chunk);return result;}
function followup(options,result){const call=result.blocks().find(b=>b.type==='tool-call');assert.ok(call,'provider tool call');return {...options,messages:[...options.messages,
  createAssistantMessage({content:result.blocks(),source:{provider:options.provider,model:options.model,replayState:result.replayState}}),
  {role:'user',content:[{type:'tool-result',toolCallId:call.id,content:[{type:'text',text:'VALUE'}]}]}]};}

test('Codex subscription transport preserves tool results, model and OAuth auth without API-key fallback',async()=>{
  const store=new MemoryTokenStore();await store.save({accessToken:'TEST_ONLY',refreshToken:'TEST_ONLY_REFRESH',accountId:'fixture-account',expiresAt:Date.now()+3600000});
  const oauth=new OAuthService(store,{fetchFn:async()=>{throw Error('Unexpected token request');}});
  const calls=[];
  const client=new ResponsesClient(oauth,{}, {fetchFn:async(url,init)=>{
    calls.push({url:String(url),headers:new Headers(init.headers),body:JSON.parse(init.body)});
    return sse(calls.length===1?[
      {type:'response.output_item.done',output_index:0,item:{type:'function_call',call_id:'lookup-1',name:'lookup',arguments:'{"key":"x"}'}},
      {type:'response.completed',response:{}}]:[{type:'response.output_text.delta',delta:'DONE'},{type:'response.completed',response:{}}]);
  }});
  const options={provider:'codex-chatgpt',model:'gpt-5.6-sol',sessionId:'offline-codex',messages:[{role:'user',content:[{type:'text',text:'lookup x'}]}],tools};
  try {const first=await collect(client.stream(options));const last=await collect(client.stream(followup(options,first)));
    assert.ok(last.blocks().some(b=>b.type==='text'&&b.text==='DONE'));assert.equal(calls.length,2);
    for(const call of calls){assert.equal(call.body.model,options.model);assert.equal(call.headers.get('authorization'),'Bearer TEST_ONLY');assert.equal(call.headers.has('x-api-key'),false);}
    assert.ok(JSON.stringify(calls[1].body).includes('VALUE'));
  }finally{oauth.dispose();}
});

test('Antigravity subscription adapter completes a signed tool round trip with injected transport only',async()=>{
  const credential={access:'TEST_ONLY',expires:Date.now()+3600000,projectId:'offline-project'};
  const store={read:async()=>credential,path:()=>resolve(scratch,'antigravity.json')};
  const settings={enabledModelIds:['gemini-3.8-flash'],catalogModels:[],defaultReasoningEffort:'high'};
  const pool=new AccountPoolStore(resolve(scratch,'pool.json'),memory(),store);
  const calls=[];
  const adapter=new AntigravityAdapter(store,{read:async()=>settings},{status:()=>settings},{fetchFn:async(url,init)=>{
    calls.push({url:String(url),headers:new Headers(init.headers),body:JSON.parse(init.body)});
    return sse([{response:{candidates:[{content:{parts:calls.length===1?[
      {functionCall:{id:'lookup-1',name:'lookup',args:{key:'x'}},thoughtSignature:'offline-signature'}]:[{text:'DONE'}]},finishReason:'STOP'}]}}]);
  }},pool);
  const options={provider:'antigravity',model:'gemini-3.8-flash',sessionId:'offline-antigravity',messages:[{role:'user',content:[{type:'text',text:'lookup x'}]}],tools};
  const first=await collect(adapter.stream(options));const last=await collect(adapter.stream(followup(options,first)));
  assert.ok(last.blocks().some(b=>b.type==='text'&&b.text==='DONE'));assert.equal(calls.length,2);
  assert.ok(JSON.stringify(calls[1].body).includes('VALUE'));assert.ok(JSON.stringify(calls[1].body).includes('offline-signature'));
});

test('Claude subscription adapter preserves native tool use and OAuth authentication',async()=>{
  await mkdir(scratch,{recursive:true});
  const store=new ClaudeCredentialStore(resolve(scratch,'claude.json'),memory());
  await store.saveAccount({accessToken:'TEST_ONLY',refreshToken:'TEST_ONLY_REFRESH',expiresAt:Date.now()+3600000,scopes:['user:inference','user:profile'],account:{uuid:'offline-account'}});
  const settings=new ClaudeModelSettingsStore(resolve(scratch,'claude-models.json'));const calls=[];
  const adapter=new ClaudeAdapter(store,settings,undefined,{fetchFn:async(url,init)=>{
    calls.push({url:String(url),headers:new Headers(init.headers),body:JSON.parse(init.body)});
    return sse([{type:'message_start',message:{id:'message',usage:{input_tokens:1}}},...(calls.length===1?[
      {type:'content_block_start',index:0,content_block:{type:'tool_use',id:'lookup-1',name:'Lookup',input:{}}},
      {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"key":"x"}'}},
      {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:1}}]:[
      {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
      {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'DONE'}},
      {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}}]),{type:'message_stop'}]);
  },loadCatalog:async()=>[]});
  const options={provider:'claude-subscription',model:'claude-sonnet-4-6',sessionId:'offline-claude',messages:[{role:'user',content:[{type:'text',text:'lookup x'}]}],tools};
  const first=await collect(adapter.stream(options));const last=await collect(adapter.stream(followup(options,first)));
  assert.ok(last.blocks().some(b=>b.type==='text'&&b.text==='DONE'));assert.equal(calls.length,2);
  assert.equal(calls[0].headers.get('authorization'),'Bearer TEST_ONLY');assert.equal(calls[0].headers.has('x-api-key'),false);
  assert.ok(JSON.stringify(calls[1].body).includes('VALUE'));
});
