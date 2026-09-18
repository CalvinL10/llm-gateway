import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { TaskLedger, taskOwner } from './ledger.js';
import { assertExecutionSafety, apply as restrict, allowedTools, developmentRootTools, developmentChildTools, toolsFor } from './tools.js';

const policy = {root:{provider:'a',model:'planner'}, allowedRoutes:[{provider:'a',model:'planner'},{provider:'b',model:'worker'}], maxCalls:2};
const facts = {sessionId:'child',parentSessionId:'parent',provider:'b',model:'worker',purpose:null};
function setup() {
  const data = new Map();
  const table = {get:id=>data.get(id), entries:()=>data.entries(), put:async(id,value)=>{data.set(id,structuredClone(value));}};
  return {ledger:new TaskLedger(table), table};
}
async function task(ledger, p=policy) { return (await ledger.create({requestId:randomUUID(),goal:'goal\\n  preserve spaces'},p)).task; }

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
});
test('failed persistence cannot issue an admission receipt', async () => {
  const {ledger,table}=setup(), t=await task(ledger);
  table.put=async()=>{throw new Error('disk unavailable');};
  await assert.rejects(ledger.admit(t.id,facts),/disk unavailable/);
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
  const check=(names,sandbox='read-only',approval='ask',origin,source,toolSet='delegation')=>assertExecutionSafety({agentPresets:{serviceFor:()=>({schemas:()=>names.map(name=>({name}))})},
    sessionProjections:{stateOf:()=>({sandbox,approval})}},{session:{header:{origin},snapshotEvents:()=>[{type:'approval/policy',data:{source}}]}},{toolSet});
  check(allowedTools);
  assert.throws(()=>check([...allowedTools,'shell']));
  assert.throws(()=>check(allowedTools,'workspace-write'));
  assert.throws(()=>check(allowedTools,'read-only','never'));
  check(allowedTools,'read-only','never','subagent','delegation');
  check(developmentRootTools,'workspace-write','ask',undefined,undefined,'development');
  check(developmentChildTools,'read-only','never','subagent','delegation','development');
  assert.throws(()=>check(allowedTools,'read-only','ask','subagent','delegation'));
  assert.throws(()=>check(allowedTools,'read-only','never','subagent'));
});


test('development scope narrows child sandbox and capabilities without changing root approval', () => {
  let created, guard;
  restrict({tools: {guard: fn => guard = fn}, on: (event, fn) => {created = fn;}}, {mode: 'development'});
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
  assert.equal(guard({name: 'read', agent: {session: {header: {origin: 'subagent'}}}}), undefined);
});
