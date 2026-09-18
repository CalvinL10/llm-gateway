import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Workflow, validateInput, promptFor, stageResult } from './workflow.js';
import { dshRunner } from './runner.js';
import { apply as textOnly } from '../dsh-text-only/index.js';
const root = fileURLToPath(new URL('../../', import.meta.url));
const requireRuntime = createRequire(resolve(root, '.local/dsh-task02/package.json'));
const load = name => import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/'+name)));
const { Context } = await load('cordis');
const { LlmAdapter } = await load('dsh-llm');
const { z } = requireRuntime('zod');
const connections = [{id:'a',label:'Local A',provider:'stub-a'}, {id:'b',label:'Local B',provider:'stub-b'}];
const catalog = async () => ({routableProviders:['stub-a','stub-b'], groups:connections.map(c=>({id:c.provider,models:[{id:'local'}]}))});
const input = () => ({question:'请审阅示例\n', materials:['if ok:\n  print("first")\n','\tsecond\r\n'],constraints:'  只返回文本\n',
  generation:{connectionId:'a',model:'local',reasoningEffort:''}, review:{connectionId:'b',model:'local',reasoningEffort:''}});
async function storage(path) {
  const ctx = new Context();
  await ctx.plugin((await load('dsh-storage')).default ?? await load('dsh-storage'));
  await ctx.plugin(await load('dsh-storage-json'), {root:path});
  await ctx.plugin(await load('dsh-storage-domain'), {backend:'json'});
  const domain = await ctx.storageDomain.open({name:'workflow_test',version:1,tables:{tasks:{valueSchema:z.object({id:z.string()}).passthrough()}}});
  return {table:domain.table('tasks'), close:async()=>{await domain.close(); await ctx.fiber.dispose();}};
}
async function harness({reviewFailure=false, pauseReview} = {}) {
  const ctx = new Context(), calls=[], handles=[];
  for (const [name, config] of [['dsh-session',{}],['dsh-session-projection',{}],['dsh-llm',{}],
    ['dsh-system-prompt',{includeHarnessIdentity:false,includeRuntimeContext:false}],['dsh-tools',{}],['dsh-agent',{}],
    ['dsh-session-title',{fallbackMaxWords:5,fallbackMaxBytes:40,maxTitleBytes:80}],['dsh-agent-loop',{agents:[]}]]) await ctx.plugin((await load(name)).default,config);
  class Stub extends LlmAdapter {
    constructor(provider) {super(); this.provider=provider;}
    async *stream(options) {
      calls.push({provider:this.provider,options});
      if (this.provider==='stub-b') {if(pauseReview) await pauseReview; if(reviewFailure) throw Error('local review failure');}
      const text=this.provider==='stub-a'?'原案\n  保留缩进':'审阅：原案可改进';
      yield {type:'block-start',index:0,blockType:'text'};
      yield {type:'text-delta',index:0,text};
      yield {type:'block-end',index:0,block:{type:'text',text}};
      yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  for (const provider of ['stub-a','stub-b']) ctx.llm.registerAdapter([provider],new Stub(provider));
  const agents=new Map();
  return {ctx,calls,agents,close:async()=>{for(const h of handles)await h.dispose();await ctx.fiber.dispose();},
    // Use public agent factory per selection, then consume actual DSH events and loop terminal state.
    runner: async(stage,content,role)=>{
      const h=await ctx.agents.create({sessionId:stage.sessionId,agentOptions:{provider:stage.selection.provider,model:stage.selection.model},setup:agentCtx=>textOnly(agentCtx)});
      handles.push(h); agents.set(stage.sessionId,h.agent);
      ctx.sessionTitle.rename(h.agent.session,role);
      h.agent.followup({content,source:{kind:'user'}}); await h.agent.whenIdle();
      const events=h.agent.session.snapshotEvents();
      return stageResult(events);
    }};
}
async function settle(flow) {await Promise.all([...flow.pending]);}

test('input keeps exact whitespace/material order; attachments and implicit route rejected',()=>{
  const v=validateInput(input(),connections); assert.deepEqual(v.materials,input().materials);
  const prompt=promptFor(v,'draft'); assert.equal(prompt[4].text,input().materials[0]); assert.equal(prompt[6].text,input().materials[1]);
  assert.throws(()=>validateInput({...input(),attachments:[]},connections));
  assert.throws(()=>validateInput({...input(),generation:{...input().generation,provider:'another'}},connections));
});
test('actual DSH loops + host JSON storage: separate sessions, full review context, durable decision, read never calls', async()=>{
  const path=await mkdtemp(resolve(tmpdir(),'gateway03-')), db=await storage(path), h=await harness();
  const flow=new Workflow(db.table,h.runner,connections,catalog);
  let id;
  try {
    id=(await flow.create(input())).id; await settle(flow);
    const task=flow.get(id); assert.equal(task.status,'awaiting-decision');
    assert.notEqual(task.stages.generation.sessionId,task.stages.review.sessionId);
    const review=h.agents.get(task.stages.review.sessionId).session.snapshotEvents().find(e=>e.type==='user/message');
    for(const value of [input().question,...input().materials,input().constraints,task.stages.generation.artifact])
      assert.ok(review.data.content.some(b=>b.text===value));
    assert.equal(h.calls.length,2); assert.deepEqual(h.calls.map(c=>c.provider),['stub-a','stub-b']);
    assert.ok(h.calls.every(c=>(c.options.tools??[]).length===0));
    await flow.decide(id,{choice:'accept',note:'人工决定'}); flow.list(); flow.get(id); flow.get(id);
    assert.equal(h.calls.length,2); assert.equal(task.stages.generation.auxiliaryTitleAttempts,0);
    assert.equal(task.stages.review.usage[0].usage,null);
  } finally {await h.close();await db.close();}
  const reopened=await storage(path);
  try {const restored=new Workflow(reopened.table,()=>assert.fail('read must not execute'),connections,catalog);
    await restored.initialize(); assert.equal(restored.get(id).decision.choice,'accept'); assert.equal(restored.get(id).stages.review.artifact,'审阅：原案可改进');
  } finally {await reopened.close();}
});
test('draft is durable and queryable during review; review failure retains draft',async()=>{
  const gate=Promise.withResolvers(), db=await storage(await mkdtemp(resolve(tmpdir(),'gateway03-'))), h=await harness({reviewFailure:true,pauseReview:gate.promise});
  const flow=new Workflow(db.table,h.runner,connections,catalog);
  try {const {id}=await flow.create(input());
    while(h.calls.length<2 && flow.get(id).status==='running') await new Promise(r=>setImmediate(r));
    assert.equal(flow.get(id).stages.generation.artifact,'原案\n  保留缩进');
    assert.equal(flow.get(id).stages.review.status,'running');
    gate.resolve();await settle(flow);
    assert.equal(flow.get(id).stages.review.status,'failed'); assert.equal(flow.get(id).stages.generation.status,'completed');
    await flow.decide(id,{choice:'defer',note:'审阅失败，保留原案'}); assert.equal(h.calls.length,2);
  }finally{gate.resolve();await settle(flow);await h.close();await db.close();}
});
test('production runner refuses unsafe permission/tools before prompt; exact selections enforced',async()=>{
  let prompted=0, permission={sandbox:'workspace-write',approval:'ask'};
  const agent={session:{snapshotEvents:()=>[]},whenIdle:async()=>{}};
  const ctx={sessionController:{create:async r=>r,resolveAgent:async()=>({agent}),rename:async()=>{},selectModel:async r=>({selected:r}),prompt:async()=>{prompted++;}},
    agentPresets:{serviceFor:()=>({schemas:()=>[]})},sessionProjections:{stateOf:()=>permission}};
  const run=dshRunner(ctx,root), stage={sessionId:'local',selection:{provider:'stub-a',model:'local',reasoningEffort:''}};
  assert.equal((await run(stage,[],'generation')).status,'failed');assert.equal(prompted,0);
  permission={sandbox:'read-only',approval:'ask'};
  ctx.agentPresets.serviceFor=()=>({schemas:()=>[{name:'shell'}]});assert.equal((await run(stage,[],'generation')).status,'failed');assert.equal(prompted,0);
  ctx.agentPresets.serviceFor=()=>({schemas:()=>[]});await run(stage,[],'generation');assert.equal(prompted,1);
  permission={sandbox:'read-only',approval:'never'};assert.equal((await run(stage,[],'generation')).status,'failed');assert.equal(prompted,1);
  permission={sandbox:'read-only',approval:'ask'};
  ctx.sessionController.selectModel=async r=>({selected:{...r,provider:'different'}});
  assert.equal((await run(stage,[],'generation')).status,'failed');assert.equal(prompted,1);
  ctx.sessionController.create=async r=>({...r,agentPreset:'unsafe'});
  assert.equal((await run(stage,[],'generation')).status,'failed');assert.equal(prompted,1);
});
test('unknown prior active work is query-only after reopening; no replay',async()=>{
  const db=await storage(await mkdtemp(resolve(tmpdir(),'gateway03-')));
  try {await db.table.put('prior',{id:'prior',status:'running',stages:{generation:{status:'completed',artifact:'keep'},review:{status:'running'}}});
    const flow=new Workflow(db.table,()=>assert.fail('no replay'),connections,catalog);await flow.initialize();
    assert.equal(flow.get('prior').status,'unknown');assert.equal(flow.get('prior').stages.generation.artifact,'keep');assert.equal(flow.get('prior').stages.review.status,'unknown');
  }finally{await db.close();}
});

test('concurrent UUID admission survives storage reopen; mismatched payload is rejected without execution',async()=>{
  const path=await mkdtemp(resolve(tmpdir(),'gateway04-')), db=await storage(path);
  const requestId='aa001100-0000-4000-8000-000000000001';let calls=0;
  const run=async()=>{calls++;return {status:'completed',artifact:'durable'};};
  try {
    const flow=new Workflow(db.table,run,connections,catalog);
    const rows=await Promise.all(Array.from({length:8},()=>flow.create({...input(),requestId})));
    await settle(flow);assert.equal(calls,2);assert.ok(rows.every(t=>t.id===requestId));
    await assert.rejects(flow.create({...input(),requestId,question:'changed'}));assert.equal(calls,2);
  }finally{await db.close();}
  const reopened=await storage(path);
  try {
    const flow=new Workflow(reopened.table,()=>assert.fail('duplicate never runs'),connections,()=>assert.fail('duplicate needs no live catalog'));
    await flow.initialize();assert.equal((await flow.create({...input(),requestId})).id,requestId);
  }finally{await reopened.close();}
});

test('pre-admission cancellation and cancellation during async admission cannot leave queued work',async()=>{
  const stage={sessionId:'local',selection:{provider:'stub-a',model:'local',reasoningEffort:''}};
  for(const phase of ['prepare','admission']) {
    const entered=Promise.withResolvers(),release=Promise.withResolvers(),control=new AbortController();
    let prompted=0,queued=false,cancels=0;
    const agent={session:{snapshotEvents:()=>[]},whenIdle:async()=>assert.equal(queued,false),
      cancel:(_reason,options)=>{assert.equal(options.keepInbox,false);queued=false;cancels++;}};
    const ctx={sessionController:{create:async r=>{if(phase==='prepare'){entered.resolve();await release.promise;}return r;},
      resolveAgent:async()=>({agent}),rename:async()=>{},selectModel:async r=>({selected:r}),
      prompt:async()=>{prompted++;entered.resolve();await release.promise;queued=true;}},
      agentPresets:{serviceFor:()=>({schemas:()=>[]})},sessionProjections:{stateOf:()=>({sandbox:'read-only',approval:'ask'})}};
    const run=dshRunner(ctx,root)(stage,[],'generation',control.signal);
    await entered.promise;control.abort();release.resolve();
    assert.equal((await run).status,'stopped');assert.equal(queued,false);
    assert.equal(prompted,phase==='prepare'?0:1);if(phase==='admission')assert.equal(cancels,2);
  }
});

test('cancel between stages blocks review; storage failure after draft blocks review too',async()=>{
  for(const failStorage of [false,true]) {
    const db=await storage(await mkdtemp(resolve(tmpdir(),'gateway04-'))), entered=Promise.withResolvers(),release=Promise.withResolvers();
    let calls=0;
    const table={entries:()=>db.table.entries(),get:id=>db.table.get(id),put:(...args)=>db.table.put(...args),
      update:async(id,fn)=>{const value=fn(db.table.get(id));
        if(failStorage && value.stages.generation.status==='completed')throw Error('local disk failure');
        return db.table.update(id,()=>value);}};
    const flow=new Workflow(table,async()=>{calls++;entered.resolve();await release.promise;return {status:'completed',artifact:'draft'};},connections,catalog);
    try {
      const {id}=await flow.create(input());await entered.promise;
      if(!failStorage)await flow.cancel(id);
      release.resolve();await settle(flow);assert.equal(calls,1);
      assert.equal(flow.get(id).status,failStorage?'unknown':'stopped');
      assert.equal(flow.get(id).stages.review.status,'pending');
      if(!failStorage)assert.equal(flow.get(id).stages.generation.artifact,'draft');
      else {assert.ok(flow.lastPersistenceError);assert.equal(flow.get(id).stages.generation.status,'unknown');}
    }finally{release.resolve();await settle(flow);await db.close();}
  }
});

test('unknown result has no retry; failed retry preserves original route and refuses changed configuration',async()=>{
  const db=await storage(await mkdtemp(resolve(tmpdir(),'gateway04-')));
  try {
    const configured=structuredClone(connections);let calls=0;
    const flow=new Workflow(db.table,async()=>{calls++;return {status:'failed',artifact:'partial'};},configured,catalog);
    const {id}=await flow.create(input());await settle(flow);
    const sessionId=flow.get(id).stages.generation.sessionId;
    configured[0].provider='stub-b';await assert.rejects(flow.retry(id,{role:'generation',sessionId}));assert.equal(calls,1);
    configured[0].provider='stub-a';
    await db.table.update(id,t=>({...t,status:'unknown',stages:{...t.stages,generation:{...t.stages.generation,status:'unknown'}}}));
    await assert.rejects(flow.retry(id,{role:'generation',sessionId}));assert.equal(calls,1);
    assert.equal(stageResult([]).status,'unknown');
  }finally{await db.close();}
});

test('graceful shutdown cancels running work, keeps draft, and never starts a new stage',async()=>{
  const db=await storage(await mkdtemp(resolve(tmpdir(),'gateway04-'))),entered=Promise.withResolvers();let calls=0;
  const flow=new Workflow(db.table,async(_stage,_content,_role,signal)=>{
    calls++;entered.resolve();await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});
    return {status:'stopped',artifact:'partial'};
  },connections,catalog);
  try {const {id}=await flow.create(input());await entered.promise;await flow.drain();
    assert.equal(flow.get(id).status,'stopped');assert.equal(flow.get(id).stages.review.status,'pending');assert.equal(calls,1);
    await assert.rejects(flow.create(input()));
  }finally{await db.close();}
});
