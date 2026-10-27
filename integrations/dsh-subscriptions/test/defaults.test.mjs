import assert from 'node:assert/strict';
import test from 'node:test';
import {childDefaults,configuredChildRoutes} from '../src/preset-defaults.js';
import {apply} from '../src/defaults.js';

const preset={id:'standard',plugins:[{id:'group',name:'group',config:[
  {id:'spawn',name:'@deepseek-ai/dsh-tool-subagent',config:{provider:'spawn',modelSelectionSettings:true,maxDepth:2,agentOptions:{maxTokens:2048}}},
  {id:'fork',name:'@deepseek-ai/dsh-tool-subagent',config:{provider:'fork',agentOptions:{provider:'existing',model:'fork-model'}}},
  {id:'files',name:'@deepseek-ai/dsh-tool-fs',config:{permission:'ask'}},
]}]};

test('native spawn defaults preserve permission, depth, fork and non-delegation configuration',()=>{
  const before=structuredClone(preset),route={provider:'api-channel',model:'custom-model'};
  const next=childDefaults(preset,route);
  assert.equal(next.count,1); assert.deepEqual(preset,before);
  assert.deepEqual(configuredChildRoutes(next.config),[route]);
  const rows=next.config.plugins[0].config;
  assert.equal(rows[0].config.maxDepth,2);assert.equal(rows[0].config.agentOptions.maxTokens,2048);
  assert.equal(rows[0].config.modelSelectionSettings,true);
  assert.deepEqual(rows.slice(1),before.plugins[0].config.slice(1));
  assert.deepEqual(childDefaults(next.config,null).config,before);
});

function context() {
  let handler;
  const calls=[];
  const entries=[{options:{id:'preset-standard',name:'@deepseek-ai/dsh-agent-preset',config:structuredClone(preset)}},
    {options:{id:'native-selection',name:'@deepseek-ai/dsh-tool-subagent/model-selection-settings',config:{enabled:false,allowedModels:[]}}},
    {options:{id:'preset-gateway',name:'@deepseek-ai/dsh-agent-preset',config:{...structuredClone(preset),id:'llm-gateway-delegate'}}}];
  const groups=['deepseek-official','api-channel','codex-chatgpt','antigravity','claude-subscription'].map(id=>({id,name:id,models:[{id:'model',name:'model'}]}));
  const ctx={connection:{fetch:{register(route){handler=route.fetch;}}},
    sessionController:{modelCatalog:async()=>({groups,failures:[]})},
    agentDefaultModel:{currentSelection:()=>({provider:'deepseek-official',model:'model'}),saveSelection:async value=>calls.push(value)},
    configEditor:{entries:()=>entries,edit:async(entry,change)=>{entry.options.config=change(entry.options.config);}},
    get:()=>({current:()=>entries[1].options.config})};
  apply(ctx);
  return {ctx,calls,entries,invoke:async body=>handler(new Request('http://localhost/api/gateway-model-defaults',body===undefined?{}:{method:'POST',body:JSON.stringify(body)}))};
}

test('all host channels remain selectable and saving a child does not overwrite the main or gateway tasks',async()=>{
  const {invoke,calls,entries}=context();
  const gatewayBefore=structuredClone(entries[2].options.config);
  for (const provider of ['deepseek-official','api-channel','codex-chatgpt','antigravity','claude-subscription']) {
    const response=await invoke({child:{provider,model:'model'}});
    assert.equal(response.status,200,await response.clone().text());
    assert.deepEqual(configuredChildRoutes(entries[0].options.config),[{provider,model:'model'}]);
  }
  assert.deepEqual(calls,[]);assert.deepEqual(entries[2].options.config,gatewayBefore);
  const state=await (await invoke()).json();assert.equal(state.catalog.groups.length,5);
});

test('invalid routes and unexpected fields do not edit native configuration',async()=>{
  const {invoke,entries,calls}=context();const before=structuredClone(entries);
  for(const value of [{child:{provider:'missing',model:'model'}},{main:{provider:'api-channel',model:'model'},extra:true},
    {childSelection:{enabled:true,allowedModels:[]}}]) assert.equal((await invoke(value)).status,400);
  assert.deepEqual(entries,before);assert.deepEqual(calls,[]);
});

test('user-selected native allowlist may contain subscription, DeepSeek and API routes together',async()=>{
  const {invoke,entries}=context();
  const allowedModels=['api-channel','deepseek-official','claude-subscription'].map(provider=>({provider,model:'model'}));
  assert.equal((await invoke({childSelection:{enabled:true,allowedModels}})).status,200);
  assert.deepEqual(entries[1].options.config,{enabled:true,allowedModels});
});
