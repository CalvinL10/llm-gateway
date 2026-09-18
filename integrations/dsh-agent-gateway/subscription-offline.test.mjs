import assert from 'node:assert/strict';
import test from 'node:test';
import {ResponsesClient,AntigravityAdapter} from '../../.local/dsh-task02/gateway-agent-subscription/subscription/lib/index.js';

// Deployed subscription code, in-memory credentials and transport only. No login/network.
const options={provider:'codex-chatgpt',model:'gpt-5.6-sol',reasoningEffort:'medium',
  sessionId:'gateway-subscription-offline',messages:[],tools:[],signal:new AbortController().signal};
for(const status of [401,404,429,500])test(`Sol ${status} produces one request without refresh resend or model substitution`,async()=>{
  const sent=[],refresh=[];
  const oauth={credentials:async(force)=>{refresh.push(force);return {accessToken:'test-not-secret',refreshToken:'test-not-secret',expiresAt:Date.now()+3600000};}};
  const client=new ResponsesClient(oauth,undefined,{fetchFn:async(url,init)=>{
    sent.push(JSON.parse(init.body));return new Response(JSON.stringify({error:{message:'offline failure'}}),{status});
  }});
  await assert.rejects(async()=>{for await(const _ of client.stream(options)){};});
  assert.equal(sent.length,1);assert.equal(sent[0].model,'gpt-5.6-sol');
  assert.equal(sent[0].reasoning.effort,'medium');assert.equal(refresh.length,1);assert.notEqual(refresh[0],true);
});
for(const status of [404,429,500,'network'])test(`Gemini ${status} produces one request without endpoint retry or version substitution`,async()=>{
  const sent=[];
  const store={read:async()=>({access:'test-not-secret',expires:Date.now()+3600000,projectId:'offline-project'})};
  const settings={read:async()=>({enabledModelIds:['gemini-3.8-flash'],catalogModels:[]})};
  const adapter=new AntigravityAdapter(store,settings,undefined,{fetchFn:async(url,init)=>{
    sent.push(JSON.parse(init.body));if(status==='network')throw new Error('offline network failure');
    return new Response('offline failure',{status});
  }});
  await assert.rejects(async()=>{for await(const _ of adapter.stream({...options,provider:'antigravity',model:'gemini-3.8-flash',reasoningEffort:'high'})){};});
  assert.equal(sent.length,1);assert.equal(sent[0].model,'gemini-3.8-flash-tiered');
  assert.equal(sent[0].request.generationConfig.thinkingConfig.thinkingLevel,'HIGH');
});
