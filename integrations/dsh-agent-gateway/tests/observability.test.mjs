import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {TaskLedger} from '../ledger.js';
import {auditExport, publicTask, usageSemantics} from '../report.js';

const rootRoute = {provider:'fixture-lead', model:'planner', reasoningEffort:'high'};
const childRoute = {provider:'fixture-deep', model:'worker', reasoningEffort:'medium'};
const policy = {root:rootRoute, allowedRoutes:[rootRoute, childRoute], allowedChildRoutes:[childRoute], maxCalls:20};

function setup() {
  const data = new Map();
  const table = {get:id => data.get(id), entries:() => data.entries(),
    put:async(id, value) => data.set(id, structuredClone(value))};
  return {ledger:new TaskLedger(table), table};
}

async function createTask(ledger, goal = 'TEST_ONLY_PRIVATE_GOAL') {
  const {task} = await ledger.create({requestId:randomUUID(), goal}, policy);
  // Use the production lifecycle: queued tasks cannot admit a model call.
  await ledger.startAttempt(task.id, task.id);
  return ledger.get(task.id);
}

const facts = (task, overrides = {}) => ({sessionId:task.sessionId, parentSessionId:null,
  ...rootRoute, purpose:null, ...overrides});

test('concurrent root, child and auxiliary admissions retain task, attempt, lineage and source attribution', async () => {
  const {ledger} = setup(), task = await createTask(ledger);
  const inputs = [
    facts(task),
    facts(task, {sessionId:'child-a', parentSessionId:task.sessionId, ...childRoute}),
    facts(task, {purpose:'compaction'}),
    facts(task, {purpose:'planning'}),
    facts(task, {sessionId:'child-review', parentSessionId:task.sessionId, ...childRoute, purpose:'review'}),
  ];
  await Promise.all(inputs.map(value => ledger.admit(task.id, value)));
  const calls = ledger.get(task.id).calls;
  assert.equal(calls.length, 5);
  assert.ok(calls.every(call => call.attemptId === task.id));
  assert.ok(calls.every(call => call.measurementKind === 'llm-stream-admission'));
  assert.deepEqual(calls.map(call => [call.source, call.sessionRole, call.auxiliaryPurpose]), [
    ['root','root',null], ['child','child',null], ['auxiliary','root','compaction'],
    ['auxiliary','root','planning'], ['auxiliary','child','review'],
  ]);
});

test('admission, adapter boundary preparation and HTTP attempts remain distinct evidence boundaries', async () => {
  const {ledger} = setup(), task = await createTask(ledger);
  const call = await ledger.admit(task.id, facts(task));
  let stored = ledger.get(task.id).calls[0];
  assert.equal(stored.adapterBoundaryPreparedAt, null);
  assert.deepEqual(stored.httpAttempts, {observability:'bounded', count:0, basis:'next-invocation-not-prepared'});
  const beforeBoundary = auditExport([ledger.get(task.id)]).tasks[0].calls[0];
  assert.equal(beforeBoundary.adapterBoundaryBasis, 'not-prepared');
  assert.deepEqual(beforeBoundary.httpAttempts,
    {observability:'bounded', count:0, basis:'next-invocation-not-prepared'});

  await ledger.prepareCallAdapterBoundary(task.id, call.id, '2026-09-19T10:00:00.000Z');
  stored = ledger.get(task.id).calls[0];
  assert.equal(stored.adapterBoundaryPreparedAt, '2026-09-19T10:00:00.000Z');
  assert.deepEqual(stored.httpAttempts, {observability:'unavailable', count:null, basis:'no-host-transport-event'});
  assert.notEqual(stored.httpAttempts.count, 1, 'adapter boundary preparation must not be reported as one HTTP request');
});

test('partial usage survives failure and duplicate usage or finish events never double count or replace the first terminal fact', async () => {
  const {ledger} = setup(), task = await createTask(ledger);
  const call = await ledger.admit(task.id, facts(task));
  await ledger.prepareCallAdapterBoundary(task.id, call.id, '2026-09-19T10:00:00.000Z');
  await ledger.recordFirstResponse(task.id, call.id, '2026-09-19T10:00:01.000Z');
  const usage = {inputTokens:80, outputTokens:20, totalTokens:120, cacheReadTokens:20,
    reasoningTokens:5, ignoredProviderPayload:'TEST_ONLY_SECRET'};
  await ledger.recordUsage(task.id, call.id, usage, '2026-09-19T10:00:02.000Z');
  await ledger.recordUsage(task.id, call.id, usage, '2026-09-19T10:00:03.000Z');
  const laterUsage = {...usage, inputTokens:81, totalTokens:121};
  await ledger.recordUsage(task.id, call.id, laterUsage, '2026-09-19T10:00:03.500Z');
  await ledger.finishCall(task.id, call.id, 'error', laterUsage, {finishObserved:false,
    firstResponseAt:'2026-09-19T10:00:01.500Z', endedAt:'2026-09-19T10:00:04.000Z'});
  await ledger.finishCall(task.id, call.id, 'stop', {inputTokens:999, totalTokens:999},
    {finishObserved:true, endedAt:'2026-09-19T10:00:05.000Z'});
  await ledger.recordFirstResponse(task.id, call.id, '2026-09-19T10:00:06.000Z');
  await ledger.recordUsage(task.id, call.id, {inputTokens:777}, '2026-09-19T10:00:06.000Z');

  const stored = ledger.get(task.id).calls[0];
  assert.equal(stored.firstResponseAt, '2026-09-19T10:00:01.000Z');
  assert.equal(stored.usageFirstObservedAt, '2026-09-19T10:00:02.000Z');
  assert.equal(stored.usageObservedAt, '2026-09-19T10:00:03.500Z');
  assert.equal(stored.usageObservationCount, 2);
  assert.equal(stored.usageStatus, 'partial');
  assert.equal(stored.outcome, 'error');
  assert.equal(stored.endedAt, '2026-09-19T10:00:04.000Z');
  assert.deepEqual(stored.usage, {inputTokens:81, outputTokens:20, totalTokens:121,
    cacheReadTokens:20, reasoningTokens:5});
  assert.doesNotMatch(JSON.stringify(stored), /TEST_ONLY_SECRET/);

  const observations = publicTask(ledger.get(task.id)).report.observations;
  assert.deepEqual(observations.sessionRoles, {root:1, child:0});
  assert.equal(observations.usage.partial, 1);
  assert.deepEqual(observations.usage.tokenTotals.totalTokens,
    {observedSum:121, reportedCalls:1, finalSum:0, finalReportedCalls:0,
      partialObservedSum:121, partialReportedCalls:1, unknownObservedSum:0, unknownReportedCalls:0});
  assert.equal(observations.usage.tokenTotals.cacheReadTokens.partialObservedSum, 20);
  assert.equal(observations.usage.tokenTotals.reasoningTokens.partialObservedSum, 5);
  assert.equal(observations.usage.tokenTotals.totalTokens.observedSum, 121,
    'cache and reasoning detail counters must not be added to totalTokens');
  assert.match(usageSemantics.totalTokens, /never add cache or reasoning/);

  const conservative = await ledger.admit(task.id, facts(task));
  await ledger.recordUsage(task.id, conservative.id, {inputTokens:1});
  await ledger.finishCall(task.id, conservative.id, 'error', {inputTokens:1});
  assert.equal(ledger.get(task.id).calls[1].usageStatus, 'partial',
    'usage without an explicit terminal finish observation must not be promoted to final');
});

test('missing usage is explicit for failure, timeout-like abort and zero-response calls', async () => {
  const {ledger} = setup(), task = await createTask(ledger);
  for (const outcome of ['error','aborted']) {
    const call = await ledger.admit(task.id, facts(task));
    await ledger.prepareCallAdapterBoundary(task.id, call.id);
    await ledger.finishCall(task.id, call.id, outcome, null, {finishObserved:outcome === 'error'});
  }
  const report = publicTask(ledger.get(task.id)).report;
  assert.equal(report.observations.usage.missing, 2);
  assert.equal(report.observations.httpAttempts.unobservableCalls, 2);
  assert.deepEqual(ledger.get(task.id).calls.map(call => call.usageStatus), ['missing','missing']);
});

test('restart preserves durable partial usage and marks the unfinished call unknown without fabricating completion', async () => {
  const {ledger, table} = setup(), task = await createTask(ledger);
  const call = await ledger.admit(task.id, facts(task));
  await ledger.prepareCallAdapterBoundary(task.id, call.id, '2026-09-19T11:00:00.000Z');
  await ledger.recordFirstResponse(task.id, call.id, '2026-09-19T11:00:01.000Z');
  await ledger.recordUsage(task.id, call.id, {inputTokens:9, outputTokens:1}, '2026-09-19T11:00:02.000Z');

  const restarted = new TaskLedger(table);
  await restarted.recover();
  const stored = restarted.get(task.id).calls[0];
  assert.equal(stored.outcome, 'unknown');
  assert.equal(stored.usageStatus, 'partial');
  assert.deepEqual(stored.usage, {inputTokens:9, outputTokens:1});
  assert.equal(stored.endedAt, null);
  assert.equal(stored.firstResponseAt, '2026-09-19T11:00:01.000Z');
});

test('minimal audit export supports zero-call tasks and excludes goals, instructions, artifacts, payloads and error text', async () => {
  const {ledger} = setup(), empty = await createTask(ledger, 'TEST_ONLY_SECRET_GOAL');
  empty.attempts[0].instruction = 'TEST_ONLY_SECRET_INSTRUCTION';
  empty.artifact = 'TEST_ONLY_SECRET_ARTIFACT';
  const zero = auditExport([empty]);
  assert.equal(zero.format, 'gateway-agent-audit-v1');
  assert.deepEqual(zero.tasks[0].calls, []);
  assert.equal(zero.tasks[0].attempts.length, 1);
  assert.doesNotMatch(JSON.stringify(zero), /TEST_ONLY_SECRET/);

  const task = await createTask(ledger, 'SECOND_PRIVATE_GOAL');
  const call = await ledger.admit(task.id, facts(task, {purpose:'PRIVATE_CUSTOM_PURPOSE'}));
  await ledger.prepareCallAdapterBoundary(task.id, call.id, '2026-09-19T12:00:00.000Z');
  await ledger.recordUsage(task.id, call.id, {inputTokens:2, outputTokens:3, totalTokens:5,
    providerRequest:'PRIVATE_REQUEST_ID'});
  await ledger.finishCall(task.id, call.id, 'stop', null, {finishObserved:true, endedAt:'2026-09-19T12:00:02.000Z'});
  await ledger.recordTool(task.id, {sessionId:task.sessionId, seq:4, name:'PRIVATE_TOOL_NAME', outcome:'failed', turn:2, step:3,
    startedAt:'2026-09-19T12:00:00.500Z', endedAt:'2026-09-19T12:00:01.000Z',
    errorCode:'PRIVATE_ERROR_CODE', arguments:'PRIVATE_TOOL_ARGUMENTS', message:'PRIVATE_ERROR_TEXT'});
  await ledger.recordApproval(task.id, {sessionId:task.sessionId, seq:5, name:'PRIVATE_APPROVAL_NAME',
    outcome:'rejected', askedAt:'2026-09-19T12:00:01.100Z', decidedAt:'2026-09-19T12:00:01.200Z'});
  const exported = auditExport([ledger.get(task.id)]);
  const json = JSON.stringify(exported);
  assert.doesNotMatch(json, /PRIVATE_|SECOND_PRIVATE_GOAL/);
  assert.equal(exported.tasks[0].calls[0].source.kind, 'auxiliary');
  assert.equal(exported.tasks[0].calls[0].source.purpose, 'custom');
  assert.deepEqual(exported.tasks[0].calls[0].logicalRoute, rootRoute);
  assert.deepEqual(exported.tasks[0].tools, [{sessionId:task.sessionId, seq:4, name:'other',
    attemptId:task.id, outcome:'failed', turn:2, step:3, startedAt:'2026-09-19T12:00:00.500Z',
    endedAt:'2026-09-19T12:00:01.000Z', errorCode:'TOOL_FAILED'}]);
  assert.deepEqual(exported.tasks[0].approvals, [{sessionId:task.sessionId, seq:5, name:'other',
    attemptId:task.id, outcome:'rejected', askedAt:'2026-09-19T12:00:01.100Z',
    decidedAt:'2026-09-19T12:00:01.200Z'}]);

  await assert.rejects(ledger.admit(task.id, facts(task, {provider:'forbidden-provider',
    purpose:'PRIVATE_DENIAL_PURPOSE'})), error => error.code === 'ROUTE_NOT_AUTHORIZED');
  const denied = auditExport([ledger.get(task.id)]).tasks[0].denials[0];
  assert.equal(denied.purpose, 'custom');
  assert.doesNotMatch(JSON.stringify(denied), /PRIVATE_DENIAL_PURPOSE/);
});



test('duplicate tool and approval events retain their original attempt ownership across continuation', async () => {
  const {ledger} = setup(), task = await createTask(ledger);
  await ledger.recordTool(task.id, {sessionId:task.sessionId, seq:11, name:'read', outcome:'pending'});
  await ledger.recordApproval(task.id, {sessionId:task.sessionId, seq:12, name:'read', outcome:'pending'});
  await ledger.finish(task.id, 'failed', null, 'TEST_FAILURE', 'evidence');
  const continuationId = randomUUID();
  await ledger.beginContinuation(task.id, {continuationId, kind:'continue',
    instruction:'retry after reviewing evidence', additionalCalls:0});
  await ledger.recordTool(task.id, {sessionId:task.sessionId, seq:11, name:'read', outcome:'succeeded', resultSeq:13});
  await ledger.recordApproval(task.id, {sessionId:task.sessionId, seq:12, name:'read',
    outcome:'allowed-once', decisionSeq:14});

  const stored = ledger.get(task.id);
  assert.equal(stored.toolOperations[0].attemptId, task.id);
  assert.equal(stored.toolOperations[0].outcome, 'succeeded');
  assert.equal(stored.approvalOperations[0].attemptId, task.id);
  assert.equal(stored.approvalOperations[0].outcome, 'allowed-once');
});

test('legacy dispatch timestamps are projected as boundary preparation without claiming invocation or HTTP attempts', async () => {
  const {ledger} = setup(), task = await createTask(ledger);
  const legacy = ledger.get(task.id);
  legacy.calls.push({...facts(task), id:randomUUID(), attemptId:task.id,
    admittedAt:'2026-09-19T09:59:59.000Z', dispatchStartedAt:'2026-09-19T10:00:00.000Z',
    endedAt:null, outcome:'admitted', usage:null});
  const exported = auditExport([legacy]).tasks[0].calls[0];
  assert.equal(exported.adapterBoundaryPreparedAt, '2026-09-19T10:00:00.000Z');
  assert.equal(exported.adapterBoundaryBasis, 'legacy-dispatch-field-projected-as-boundary-preparation');
  assert.deepEqual(exported.httpAttempts, {observability:'unavailable', count:null, basis:'legacy-record'});
  assert.equal(publicTask(legacy).report.observations.adapterBoundaryPreparations, 1);
  legacy.calls[0].purpose = 'PRIVATE_LEGACY_PURPOSE';
  const publicLegacy = publicTask(legacy);
  assert.equal(publicLegacy.calls[0].purpose, 'custom');
  assert.doesNotMatch(JSON.stringify(publicLegacy.calls[0]), /PRIVATE_LEGACY_PURPOSE/);
});

test('sample ledger reconciles admissions and adapter observations without inventing HTTP evidence', async () => {
  const {ledger} = setup(), task = await createTask(ledger, 'reconcile synthetic evidence');
  const rawAdapterEvidence = [];
  for (let index = 0; index < 3; index++) {
    const call = await ledger.admit(task.id, facts(task, index === 2 ? {purpose:'review'} : {}));
    await ledger.prepareCallAdapterBoundary(task.id, call.id, `2026-09-19T13:00:0${index}.000Z`);
    rawAdapterEvidence.push({callId:call.id, firstResponseAt:`2026-09-19T13:00:1${index}.000Z`,
      usage:{inputTokens:10, outputTokens:index, totalTokens:10 + index}});
    await ledger.recordFirstResponse(task.id, call.id, rawAdapterEvidence.at(-1).firstResponseAt);
    await ledger.recordUsage(task.id, call.id, rawAdapterEvidence.at(-1).usage);
    await ledger.finishCall(task.id, call.id, index === 1 ? 'error' : 'stop', rawAdapterEvidence.at(-1).usage,
      {finishObserved:true, endedAt:`2026-09-19T13:00:2${index}.000Z`});
  }
  const exported = auditExport([ledger.get(task.id)]).tasks[0];
  assert.equal(exported.calls.length, rawAdapterEvidence.length);
  for (const raw of rawAdapterEvidence) {
    const call = exported.calls.find(value => value.id === raw.callId);
    assert.equal(call.firstResponseAt, raw.firstResponseAt);
    assert.deepEqual(call.usage, raw.usage);
    assert.equal(call.httpAttempts.observability, 'unavailable');
    assert.equal(call.httpAttempts.count, null);
  }
});
