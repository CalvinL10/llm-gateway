import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { TaskLedger } from './ledger.js';
import { toolEvent, commandResult, finalAssistantText, publicTask } from './report.js';

const policy = {root: {provider: 'fixture', model: 'scripted'}, allowedRoutes: [{provider: 'fixture', model: 'scripted'}], maxCalls: 8};
async function setup() {
  const data = new Map(), table = {get: id => data.get(id), entries: () => data.entries(),
    put: async (id, t) => data.set(id, structuredClone(t))};
  const ledger = new TaskLedger(table);
  const {task} = await ledger.create({requestId: randomUUID(), goal: 'synthetic'}, policy);
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

test('safe projections use linked result facts only; no arbitrary error, arguments, meta or content escapes', () => {
  const secret = 'SYNTHETIC_PRIVATE_TOKEN_COOKIE_COMMAND_FILE';
  const call = {type: 'tool/call', seq: 1, data: {callId: 'c', name: 'edit', arguments: secret}};
  const event = {type: 'tool/result', seq: 2, sourceEventSeqs: [1], data: {error: {code: secret, message: secret},
    meta: {privateFile: secret}, message: {content: [{type: 'tool-result', toolCallId: 'c', isError: true, content: [{text: secret}]}]}}};
  const operation = toolEvent('root', event, [call, event]);
  assert.equal(operation.outcome, 'failed'); assert.equal(operation.errorCode, 'TOOL_FAILED');
  assert.ok(!JSON.stringify(operation).includes(secret));
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

test('read-only panel labels limited/completed correctly and never renders assistant claims or posts', async () => {
  const nodes = new Map();
  const element = () => ({textContent: '', value: '', children: [], style: {},
    append(child) {this.children.push(child); if (!this.value) this.value = child.value ?? '';},
    replaceChildren() {this.children = []; this.value = '';}, showModal() {}, close() {this.onclose?.();}});
  const dialog = element(), root = {set innerHTML(_) {}, getElementById(id) {if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id);}, querySelector: () => dialog};
  const document = {readyState: 'complete', getElementById: () => null, body: element(), createElement() {
    const e = element(); e.attachShadow = () => root; return e;
  }};
  const {task} = await setup(); task.status = 'limited'; task.artifact = 'SECRET_MODEL_CLAIM';
  const requests = [];
  runInNewContext(await readFile(new URL('./panel.js', import.meta.url), 'utf8'), {
    document, fetch: async (url, options) => {requests.push({url, options}); return {ok: true, json: async () => ({tasks: [publicTask(task)]})};},
    setInterval: () => 1, clearInterval() {}
  });
  nodes.get('open').onclick(); await new Promise(resolve => setImmediate(resolve));
  assert.match(nodes.get('status').textContent, /未完成/);
  assert.doesNotMatch(nodes.get('report').textContent, /SECRET_MODEL_CLAIM/);
  task.status = 'completed'; await nodes.get('tasks').onchange();
  assert.match(nodes.get('status').textContent, /不等于业务目标完成/);
  assert.ok(requests.every(r => r.url === '/api/gateway-agent-tasks' && !r.options.method));
});
