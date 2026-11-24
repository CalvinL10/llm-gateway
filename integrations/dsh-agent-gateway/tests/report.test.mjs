import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { TaskLedger } from '../ledger.js';
import { toolEvent, approvalEvent, commandResult, finalAssistantText, publicTask } from '../report.js';

const policy = {root: {provider: 'fixture', model: 'scripted'}, allowedRoutes: [{provider: 'fixture', model: 'scripted'}], maxCalls: 8};
async function setup() {
  const data = new Map(), table = {get: id => data.get(id), entries: () => data.entries(),
    put: async (id, t) => data.set(id, structuredClone(t))};
  const ledger = new TaskLedger(table);
  const {task: queued} = await ledger.create({requestId: randomUUID(), goal: 'synthetic'}, policy);
  const {task} = await ledger.startAttempt(queued.id, queued.attempts[0].id);
  return {ledger, task, table};
}
async function exhaust(ledger, task) {
  const facts = {...policy.root, sessionId: task.sessionId};
  for (let i = 0; i < 8; i++) {
    const call = await ledger.admit(task.id, facts);
    await ledger.finishCall(task.id, call.id, 'tool-calls', null);
  }
  await assert.rejects(ledger.admit(task.id, facts), {code: 'TASK_CALL_LIMIT'});
}

test('budget without effects, with edit and unfinished check, or tool failure never means completed', async () => {
  for (const scenario of ['none', 'edit', 'failure']) {
    const {ledger, task} = await setup(); await exhaust(ledger, task);
    if (scenario === 'edit') {
      await ledger.recordTool(task.id, {sessionId: task.sessionId, seq: 1, name: 'edit', outcome: 'succeeded', resultSeq: 2});
      await ledger.recordTool(task.id, {sessionId: task.sessionId, seq: 3, name: 'pwsh', outcome: 'pending'});
    }
    if (scenario === 'failure') await ledger.recordTool(task.id, {sessionId: task.sessionId, seq: 1, name: 'read', outcome: 'failed', errorCode: 'FS_NOT_FOUND'});
    await ledger.finish(task.id, 'completed', 'I claim everything passed');
    const value = publicTask(ledger.get(task.id));
    assert.equal(value.status, 'limited'); assert.equal(value.artifact, null);
    assert.equal(value.report.stopReason, 'TASK_CALL_LIMIT');
    assert.equal(value.report.businessOutcome, 'unverified');
    assert.equal(value.report.validation, 'not-established');
    assert.equal(value.report.needsUserDecision, true);
    assert.equal(value.report.toolOperations.length, scenario === 'edit' || scenario === 'failure' ? (scenario === 'edit' ? 2 : 1) : 0);
    assert.equal(value.report.confirmedFileChanges.length, scenario === 'edit' ? 1 : 0);
    assert.equal(value.report.unconfirmedOperations.length, scenario === 'edit' ? 1 : 0);
    assert.equal(value.report.failedOperations.length, scenario === 'failure' ? 1 : 0);
  }
});

test('normal completion at exactly eight calls is not a limit stop or business acceptance', async () => {
  const {ledger, task} = await setup();
  for (let i = 0; i < 8; i++) await ledger.admit(task.id, {...policy.root, sessionId: task.sessionId});
  await ledger.finish(task.id, 'completed', 'Final model answer');
  const result = publicTask(ledger.get(task.id));
  assert.equal(result.status, 'completed'); assert.equal(result.report.budget.remaining, 0);
  assert.equal(result.report.budget.limitDenied, false);
  assert.equal(result.report.businessOutcome, 'unverified');
});

test('cancel and restart unknown take precedence over budget denial; evidence and idempotency survive', async () => {
  for (const cancel of [true, false]) {
    const {ledger, task, table} = await setup(); await exhaust(ledger, task);
    await ledger.recordTool(task.id, {sessionId: task.sessionId, seq: 1, name: 'write', outcome: 'succeeded'});
    if (cancel) {await ledger.cancel(task.id); await ledger.finish(task.id, 'completed', 'not final');}
    else await new TaskLedger(table).recover();
    const result = publicTask(ledger.get(task.id));
    assert.equal(result.status, cancel ? 'stopped' : 'unknown');
    assert.equal(result.report.confirmedFileChanges.length, 1);
    assert.equal(result.artifact, null);
    assert.equal((await ledger.create({requestId: task.id, goal: task.goal}, policy)).created, false);
    await assert.rejects(ledger.admit(task.id, {...policy.root, sessionId: task.sessionId}), {code: 'TASK_NOT_RUNNING'});
  }
});

test('safe projections keep linked host timing but no arbitrary error, arguments, meta or content escapes', () => {
  const secret = 'SYNTHETIC_PRIVATE_TOKEN_COOKIE_COMMAND_FILE';
  const call = {type: 'tool/call', seq: 1, time: 1000,
    data: {callId: 'c', name: 'edit', arguments: secret, turn:2, step:3}};
  const event = {type: 'tool/result', seq: 2, time: 2000, sourceEventSeqs: [1], data: {error: {code: secret, message: secret},
    meta: {privateFile: secret}, message: {content: [{type: 'tool-result', toolCallId: 'c', isError: true, content: [{text: secret}]}]}}};
  const operation = toolEvent('root', event, [call, event]);
  assert.equal(operation.outcome, 'failed'); assert.equal(operation.errorCode, 'TOOL_FAILED');
  assert.deepEqual({turn:operation.turn, step:operation.step, startedAt:operation.startedAt, endedAt:operation.endedAt},
    {turn:2, step:3, startedAt:'1970-01-01T00:00:01.000Z', endedAt:'1970-01-01T00:00:02.000Z'});
  assert.ok(!JSON.stringify(operation).includes(secret));
  const invalidTime = toolEvent('root', {...event, time:Number.MAX_VALUE},
    [{...call, time:Number.MAX_VALUE}]);
  assert.equal(invalidTime.startedAt, undefined);
  assert.equal(invalidTime.endedAt, undefined);
  assert.equal(toolEvent('root', {...event, sourceEventSeqs: [9]}, [call]), null);
  event.data.message.content[0].isError = false;
  assert.equal(toolEvent('root', event, [call]).outcome, 'succeeded');
  call.data.name = 'pwsh';
  assert.equal(toolEvent('root', event, [call]).outcome, undefined);
  assert.equal(commandResult({kind: 'foreground', exitCode: 7}).outcome, 'failed');
  assert.equal(commandResult({kind: 'foreground', exitCode: 0, timedOut: true}).outcome, 'failed');
  assert.equal(commandResult({kind: 'foreground', exitCode: 0, sandbox: {denied: true}}).outcome, 'failed');
  assert.equal(commandResult({kind: 'background'}).outcome, 'unknown');
});

test('public task projection redacts attempt instructions while retaining audit metadata', async () => {
  const {task} = await setup();
  const secret = 'TEST_ONLY_ATTEMPT_INSTRUCTION';
  task.attempts[0].instruction = secret;
  const value = publicTask(task);
  assert.equal(value.attempts, undefined);
  assert.equal(value.report.attempts[0].id, task.id);
  assert.equal(value.report.attempts[0].kind, 'initial');
  assert.doesNotMatch(JSON.stringify(value), new RegExp(secret));
});

test('approval audit projection is one-shot, linked and excludes reasons, arguments and request ids', async () => {
  const secret = 'TEST_ONLY_PRIVATE_APPROVAL_DETAIL';
  const asked = {type:'approval/asked', seq:7, data:{id:'approval-private-id', toolName:'write',
    callId:'private-call-id', reason:secret}};
  const decided = {type:'approval/decided', seq:8, data:{id:'approval-private-id', outcome:'allowed-once'}};
  const pending = approvalEvent('root', asked, [asked]);
  const allowed = approvalEvent('root', decided, [asked, decided]);
  assert.deepEqual(pending, {sessionId:'root',seq:7,name:'write',outcome:'pending'});
  assert.deepEqual(allowed, {sessionId:'root',seq:7,name:'write',decisionSeq:8,outcome:'allowed-once'});
  assert.ok(!JSON.stringify([pending,allowed]).includes(secret));
  assert.equal(approvalEvent('root', {...decided,data:{...decided.data,id:'unlinked'}}, [asked]), null);

  const {ledger, task} = await setup();
  await ledger.recordApproval(task.id, pending); await ledger.recordApproval(task.id, allowed);
  const report = publicTask(ledger.get(task.id)).report;
  assert.deepEqual(report.approvalCounts, {pending:0,allowedOnce:1,rejected:0,cancelledOrUnavailable:0});
  assert.deepEqual(report.approvalOperations, [{...allowed, attemptId:task.id}]);
});

test('allowed-once approval remains scoped to its attempt and is never evidence for a continuation action', async () => {
  const {ledger, task} = await setup();
  const firstApproval = {sessionId:task.sessionId, seq:11, name:'write', decisionSeq:12, outcome:'allowed-once'};
  await ledger.recordApproval(task.id, firstApproval);
  await ledger.finish(task.id, 'completed', 'initial finished');

  const continuationId = randomUUID();
  await ledger.beginContinuation(task.id, {continuationId, kind:'continue',
    instruction:'perform a new approval-requiring action', additionalCalls:0}, []);
  const secondApproval = {sessionId:task.sessionId, seq:21, name:'write', decisionSeq:22, outcome:'allowed-once'};
  await ledger.recordApproval(task.id, secondApproval);
  const report = publicTask(ledger.get(task.id)).report;

  assert.deepEqual(report.approvalOperations, [
    {...firstApproval, attemptId:task.id},
    {...secondApproval, attemptId:continuationId}
  ]);
  assert.equal(report.approvalCounts.allowedOnce, 2);
  assert.deepEqual(report.approvalOperations.filter(value => value.attemptId === continuationId),
    [{...secondApproval, attemptId:continuationId}]);
});

test('only final text of completed turn is an artifact; legacy partial records remain visibly unverified', async () => {
  const message = (seq, content) => ({type: 'assistant/message', seq, data: {turn: 1, message: {content}}});
  const events = [message(1, [{type: 'text', text: 'intermediate'}, {type: 'tool-call'}]),
    message(4, [{type: 'text', text: 'final'}]), {type: 'turn/end', seq: 5, data: {turn: 1, reason: {kind: 'completed'}}}];
  assert.equal(finalAssistantText(events), 'final');
  assert.equal(finalAssistantText([events[0], events[2]]), null);
  events[2].data.reason.kind = 'error'; assert.equal(finalAssistantText(events), null);
  const {task} = await setup(); delete task.toolOperations; task.status = 'limited'; task.artifact = 'old intermediate claim';
  const value = publicTask(task); assert.equal(value.artifact, null);
  assert.equal(value.report.evidenceCoverage, 'unavailable');
});

function panelHarness(fetch, {storage = new Map()} = {}) {
  const nodes = new Map(); let uuidCounter = 0;
  const element = () => ({textContent: '', value: '', children: [], style: {}, dataset: {}, disabled: false,
    append(...children) {this.children.push(...children); if (!this.value) this.value = children[0]?.value ?? '';},
    replaceChildren(...children) {this.children = [...children]; this.value = children[0]?.value ?? '';},
    showModal() {}, close() {this.onclose?.();}, attachShadow() {return root;}});
  const dialog = element(), root = {set innerHTML(_) {},
    getElementById(id) {if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id);}, querySelector: () => dialog};
  const document = {readyState: 'complete', getElementById: () => null, body: element(),
    createElement: () => element(), createDocumentFragment: () => element(),
    createTextNode: textContent => ({textContent})};
  runInNewContext(panelSource, {document, fetch,
    crypto:{randomUUID:() => '00000000-0000-4000-8000-' + String(++uuidCounter).padStart(12, '0')},
    localStorage:{getItem:key=>storage.get(key) ?? null, setItem:(key,value)=>storage.set(key,value)},
    setInterval: () => 1, clearInterval() {}});
  return {nodes, storage, open: async () => {
    nodes.get('open').onclick(); await new Promise(resolve => setImmediate(resolve));
  }};
}
const panelSource = await readFile(new URL('../panel.js', import.meta.url), 'utf8');
const jsonResponse = (value, ok = true, status = 200) => ({ok, status, json: async () => value});

test('daily task entry preserves identity, single-flights double submit and separates turn completion from acceptance', async () => {
  const nodes = new Map(), storage = new Map();
  const element = () => ({textContent: '', value: '', children: [], style: {}, dataset: {}, disabled: false,
    append(...children) {this.children.push(...children); if (!this.value) this.value = children[0]?.value ?? '';},
    replaceChildren(...children) {this.children = [...children]; this.value = children[0]?.value ?? '';},
    showModal() {}, close() {this.onclose?.();}, attachShadow() {return root;}});
  const dialog = element(), root = {set innerHTML(_) {},
    getElementById(id) {if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id);}, querySelector: () => dialog};
  const document = {readyState: 'complete', getElementById: () => null, body: element(),
    createElement: () => element(), createDocumentFragment: () => element(),
    createTextNode: textContent => ({textContent})};
  const policy = {root:{provider:'fixture',model:'scripted'}, allowedRoutes:[{provider:'fixture',model:'scripted'}],
    toolSet:'development', maxCalls:8};
  const tasks = [], requests = [];
  const response = (value, ok = true, status = 200) => ({ok, status, json: async () => value});
  const fetch = async (url, options = {}) => {
    requests.push({url, options});
    if (options.method === 'POST') {
      const input = JSON.parse(options.body); tasks.push(publicTask({id:input.requestId,
        sessionId:'gateway-agent-' + input.requestId, goal:input.goal, workspaceId:input.workspaceId, policy,
        status:'completed', createdAt:new Date().toISOString(), endedAt:new Date().toISOString(),
        artifact:'FINAL_TEXT', calls:[], denials:[], toolOperations:[], approvalOperations:[
          {sessionId:'gateway-agent-' + input.requestId,seq:5,name:'write',outcome:'rejected',decisionSeq:6}]}));
      return response(tasks.at(-1));
    }
    return response({policy, workspaces:[{id:'default',label:'Fixture workspace'}],
      capabilities:{commandExecution:'disabled',validation:'not-established'}, tasks});
  };
  runInNewContext(await readFile(new URL('../panel.js', import.meta.url), 'utf8'), {
    document, fetch, crypto:{randomUUID:()=>'00000000-0000-4000-8000-000000000001'},
    localStorage:{getItem:key=>storage.get(key) ?? null, setItem:(key,value)=>storage.set(key,value)},
    setInterval: () => 1, clearInterval() {}
  });
  nodes.get('open').onclick(); await new Promise(resolve => setImmediate(resolve));
  nodes.get('goal').value = 'repair the fixture'; nodes.get('goal').oninput();
  const saved = JSON.parse(storage.get('gateway-agent-task-entry-v1'));
  assert.equal(saved.draft.requestId, '00000000-0000-4000-8000-000000000001');
  const first = nodes.get('submit').onclick(), second = nodes.get('submit').onclick();
  await Promise.all([first, second]);
  assert.equal(requests.filter(item => item.options.method === 'POST').length, 1);
  assert.deepEqual(JSON.parse(requests.find(item => item.options.method === 'POST').options.body), {
    requestId:'00000000-0000-4000-8000-000000000001', goal:'repair the fixture', workspaceId:'default', maxCalls:8});
  assert.match(nodes.get('status').textContent, /未经测试或业务验收/);
  assert.match(nodes.get('validation').textContent, /未建立/);
  assert.equal(nodes.get('result').textContent, 'FINAL_TEXT');
  assert.match(nodes.get('workspace-scope').textContent, /Fixture workspace.*default.*不会授权其他工作区/);
  assert.match(nodes.get('approvals').children[0].children[0].children[0].textContent,
    /动作 write.*rejected.*请求突破/);
});



test('continuation UI single-flights, recovers a lost response by attempt id and exposes cumulative evidence', async () => {
  const basePolicy = {root:{provider:'fixture',model:'scripted'}, allowedRoutes:[{provider:'fixture',model:'scripted'}],
    toolSet:'development', maxCalls:8};
  const task = {id:'10000000-0000-4000-8000-000000000001', sessionId:'gateway-agent-ui-continuation',
    goal:'repair the fixture', workspaceId:'default', policy:structuredClone(basePolicy), status:'completed',
    createdAt:'2026-09-19T00:00:00.000Z', endedAt:'2026-09-19T00:01:00.000Z', artifact:'INITIAL', calls:[], denials:[],
    toolOperations:[], approvalOperations:[], attempts:[{id:'10000000-0000-4000-8000-000000000002', kind:'initial',
      instruction:'repair the fixture', additionalCalls:0, budgetBefore:8, budgetAfter:8, callStart:0, callEnd:0,
      status:'completed', startedAt:'2026-09-19T00:00:00.000Z', endedAt:'2026-09-19T00:01:00.000Z', artifact:'INITIAL',
      failureCode:null, failureStage:null}]};
  const requests = [];
  const fetch = async (url, options = {}) => {
    requests.push({url, options});
    if (options.method === 'POST' && url.includes('action=continue')) {
      const input = JSON.parse(options.body), before = task.policy.maxCalls;
      task.policy = {...task.policy, maxCalls:before + input.additionalCalls};
      task.status = 'completed'; task.endedAt = '2026-09-19T00:02:00.000Z'; task.artifact = 'CONTINUED';
      task.attempts.push({id:input.continuationId, kind:input.kind, instruction:input.instruction,
        additionalCalls:input.additionalCalls, budgetBefore:before, budgetAfter:task.policy.maxCalls,
        callStart:task.calls.length, callEnd:task.calls.length, status:'completed',
        startedAt:'2026-09-19T00:01:01.000Z', endedAt:task.endedAt, artifact:task.artifact,
        failureCode:null, failureStage:null});
      throw new Error('synthetic response loss after acceptance');
    }
    if (url.includes('?id=')) return jsonResponse(publicTask(task));
    return jsonResponse({policy:basePolicy, authorizedTaskMaxCalls:[8], authorizedContinuationCallIncrements:[2],
      workspaces:[{id:'default',label:'Fixture workspace'}], capabilities:{commandExecution:'disabled'},
      tasks:[publicTask(task)]});
  };
  const {nodes, storage, open} = panelHarness(fetch); await open();
  assert.deepEqual(nodes.get('continuation-calls').children.map(option => option.value), ['0','2']);
  nodes.get('continuation-kind').value = 'supplement'; nodes.get('continuation-kind').onchange();
  nodes.get('continuation-calls').value = '2'; nodes.get('continuation-calls').onchange();
  nodes.get('continuation-instruction').value = 'include the new acceptance detail';
  nodes.get('continuation-instruction').oninput();
  const before = JSON.parse(storage.get('gateway-agent-task-entry-v1')).continuation.continuationId;
  const first = nodes.get('continue').onclick(), second = nodes.get('continue').onclick();
  await Promise.all([first, second]);
  const posts = requests.filter(item => item.options.method === 'POST' && item.url.includes('action=continue'));
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].options.body), {continuationId:before, kind:'supplement',
    instruction:'include the new acceptance detail', additionalCalls:2});
  assert.equal(requests.filter(item => item.options.method !== 'POST' && item.url.includes('?id=')).length, 1);
  const saved = JSON.parse(storage.get('gateway-agent-task-entry-v1'));
  assert.equal(saved.continuation.pending, false); assert.notEqual(saved.continuation.continuationId, before);
  assert.match(nodes.get('budget').textContent, /初始额度 8.*显式追加 2.*累计上限 10/);
  assert.equal(nodes.get('attempts').children[0].children.length, 2);
  assert.match(nodes.get('attempts').children[0].children[1].children[0].textContent, /supplement.*budget 8→10/);

  task.status = 'unknown'; task.endedAt = null; task.artifact = null;
  task.attempts.push({id:'10000000-0000-4000-8000-000000000003', kind:'reconcile', instruction:'inspect state',
    additionalCalls:0, budgetBefore:10, budgetAfter:10, callStart:0, callEnd:0, status:'reconciled',
    startedAt:'2026-09-19T00:03:00.000Z', endedAt:'2026-09-19T00:04:00.000Z', artifact:'READ_ONLY',
    failureCode:null, failureStage:null, reconciliationEvidence:{git:{changed:2}, security:{narrowedByGateway:true}}});
  task.attempts.push({id:'10000000-0000-4000-8000-000000000004', kind:'continue', instruction:'continue after review',
    additionalCalls:0, budgetBefore:10, budgetAfter:10, callStart:0, callEnd:null, status:'unknown',
    startedAt:'2026-09-19T00:05:00.000Z', endedAt:null, artifact:null, failureCode:'PROCESS_RESTART', failureStage:'host'});
  await nodes.get('refresh').onclick();
  assert.deepEqual(nodes.get('continuation-kind').children.map(option => option.value), ['reconcile']);
  assert.deepEqual(nodes.get('continuation-calls').children.map(option => option.value), ['0','2']);
  assert.match(nodes.get('reconciliation').children[0].textContent, /narrowedByGateway/);

  task.status = 'running'; task.attempts.at(-1).status = 'running';
  await nodes.get('refresh').onclick();
  assert.equal(nodes.get('continuation-kind').children.length, 0);
  assert.equal(nodes.get('continue').disabled, true);
});

test('pending initial request recovery compares the immutable initial budget after continuation increments', async () => {
  const id = '20000000-0000-4000-8000-000000000001';
  const basePolicy = {root:{provider:'fixture',model:'scripted'}, allowedRoutes:[{provider:'fixture',model:'scripted'}],
    toolSet:'development', maxCalls:10};
  const task = publicTask({id, sessionId:'gateway-agent-initial-recovery', goal:'keep the original request',
    workspaceId:'default', policy:basePolicy, status:'completed', createdAt:'2026-09-19T00:00:00.000Z',
    endedAt:'2026-09-19T00:02:00.000Z', artifact:'DONE', calls:[], denials:[], toolOperations:[], approvalOperations:[],
    attempts:[{id, kind:'initial', instruction:'keep the original request', additionalCalls:0,
      budgetBefore:8, budgetAfter:8, callStart:0, callEnd:0, status:'completed',
      startedAt:'2026-09-19T00:00:00.000Z', endedAt:'2026-09-19T00:01:00.000Z', artifact:'FIRST',
      failureCode:null, failureStage:null},
    {id:'20000000-0000-4000-8000-000000000002', kind:'continue', instruction:'use two more calls', additionalCalls:2,
      budgetBefore:8, budgetAfter:10, callStart:0, callEnd:0, status:'completed',
      startedAt:'2026-09-19T00:01:01.000Z', endedAt:'2026-09-19T00:02:00.000Z', artifact:'DONE',
      failureCode:null, failureStage:null}]});
  const storage = new Map([['gateway-agent-task-entry-v1', JSON.stringify({
    draft:{requestId:id, goal:'keep the original request', workspaceId:'default', maxCalls:8, pending:true},
    selectedTaskId:null, continuation:{taskId:null, continuationId:'20000000-0000-4000-8000-000000000003',
      kind:'continue', instruction:'', additionalCalls:0, pending:false}})]]);
  const requests = [];
  const fetch = async (url, options = {}) => {
    requests.push({url, options});
    return jsonResponse({policy:basePolicy, authorizedTaskMaxCalls:[8], authorizedContinuationCallIncrements:[2],
      workspaces:[{id:'default',label:'Fixture workspace'}], capabilities:{commandExecution:'disabled'}, tasks:[task]});
  };
  const {nodes, open} = panelHarness(fetch, {storage}); await open();
  assert.equal(requests.some(item => item.options.method === 'POST'), false);
  assert.match(nodes.get('error').textContent, /已按原请求身份找回任务/);
  const saved = JSON.parse(storage.get('gateway-agent-task-entry-v1'));
  assert.equal(saved.draft.pending, false); assert.notEqual(saved.draft.requestId, id);
  assert.equal(saved.selectedTaskId, id);
});

test('stale localStorage scheduling is cleared and omitted when scheduling is disabled', async () => {
  const basePolicy = {root:{provider:'fixture',model:'scripted'}, allowedRoutes:[{provider:'fixture',model:'scripted'}],
    toolSet:'development', maxCalls:8};
  const storage = new Map([['gateway-agent-task-entry-v1', JSON.stringify({
    draft:{requestId:'30000000-0000-4000-8000-000000000001', goal:'', workspaceId:'default', maxCalls:8,
      scheduling:{root:{provider:'fixture',model:'scripted'}, mode:'single', children:[]}, pending:false},
    selectedTaskId:null, continuation:{taskId:null, continuationId:'30000000-0000-4000-8000-000000000002',
      kind:'continue', instruction:'', additionalCalls:0, pending:false}})]]);
  const tasks = [], posts = [];
  const fetch = async (url, options = {}) => {
    if (options.method === 'POST') {
      const input = JSON.parse(options.body);
      posts.push(input);
      tasks.push(publicTask({id:input.requestId, sessionId:'gateway-agent-' + input.requestId, goal:input.goal,
        workspaceId:input.workspaceId, policy:basePolicy, status:'completed', createdAt:new Date().toISOString(),
        endedAt:new Date().toISOString(), artifact:'OK', calls:[], denials:[], toolOperations:[], approvalOperations:[]}));
      return jsonResponse(tasks.at(-1));
    }
    return jsonResponse({policy:basePolicy, scheduling:null, authorizedTaskMaxCalls:[4,8],
      workspaces:[{id:'default',label:'Fixture workspace'}],
      capabilities:{commandExecution:'disabled',validation:'not-established'}, tasks});
  };
  const {nodes, open} = panelHarness(fetch, {storage});
  await open();
  assert.match(nodes.get('policy').textContent, /默认 8 次模型调用.*新任务已授权限额 4、8.*命令执行不可用/);
  assert.doesNotMatch(nodes.get('policy').textContent, /单独选择主模型/);
  nodes.get('goal').value = 'submit after scheduling disabled';
  nodes.get('goal').oninput();
  await nodes.get('submit').onclick();
  assert.equal(posts.length, 1);
  assert.equal('scheduling' in posts[0], false);
  const saved = JSON.parse(storage.get('gateway-agent-task-entry-v1'));
  assert.equal(saved.draft.scheduling, null);
});

test('panel validation section surfaces read-only policySensor gate and finding codes without relaxing honesty notices', async () => {
  const basePolicy = {root:{provider:'fixture',model:'scripted'}, allowedRoutes:[{provider:'fixture',model:'scripted'}],
    toolSet:'development', maxCalls:8};
  const runningTask = publicTask({
    id:'40000000-0000-4000-8000-000000000001', sessionId:'gateway-agent-sensor-running',
    goal:'running without sensor', workspaceId:'default', policy:basePolicy, status:'running',
    createdAt:'2026-11-23T00:00:00.000Z', endedAt:null, artifact:null, calls:[], denials:[],
    toolOperations:[], approvalOperations:[],
  });
  const l1Task = publicTask({
    id:'40000000-0000-4000-8000-000000000002', sessionId:'gateway-agent-sensor-l1',
    goal:'clean completed task', workspaceId:'default', policy:basePolicy, status:'completed',
    createdAt:'2026-11-23T00:00:00.000Z', endedAt:'2026-11-23T00:01:00.000Z', artifact:'Completed read-only check.',
    calls:[], denials:[], toolOperations:[], approvalOperations:[],
  });
  const l2Task = publicTask({
    id:'40000000-0000-4000-8000-000000000003', sessionId:'gateway-agent-sensor-l2',
    goal:'unscoped test claim', workspaceId:'default', policy:basePolicy, status:'completed',
    createdAt:'2026-11-23T00:00:00.000Z', endedAt:'2026-11-23T00:01:00.000Z', artifact:'All unit tests passed.',
    calls:[], denials:[],
    toolOperations:[{sessionId:'gateway-agent-sensor-l2', seq:1, name:'pwsh', outcome:'succeeded', exitCode:0}],
    approvalOperations:[],
  });
  const l3Task = publicTask({
    id:'40000000-0000-4000-8000-000000000004', sessionId:'gateway-agent-sensor-l3',
    goal:'tamper detection', workspaceId:'default', policy:basePolicy, status:'completed',
    createdAt:'2026-11-23T00:00:00.000Z', endedAt:'2026-11-23T00:01:00.000Z', artifact:'All tests passed.',
    calls:[], denials:[], toolOperations:[], approvalOperations:[],
    attempts:[{
      id:'40000000-0000-4000-8000-000000000014', kind:'initial', instruction:'tamper detection',
      additionalCalls:0, budgetBefore:8, budgetAfter:8, callStart:0, callEnd:0, status:'completed',
      startedAt:'2026-11-23T00:00:00.000Z', endedAt:'2026-11-23T00:01:00.000Z', artifact:'All tests passed.',
      failureCode:null, failureStage:null,
      policySensor:{
        schema:'gateway-policy-sensor-v1', evaluatedAt:'2026-11-23T00:01:00.000Z',
        gateLevel:'L3_HUMAN_REQUIRED', requiresHumanReview:true, claimEvidenceStatus:'mismatch',
        claims:{hasFinalText:true, claimedTestsPassed:true, claimedFileChanged:false},
        evidenceCounts:{confirmedEdits:0, succeededCommands:0, failedCommands:0, unconfirmedCommands:0, failedTools:0, unconfirmedTools:0},
        git:{coverage:'baseline-delta', reason:null, baselineDirtyEntries:0, headMoved:false, truncated:false,
          delta:{totalChangedFiles:1, addedFiles:0, modifiedFiles:1, deletedFiles:0,
            categories:{test:1, security:0, contract:0, docs:0, source:0, other:0},
            testTamper:{modifiedTestFiles:1, skipAddedFiles:0, assertionsReducedFiles:1}}},
        findings:[
          {code:'TEST_ASSERTIONS_REDUCED', severity:'L3', category:'git-tamper', count:1},
          {code:'CLAIM_TESTS_PASSED_WITHOUT_COMMAND_EVIDENCE', severity:'L3', category:'claim-evidence'},
        ],
      },
    }],
  });

  const tasks = [runningTask, l1Task, l2Task, l3Task];
  const fetch = async () => jsonResponse({
    policy:basePolicy, authorizedTaskMaxCalls:[8], workspaces:[{id:'default',label:'Fixture workspace'}],
    capabilities:{commandExecution:'disabled',validation:'not-established'}, tasks,
  });
  const {nodes, open} = panelHarness(fetch);
  await open();

  const selectTask = id => { nodes.get('tasks').value = id; nodes.get('tasks').onchange(); };

  selectTask(runningTask.id);
  assert.match(nodes.get('validation').textContent, /未建立.*未验收/);
  assert.doesNotMatch(nodes.get('validation').textContent, /策略传感器/);

  selectTask(l1Task.id);
  assert.match(nodes.get('validation').textContent, /未建立.*未验收/);
  assert.match(nodes.get('validation').textContent, /策略传感器：L1 自动放行（未检出策略违规）。/);

  selectTask(l2Task.id);
  assert.match(nodes.get('validation').textContent, /未建立.*未验收/);
  assert.match(nodes.get('validation').textContent, /策略传感器：L2 自动告警（建议核对）（CLAIM_TESTS_PASSED_UNSCOPED_COMMAND）。/);

  selectTask(l3Task.id);
  assert.match(nodes.get('validation').textContent, /未建立.*未验收/);
  assert.match(nodes.get('validation').textContent, /策略传感器：L3 需人工复核（TEST_ASSERTIONS_REDUCED、CLAIM_TESTS_PASSED_WITHOUT_COMMAND_EVIDENCE）。/);
});
