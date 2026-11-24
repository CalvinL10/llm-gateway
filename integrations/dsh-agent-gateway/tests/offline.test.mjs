import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { TaskLedger, taskOwner } from '../ledger.js';
import { assertExecutionSafety, apply as restrict, allowedTools, delegationTools, developmentRootTools, developmentChildTools,
  reconciliationTools, toolsFor, modelVisibleToolsFor, enterReconciliation, commandExecutionCapability } from '../tools.js';

const policy = {root:{provider:'a',model:'planner'}, allowedRoutes:[{provider:'a',model:'planner'},{provider:'b',model:'worker'}], maxCalls:2};
const facts = {sessionId:'child',parentSessionId:'parent',provider:'b',model:'worker',purpose:null};
function setup() {
  const data = new Map();
  const table = {get:id=>data.get(id), entries:()=>data.entries(), put:async(id,value)=>{data.set(id,structuredClone(value));}};
  return {ledger:new TaskLedger(table), table};
}
async function task(ledger, p=policy) {
  const {task} = await ledger.create({requestId:randomUUID(),goal:'goal\\n  preserve spaces'},p);
  return (await ledger.startAttempt(task.id, task.attempts[0].id)).task;
}

test('queued attempts are durable, non-dispatchable, cancellable without calls, and fail closed after restart', async () => {
  const {ledger, table} = setup();
  const {task: queued} = await ledger.create({requestId:randomUUID(), goal:'queued fact'}, policy);
  assert.equal(queued.status, 'queued');
  assert.ok(queued.attempts[0].queuedAt);
  assert.equal(queued.attempts[0].startedAt, null);
  await assert.rejects(ledger.admit(queued.id, {...facts, sessionId:queued.sessionId}), {code:'TASK_NOT_RUNNING'});
  assert.equal(ledger.get(queued.id).calls.length, 0);

  const started = await ledger.startAttempt(queued.id, queued.attempts[0].id);
  assert.equal(started.task.status, 'running');
  assert.ok(started.attempt.startedAt);
  assert.equal((await ledger.admit(queued.id, {...facts, sessionId:queued.sessionId})).attemptId, queued.id);

  const {task: cancelled} = await ledger.create({requestId:randomUUID(), goal:'cancel before dispatch'}, policy);
  const result = await ledger.cancel(cancelled.id);
  assert.equal(result.previousStatus, 'queued');
  assert.equal(result.task.status, 'stopped');
  assert.equal(result.task.calls.length, 0);
  assert.equal(result.task.attempts[0].startedAt, null);
  assert.equal(result.task.attempts[0].callEnd, 0);

  const {task: abandoned} = await ledger.create({requestId:randomUUID(), goal:'restart while queued'}, policy);
  const restarted = new TaskLedger(table);
  await restarted.recover();
  assert.equal(restarted.get(abandoned.id).status, 'unknown');
  assert.equal(restarted.get(abandoned.id).attempts[0].status, 'unknown');
  assert.equal(restarted.get(abandoned.id).attempts[0].startedAt, null);
});
test('single-agent policy denies all descendants, including auxiliary calls on an allowed root route', async () => {
  const {ledger}=setup(), t=await task(ledger,{...policy,toolSet:'development',delegationEnabled:false});
  const rootFacts={...facts,provider:'a',model:'planner',sessionId:t.sessionId,parentSessionId:null};
  await ledger.admit(t.id,rootFacts);
  for (const purpose of [null,'compaction'])
    await assert.rejects(ledger.admit(t.id,{...rootFacts,sessionId:'unexpected-child',parentSessionId:t.sessionId,purpose}),
      {code:'DELEGATION_DISABLED'});
  assert.equal(ledger.get(t.id).calls.length,1);
  assert.equal(ledger.get(t.id).denials.length,2);
});

test('single-agent tool restriction hides delegation and denies forged child/tool execution without weakening permissions', () => {
  const business=['read','glob','grep','write','edit','pwsh'];
  assert.deepEqual(toolsFor('development',undefined,false,false),business);
  assert.deepEqual(modelVisibleToolsFor('development',undefined,true,false),reconciliationTools);
  let guard;
  restrict({tools:{guard:fn=>guard=fn},on:()=>{}}, {mode:'development',delegationEnabled:false});
  for (const name of delegationTools) assert.match(guard({name,agent:{session:{header:{}}}}),/not permitted/);
  assert.match(guard({name:'read',agent:{session:{header:{origin:'subagent'}}}}),/not permitted/);
  const ctx={agentPresets:{serviceFor:()=>({schemas:()=>business.map(name=>({name}))})},
    sessionProjections:{stateOf:()=>({sandbox:'workspace-write',approval:'ask'})}};
  const agent={session:{header:{},snapshotEvents:()=>[]}}, p={toolSet:'development',delegationEnabled:false};
  assert.doesNotThrow(()=>assertExecutionSafety(ctx,agent,p));
  ctx.sessionProjections.stateOf=()=>({sandbox:'workspace-write',approval:'never'});
  assert.throws(()=>assertExecutionSafety(ctx,agent,p),/approval policies/);
  ctx.sessionProjections.stateOf=()=>({sandbox:'workspace-write',approval:'ask'});
  ctx.agentPresets.serviceFor=()=>({schemas:()=>[...business,'subagent'].map(name=>({name}))});
  assert.throws(()=>assertExecutionSafety(ctx,agent,p),/configured tool set/);
  assert.throws(()=>restrict({},{mode:'delegation',delegationEnabled:false}),/requires development/);
});

test('concurrent descendants share one durable admission limit; failed calls are not refunded', async () => {
  const {ledger}=setup(), t=await task(ledger);
  const attempts=await Promise.allSettled(Array.from({length:8},(_,i)=>ledger.admit(t.id,{...facts,sessionId:'child-'+i})));
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,2);
  assert.equal(ledger.get(t.id).calls.length,2);
  assert.equal(ledger.get(t.id).denials.length,6);
  await ledger.finishCall(t.id,attempts[0].value.id,'error',null);
  await assert.rejects(ledger.admit(t.id,facts),{code:'TASK_CALL_LIMIT'});
  assert.equal(ledger.get(t.id).calls[0].usage,null);
});
test('effective dispatch route is checked even when a child inherits or omits model selection', async () => {
  const {ledger}=setup(), t=await task(ledger);
  await assert.rejects(ledger.admit(t.id,{...facts,provider:'not-authorized'}),{code:'ROUTE_NOT_AUTHORIZED'});
  assert.equal(ledger.get(t.id).calls.length,0);
  const call=await ledger.admit(t.id,{...facts,purpose:'compaction'});
  assert.equal(call.purpose,'compaction');
  assert.equal(ledger.get(t.id).calls.length,1);
});
test('cancel closes admissions; restart marks active work unknown without recreating it', async () => {
  const {ledger,table}=setup(), t=await task(ledger);
  await ledger.admit(t.id,facts); await ledger.cancel(t.id);
  await assert.rejects(ledger.admit(t.id,facts),{code:'TASK_NOT_RUNNING'});
  const restarted=new TaskLedger(table); await restarted.recover();
  assert.equal(restarted.get(t.id).status,'unknown');
  assert.equal(restarted.get(t.id).calls[0].outcome,'unknown');
  assert.equal((await restarted.create({requestId:t.id,goal:t.goal},policy)).created,false);
  await assert.rejects(restarted.admit(t.id,facts),{code:'TASK_NOT_RUNNING'});
});
test('same request ID is idempotent, conflicting input fails; task policy is detached', async () => {
  const {ledger}=setup(), input={requestId:randomUUID(),goal:'text'}, p=structuredClone(policy);
  const created=await Promise.all(Array.from({length:6},()=>ledger.create(input,p)));
  assert.equal(created.filter(t=>t.created).length,1);
  p.maxCalls=100; created[0].task.policy.maxCalls=100;
  assert.equal(ledger.get(input.requestId).policy.maxCalls,2);
  await assert.rejects(ledger.create({...input,goal:'other'},policy),{code:'REQUEST_ID_CONFLICT'});
  await assert.rejects(ledger.create({...input,workspaceId:'other-authorized-workspace'},policy),
    {code:'REQUEST_ID_CONFLICT'});
});
test('an explicit per-task call limit is immutable while omitted retries preserve historical policy', async () => {
  const {ledger}=setup(), requestId=randomUUID(), input={requestId,goal:'bounded',maxCalls:1};
  const first=await ledger.create(input,{...policy,maxCalls:1});
  assert.equal(first.task.policy.maxCalls,1);
  assert.equal((await ledger.create({requestId,goal:'bounded'},policy)).task.policy.maxCalls,1);
  await assert.rejects(ledger.create({...input,maxCalls:2},policy),{code:'REQUEST_ID_CONFLICT'});
  assert.equal(ledger.get(requestId).policy.maxCalls,1);
});
test('failed persistence cannot issue an admission receipt', async () => {
  const {ledger,table}=setup(), t=await task(ledger);
  table.put=async()=>{throw new Error('disk unavailable');};
  await assert.rejects(ledger.admit(t.id,facts), error => error.code === 'TASK_STORAGE_FAILED'
    && error.operation === 'admit' && error.cause?.message === 'disk unavailable');
  assert.equal(ledger.get(t.id).calls.length,0);
});

test('explicit child routes and reasoning are enforced at dispatch without changing legacy policies', async () => {
  const {ledger}=setup();
  const root={provider:'a',model:'planner',reasoningEffort:'medium'};
  const child={provider:'b',model:'worker',reasoningEffort:'high'};
  const t=await task(ledger,{root,allowedRoutes:[root,child],allowedChildRoutes:[child],maxCalls:8});
  await ledger.admit(t.id,{...facts,...root,sessionId:t.sessionId,parentSessionId:null});
  await assert.rejects(ledger.admit(t.id,{...facts,...root}),{code:'ROUTE_NOT_AUTHORIZED'});
  await assert.rejects(ledger.admit(t.id,{...facts,...child,reasoningEffort:'medium'}),{code:'REASONING_NOT_AUTHORIZED'});
  await assert.rejects(ledger.admit(t.id,{...facts,...child,reasoningEffort:undefined}),{code:'REASONING_NOT_AUTHORIZED'});
  await ledger.admit(t.id,{...facts,...child});
  assert.equal(ledger.get(t.id).calls.length,2);
});
test('host lineage includes grandchildren and isolates unrelated tasks; cycles fail closed', () => {
  const roots=new Map([['a','task-a'],['b','task-b']]);
  const headers={child:{origin:'subagent',parentSession:'a'},grandchild:{origin:'subagent',parentSession:'child'},
    cycle:{origin:'subagent',parentSession:'cycle'},fork:{parentSession:'a'}};
  assert.equal(taskOwner('grandchild',id=>headers[id],roots),'task-a');
  assert.equal(taskOwner('b',id=>headers[id],roots),'task-b');
  for(const id of ['unknown','cycle','fork',undefined]) assert.equal(taskOwner(id,i=>headers[i],roots),null);
});
test('development tool set is root-write and child-read-only by construction', () => {
  assert.deepEqual(toolsFor('delegation'), allowedTools);
  assert.deepEqual(toolsFor('development', undefined), developmentRootTools);
  assert.deepEqual(toolsFor('development', 'subagent'), developmentChildTools);
  assert.deepEqual(toolsFor('development', undefined, true), reconciliationTools);
  assert.deepEqual(modelVisibleToolsFor('development', undefined, true), [...reconciliationTools, ...delegationTools]);
  assert.ok(developmentRootTools.includes('write') && developmentRootTools.includes('edit') && developmentRootTools.includes('pwsh'));
  assert.ok(!developmentChildTools.includes('write') && !developmentChildTools.includes('edit') && !developmentChildTools.includes('pwsh'));
});

test('dynamic tool guard does not disable sandbox/approval checks', () => {
  let actual, guard, created;
  restrict({tools:{guard:value=>guard=value},on:(event, listener)=>{assert.equal(event,'agent/created');created=listener;}});
  assert.equal(actual, undefined);
  created({agent:{ctx:{tools:{restrict:value=>actual=value}},session:{header:{}}}});
  assert.deepEqual(actual, {allow:[]});
  for (const name of allowedTools) assert.equal(guard({name}),undefined);
  assert.ok(guard({name:'shell'}));
  const check=(names,sandbox='read-only',approval='ask',origin,source,toolSet='delegation',reconcile=false)=>assertExecutionSafety({agentPresets:{serviceFor:()=>({schemas:()=>names.map(name=>({name}))})},
    sessionProjections:{stateOf:()=>({sandbox,approval})}},{session:{header:{origin},snapshotEvents:()=>[{type:'approval/policy',data:{source}}]}},{toolSet},{reconcile});
  check(allowedTools);
  assert.throws(()=>check([...allowedTools,'shell']));
  assert.throws(()=>check(allowedTools,'workspace-write'));
  assert.throws(()=>check(allowedTools,'read-only','never'));
  check(allowedTools,'read-only','never','subagent','delegation');
  check(developmentRootTools,'workspace-write','ask',undefined,undefined,'development');
  check(developmentChildTools,'read-only','never','subagent','delegation','development');
  check([...reconciliationTools, ...delegationTools],'read-only','ask',undefined,undefined,'development',true);
  assert.throws(()=>check([...reconciliationTools, ...delegationTools, 'write'],'read-only','ask',undefined,undefined,'development',true));
  assert.throws(()=>check(allowedTools,'read-only','ask','subagent','delegation'));
  assert.throws(()=>check(allowedTools,'read-only','never','subagent'));
});


test('development scope narrows child sandbox and capabilities without changing root approval', () => {
  let created, guard;
  restrict({tools: {guard: fn => guard = fn}, on: (event, fn) => {created = fn;},
    sessionProjections: {stateOf: () => ({sandbox: 'read-only', approval: 'never'})}}, {mode: 'development'});
  const mount = origin => {
    const events = []; let filter;
    created({agent: {ctx: {tools: {restrict: value => {filter = value;}}}, session: {
      header: {origin}, append: (type, data) => events.push({type, data})
    }}});
    return {filter, events};
  };
  assert.deepEqual(mount(undefined), {filter: {allow: ['read','glob','grep','write','edit','pwsh']}, events: []});
  assert.deepEqual(mount('subagent'), {filter: {allow: ['read','glob','grep']},
    events: [{type: 'sandbox/mode', data: {mode: 'read-only'}}]});
  for (const name of ['write','edit','pwsh','read_image'])
    assert.ok(guard({name, agent: {session: {header: {origin: 'subagent'}}}}));
  assert.match(guard({name: 'read', agent: {session: {header: {origin: 'subagent'},
    snapshotEvents: () => [{type: 'approval/policy', data: {source: 'delegation'}}]}}}), /Gateway path denied/);
});

test('continuation admission is durable, idempotent and rejects conflicting or concurrent turns', async () => {
  const {ledger}=setup(), t=await task(ledger), continuationId=randomUUID();
  await ledger.finish(t.id, 'completed', 'first result');
  const input={continuationId, kind:'supplement', instruction:'also inspect the parser', additionalCalls:0};
  const attempts=await Promise.all(Array.from({length:6},()=>ledger.beginContinuation(t.id,input,[])));
  assert.equal(attempts.filter(value=>value.created).length,1);
  assert.equal(ledger.get(t.id).attempts.length,2);
  assert.equal(ledger.get(t.id).status,'queued');
  await assert.rejects(ledger.beginContinuation(t.id,{...input,instruction:'different'},[]),
    {code:'CONTINUATION_ID_CONFLICT'});
  await assert.rejects(ledger.beginContinuation(t.id,{...input,continuationId:randomUUID()},[]),
    {code:'TASK_ALREADY_RUNNING'});
});

test('continuation checks the latest execution inside the serialized edit after queued finalization', async () => {
  const {ledger}=setup(), t=await task(ledger);
  await ledger.finish(t.id,'completed','initial result');
  const repairId=randomUUID();
  await ledger.beginContinuation(t.id,{continuationId:repairId,kind:'continue',instruction:'repair',additionalCalls:0});
  const finishing=ledger.finish(t.id,'completed','repair result');
  let checked;
  const next=ledger.beginContinuation(t.id,{continuationId:randomUUID(),kind:'continue',instruction:'must not overlap',additionalCalls:0},[],
    latest=>{
      checked={id:latest.attempts.at(-1).id,status:latest.status};
      throw new Error('actual repair execution not yet confirmed');
    });
  await finishing;
  await assert.rejects(next,/actual repair execution not yet confirmed/);
  assert.deepEqual(checked,{id:repairId,status:'completed'});
  assert.equal(ledger.get(t.id).attempts.length,2);
  assert.equal(ledger.get(t.id).policy.maxCalls,policy.maxCalls);
});

test('read-only delegation retains its native tools, while only an active reconciliation denies delegation', () => {
  let guard, created;
  restrict({tools:{guard:fn=>guard=fn},on:(event,fn)=>{created=fn;},
    sessionProjections:{stateOf:()=>({sandbox:'read-only',approval:'ask'})}});
  const session={header:{}};
  const active=new Set();
  const scoped={restrict:filter=>{active.add(filter);return ()=>active.delete(filter);}};
  const agent={session,ctx:{tools:scoped}};
  created({agent});
  assert.deepEqual([...active].map(filter=>filter.allow),[[]]);
  const exec={name:'subagent',agent:{session}};
  assert.equal(guard(exec),undefined);
  const leave=enterReconciliation(agent);
  assert.deepEqual([...active].map(filter=>filter.allow),[reconciliationTools]);
  assert.match(guard(exec),/not permitted/);
  leave();
  assert.deepEqual([...active].map(filter=>filter.allow),[[]]);
  assert.equal(guard(exec),undefined);
});

test('continuation budget extends the cumulative limit without resetting calls or refunding failures', async () => {
  const {ledger}=setup(), t=await task(ledger,{...policy,maxCalls:1});
  const first=await ledger.admit(t.id,{...facts,sessionId:t.sessionId});
  await ledger.finishCall(t.id,first.id,'error',null);
  await assert.rejects(ledger.admit(t.id,{...facts,sessionId:t.sessionId}),{code:'TASK_CALL_LIMIT'});
  await ledger.finish(t.id,'failed',null,'MODEL_FAILED','wait-idle');
  await assert.rejects(ledger.beginContinuation(t.id,{continuationId:randomUUID(),kind:'continue',
    instruction:'continue',additionalCalls:0},[]),{code:'TASK_CALL_LIMIT'});
  await assert.rejects(ledger.beginContinuation(t.id,{continuationId:randomUUID(),kind:'continue',
    instruction:'continue',additionalCalls:2},[1]),{code:'CONTINUATION_CALL_LIMIT_NOT_AUTHORIZED'});
  const nextId=randomUUID();
  await ledger.beginContinuation(t.id,{continuationId:nextId,kind:'continue',
    instruction:'continue with two explicitly authorized calls',additionalCalls:2},[2]);
  assert.equal(ledger.get(t.id).policy.maxCalls,3);
  assert.equal(ledger.get(t.id).calls.length,1);
  await ledger.startAttempt(t.id, nextId);
  const second=await ledger.admit(t.id,{...facts,sessionId:t.sessionId});
  assert.equal(second.attemptId,nextId);
  await ledger.finishCall(t.id,second.id,'stop',{});
  await ledger.finish(t.id,'completed','continued result');
  const value=ledger.get(t.id);
  assert.equal(value.status,'completed');
  assert.equal(value.calls.length,2);
  assert.equal(value.attempts[0].status,'limited');
  assert.equal(value.attempts[1].budgetBefore,1);
  assert.equal(value.attempts[1].budgetAfter,3);
  assert.equal(value.attempts[1].callStart,1);
  assert.equal(value.attempts[1].callEnd,2);
});

test('restart unknown must be reconciled read-only before another execution continuation', async () => {
  const {ledger,table}=setup(), t=await task(ledger);
  const call=await ledger.admit(t.id,{...facts,sessionId:t.sessionId});
  const restarted=new TaskLedger(table); await restarted.recover();
  let value=restarted.get(t.id);
  assert.equal(value.status,'unknown');
  assert.equal(value.attempts[0].status,'unknown');
  assert.equal(value.calls.find(item=>item.id===call.id).outcome,'unknown');
  await assert.rejects(restarted.beginContinuation(t.id,{continuationId:randomUUID(),kind:'continue',
    instruction:'resume writes',additionalCalls:0},[]),{code:'RECONCILIATION_REQUIRED'});
  const reconcileId=randomUUID();
  await restarted.beginContinuation(t.id,{continuationId:reconcileId,kind:'reconcile',
    instruction:'inspect state only',additionalCalls:0},[]);
  await restarted.startAttempt(t.id, reconcileId);
  await restarted.finish(t.id,'completed','state reconciled');
  value=restarted.get(t.id);
  assert.equal(value.status,'reconciled');
  assert.equal(value.attempts.at(-1).kind,'reconcile');
  assert.equal(value.attempts.at(-1).artifact,'state reconciled');
  await assert.rejects(restarted.beginContinuation(t.id,{continuationId:randomUUID(),kind:'reconcile',
    instruction:'duplicate reconciliation',additionalCalls:0},[]),{code:'RECONCILE_NOT_REQUIRED'});
  await restarted.beginContinuation(t.id,{continuationId:randomUUID(),kind:'continue',
    instruction:'resume after review',additionalCalls:0},[]);
  assert.equal(restarted.get(t.id).attempts.length,3);
});

test('failed reconciliation preserves unknown and cannot unlock a write continuation', async () => {
  const {ledger,table}=setup(), initial=await task(ledger);
  await new TaskLedger(table).recover();
  const first=randomUUID();
  await ledger.beginContinuation(initial.id,{continuationId:first,kind:'reconcile',
    instruction:'review current state',additionalCalls:0});
  await ledger.finish(initial.id,'failed',null,'REVIEW_FAILED','check-tools');
  const value=ledger.get(initial.id);
  assert.equal(value.status,'unknown');
  assert.equal(value.attempts.at(-1).status,'failed');
  assert.equal(value.attempts.at(-1).failureCode,'REVIEW_FAILED');
  await assert.rejects(ledger.beginContinuation(initial.id,{continuationId:randomUUID(),kind:'continue',
    instruction:'replay command',additionalCalls:0}),{code:'RECONCILIATION_REQUIRED'});
  await ledger.beginContinuation(initial.id,{continuationId:randomUUID(),kind:'reconcile',
    instruction:'retry review with fresh evidence',additionalCalls:0});
  assert.equal(ledger.get(initial.id).attempts.length,3);
});

test('command capability reports only Docker executor support', () => {
  assert.equal(commandExecutionCapability({dockerExecutor:true}), 'enabled');
  assert.equal(commandExecutionCapability({dockerExecutor:false}), 'disabled');
  assert.equal(commandExecutionCapability(undefined), 'disabled');
});
