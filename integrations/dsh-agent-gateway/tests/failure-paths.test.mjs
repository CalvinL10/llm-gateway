import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {copyFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRuntimeFixture} from './fixtures/test-runtime.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {path: moduleRoot, remove} = await createRuntimeFixture('failure-paths-');
test.after(remove);
for (const file of ['package.json', 'index.js', 'ledger.js', 'report.js', 'panel.js', 'tools.js'])
  await copyFile(resolve(source, file), resolve(moduleRoot, file));
const [{apply}, {developmentRootTools}] = await Promise.all([
  import(pathToFileURL(resolve(moduleRoot, 'index.js'))),
  import(pathToFileURL(resolve(moduleRoot, 'tools.js'))),
]);

const route = {provider: 'fixture-development', model: 'scripted'};
const endpoint = 'http://127.0.0.1/api/gateway-agent-tasks';

function taskRequest(id, goal = 'exercise failure path') {
  return new Request(endpoint, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({requestId: id, goal}),
  });
}

async function getTask(handler, id) {
  const response = await handler(new Request(`${endpoint}?id=${id}`));
  assert.equal(response.status, 200);
  return response.json();
}

async function waitFor(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  throw new Error(`condition not reached; last=${JSON.stringify(last)}`);
}

async function createHost({putFault, initialRecords = [], adapterChunks, adapterError, lifecycleBinding, permissionState} = {}) {
  const prompts = [];
  const records = new Map(initialRecords.map(record => [record.id, structuredClone(record)]));
  const agents = new Map();
  let schema, handler, dispose, stream;
  const events = [
    {seq: 1, type: 'assistant/message', data: {turn: 1, message: {content: [{type: 'text', text: 'LOCAL RESULT'}]}}},
    {seq: 2, type: 'turn/end', data: {turn: 1, reason: {kind: 'completed'}}},
  ];
  const session = {id: '', header: {}, snapshotEvents: () => events};
  let hostSignal = new AbortController();
  const agent = {id: '', session, cancel() { hostSignal.abort(new Error('fixture cancelled')); }, async whenIdle() {}};
  const ctx = {
    webServer: {host: '127.0.0.1'},
    storageDomain: {async open(config) {
      schema = config.tables.tasks.valueSchema;
      return {
        async close() {},
        table: () => ({
          get: id => records.get(id),
          entries: () => records.entries(),
          async put(id, value) {
            const candidate = schema.parse(structuredClone(value));
            if (await putFault?.(candidate)) throw new Error('P03_TEST_STORAGE_FAILURE');
            records.set(id, candidate);
          },
        }),
      };
    }},
    on(event, listener) {
      if (event === 'dispose') dispose = listener;
      if (event === 'llm/stream') stream = listener;
    },
    sessions: {get: id => agents.get(id)?.session},
    agents: {
      get: id => agents.get(id),
      list: () => [...agents.values()],
      isOwnedBy: () => false,
    },
    connection: {fetch: {register(spec) {handler = spec.fetch;}}},
    agentPresets: {serviceFor: () => ({schemas: () => developmentRootTools.map(name => ({name}))})},
    tools: {schemas: () => developmentRootTools.map(name => ({name}))},
    sessionProjections: {stateOf: () => permissionState?.() ?? ({sandbox: 'workspace-write', approval: 'ask'})},
    sessionController: {
      async create(request) {
        session.id = request.sessionId;
        session.header = {id: request.sessionId};
        agent.id = request.sessionId;
        agents.set(request.sessionId, agent);
        return request;
      },
      async resolveAgent() {
        if (hostSignal.signal.aborted) hostSignal = new AbortController();
        return {agent};
      },
      async rename() {},
      async selectModel() {return {selected: route};},
      async prompt(request, signal) {
        prompts.push(structuredClone(request));
        signal.throwIfAborted();
        const options = {sessionId: request.sessionId, ...route, reasoningEffort: null,
          purpose: null, tools: developmentRootTools.map(name => ({name})), signal: hostSignal.signal};
        for await (const _chunk of stream(options, async function* () {
          for (const chunk of adapterChunks ?? [{type: 'finish', reason: {kind: 'completed'}}]) yield chunk;
          if (adapterError) throw adapterError;
        })) { /* consume the real gateway middleware */ }
        const seq = events.at(-1).seq;
        events.push(
          {seq: seq + 1, type: 'assistant/message', data: {turn: 2, message: {content: [{type: 'text', text: 'LOCAL RESULT'}]}}},
          {seq: seq + 2, type: 'turn/end', data: {turn: 2, reason: {kind: 'completed'}}});
      },
    },
  };
  await apply(ctx, {cwd: moduleRoot,
    policy: {root: route, allowedRoutes: [route], toolSet: 'development', maxCalls: 8}}, {lifecycleBinding});
  return {records, prompts, get handler() {return handler;}, get dispose() {return dispose;}};
}

test('continue after preparation failure includes the undelivered original goal without renewing approval or budget', async () => {
  let runtime, safe = false;
  const host = await createHost({
    permissionState: () => ({sandbox: safe ? 'workspace-write' : 'danger-full-access', approval: 'ask'}),
    lifecycleBinding: {connect(value) {runtime = value;}, onOperatorCancel() {}},
  });
  const id = randomUUID(), goal = 'Create clamp.mjs in this intentionally empty workspace';
  try {
    const first = await runtime.start({requestId:id, goal, maxCalls:8});
    assert.equal((await first.done).task.failureCode, 'PREPARATION_FAILED');
    assert.equal(host.prompts.length, 0);
    safe = true;
    const second = await runtime.continue(id, {continuationId:randomUUID(), kind:'continue', instruction:'Continue after configuration repair', additionalCalls:0});
    await second.done;
    assert.equal(host.prompts.length, 1);
    const sent = JSON.stringify(host.prompts[0]);
    assert.ok(sent.includes(goal));
    assert.ok(sent.includes('context, not a new approval'));
    assert.ok(sent.includes('Request and await a new native approval whenever required'));
    assert.equal(host.records.get(id).policy.maxCalls, 8);
    assert.equal(host.records.get(id).calls.length, 1);
    assert.equal(host.records.get(id).attempts[0].status, 'failed');
  } finally {await host.dispose();}
});

async function getAudit(handler, id) {
  const response = await handler(new Request(`${endpoint}?id=${id}&view=audit`));
  assert.equal(response.status, 200);
  return response.json();
}

test('trusted lifecycle receipts reuse the native task, session and cumulative calls for one repair', async () => {
  let runtime;
  const host = await createHost({lifecycleBinding:{connect(value) { runtime = value; }, onOperatorCancel() {}}});
  const id = randomUUID(), repairId = randomUUID(), goal = 'native lifecycle receipt';
  try {
    await assert.rejects(runtime.start({requestId:id, goal, workspaceId:'not-configured'}),
      {code:'WORKSPACE_NOT_AUTHORIZED'});
    await assert.rejects(runtime.start({requestId:id, goal, maxCalls:9}), {code:'CALL_LIMIT_NOT_AUTHORIZED'});
    const first = await runtime.start({requestId:id, goal, maxCalls:8});
    const ended = await first.done;
    assert.equal(ended.terminationConfirmed, true);
    assert.equal(ended.task.status, 'completed');
    assert.equal(first.taskId, id); assert.equal(first.attemptId, id);
    assert.equal(first.sessionId, 'gateway-agent-' + id);
    assert.equal(await runtime.start({requestId:id, goal, maxCalls:8}), first);
    const repair = {continuationId:repairId, kind:'continue', instruction:'repair the same task', additionalCalls:0};
    await assert.rejects(runtime.continue(id, {...repair, additionalCalls:1}),
      {code:'CONTINUATION_CALL_LIMIT_NOT_AUTHORIZED'});
    const second = await runtime.continue(id, repair);
    assert.equal(second.taskId, first.taskId); assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.attemptId, repairId);
    // The historical receipt cannot cancel the new attempt, even during launch.
    assert.deepEqual(await first.stop(), {confirmed:true});
    assert.equal((await second.done).task.status, 'completed');
    assert.equal(await runtime.continue(id, repair), second);
    const stored = host.records.get(id);
    assert.equal(stored.calls.length, 2); assert.equal(stored.policy.maxCalls, 8);
    assert.deepEqual(stored.attempts.map(value => [value.id, value.callStart, value.callEnd]),
      [[id, 0, 1], [repairId, 1, 2]]);
    assert.ok(Object.isFrozen(runtime)); assert.ok(Object.isFrozen(first));

    const unmanaged = await host.handler(taskRequest(randomUUID()));
    assert.equal(unmanaged.status, 400);
    assert.equal((await unmanaged.json()).error, 'EXTERNAL_SCHEDULER_REQUIRED');
    const bypass = await host.handler(new Request(`${endpoint}?action=continue&id=${id}`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...repair, continuationId:randomUUID()}),
    }));
    assert.equal((await bypass.json()).error, 'EXTERNAL_SCHEDULER_REQUIRED');
    assert.equal(host.records.size, 1); assert.equal(host.records.get(id).attempts.length, 2);
  } finally { await host.dispose(); }
});

test('recovered records cannot manufacture execution receipts or replay through the trusted lifecycle', async () => {
  let runtime;
  const binding = {connect(value) { runtime = value; }, onOperatorCancel() {}};
  const initial = await createHost({lifecycleBinding:binding});
  const id = randomUUID(), goal = 'persist one native task';
  const first = await runtime.start({requestId:id, goal}); await first.done;
  const records = [...initial.records.values()]; await initial.dispose();
  const recovered = await createHost({lifecycleBinding:binding, initialRecords:records});
  try {
    await assert.rejects(runtime.start({requestId:id, goal}), {code:'NATIVE_EXECUTION_RECEIPT_UNAVAILABLE'});
    await assert.rejects(runtime.continue(id, {continuationId:randomUUID(), kind:'continue', instruction:'do not replay'}),
      {code:'EXECUTION_TERMINATION_UNCONFIRMED'});
    assert.equal(recovered.records.get(id).attempts.length, 1);
    assert.equal(recovered.records.get(id).calls.length, 1);
  } finally { await recovered.dispose(); }
});

test('receipt separates actual termination from an unconfirmed terminal storage write', async () => {
  let runtime;
  const host = await createHost({lifecycleBinding:{connect(value) { runtime = value; }, onOperatorCancel() {}},
    putFault:value => value.status === 'completed'});
  try {
    const receipt = await runtime.start({requestId:randomUUID(), goal:'terminal persistence failure'});
    const ended = await receipt.done;
    assert.equal(ended.terminationConfirmed, true);
    assert.equal(ended.task.status, 'unknown');
    assert.equal(ended.task.report.lifecycle.persistence, 'unconfirmed');
    // Neither a receipt nor the persisted running row grants a repair.
    await assert.rejects(runtime.continue(receipt.taskId,
      {continuationId:randomUUID(), kind:'continue', instruction:'must not resume'}));
  } finally { await host.dispose(); }
});

test('pending prompt cannot become confirmed termination from an early idle observation', {timeout:2000}, async () => {
  const prompt = Promise.withResolvers();
  let runtime;
  const host = await createCancellationHost({beforePromptDispatch:() => prompt.promise,
    lifecycleBinding:{connect(value) { runtime = value; }, onOperatorCancel() {}}});
  const id = randomUUID();
  try {
    const receipt = await runtime.start({requestId:id, goal:'late native prompt acceptance'});
    await waitFor(() => host.promptCalls === 1);
    assert.deepEqual(await receipt.stop(), {confirmed:false});
    const ended = await receipt.done;
    assert.equal(ended.terminationConfirmed, false); assert.equal(ended.task.status, 'unknown');
    assert.equal(ended.task.report.lifecycle.stopConfirmation, 'unconfirmed');
    await assert.rejects(runtime.continue(id, {continuationId:randomUUID(), kind:'reconcile', instruction:'not while old prompt lives'}),
      {code:'EXECUTION_TERMINATION_UNCONFIRMED'});
    prompt.resolve(); await new Promise(resolveWait => setTimeout(resolveWait, 20));
    assert.equal(host.providerDispatches, 0);
    assert.deepEqual(await receipt.stop(), {confirmed:false}); // no retrospective upgrade without reconciliation
    assert.equal(host.records.get(id).attempts.length, 1);
  } finally { prompt.resolve(); await host.dispose(); }
});

test('stop reobserves the owned tree after late prompt settlement, not its earlier idle promise', {timeout:2000}, async () => {
  const prompt = Promise.withResolvers(), stillBusy = Promise.withResolvers();
  let runtime, accepted = false;
  const host = await createCancellationHost({cancellationTimeoutMs:100,
    beforePromptDispatch:() => prompt.promise,
    rootWhenIdle:() => accepted ? stillBusy.promise : undefined,
    lifecycleBinding:{connect(value) { runtime = value; }, onOperatorCancel() {}}});
  try {
    const receipt = await runtime.start({requestId:randomUUID(), goal:'reobserve late prompt tree'});
    await waitFor(() => host.promptCalls === 1);
    const stopped = receipt.stop();
    await waitFor(() => host.idleCalls > 0);
    accepted = true; prompt.resolve();
    assert.deepEqual(await stopped, {confirmed:false});
    assert.ok(host.idleCalls >= 2);
    assert.equal((await receipt.done).task.status, 'unknown');
    assert.equal(host.providerDispatches, 0);
  } finally { prompt.resolve(); stillBusy.resolve(); await host.dispose(); }
});

test('a pending prompt that actually settles permits a fresh confirmed tree stop', {timeout:2000}, async () => {
  const prompt = Promise.withResolvers();
  let runtime;
  const host = await createCancellationHost({cancellationTimeoutMs:200,
    beforePromptDispatch:() => prompt.promise,
    lifecycleBinding:{connect(value) { runtime = value; }, onOperatorCancel() {}}});
  try {
    const receipt = await runtime.start({requestId:randomUUID(), goal:'settle pending prompt before proof'});
    await waitFor(() => host.promptCalls === 1);
    const stopped = receipt.stop();
    await waitFor(() => host.idleCalls > 0);
    prompt.resolve();
    assert.deepEqual(await stopped, {confirmed:true});
    assert.ok(host.idleCalls >= 2);
    assert.equal((await receipt.done).task.status, 'stopped');
    assert.equal(host.providerDispatches, 0);
  } finally { prompt.resolve(); await host.dispose(); }
});

test('HTTP operator cancellation still cancels native execution when the scheduler callback fails', {timeout:2000}, async () => {
  let runtime, notified;
  const never = new Promise(() => {});
  const host = await createCancellationHost({rootWhenIdle:() => never,
    lifecycleBinding:{connect(value) { runtime = value; }, onOperatorCancel(value) {
      notified = value; throw new Error('scheduler notification failed');
    }}});
  try {
    const id = randomUUID(), receipt = await runtime.start({requestId:id, goal:'cancel through HTTP'});
    await waitFor(() => host.idleCalls > 0);
    const response = await host.handler(new Request(`${endpoint}?action=cancel&id=${id}`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:'{}',
    }));
    assert.equal(response.status, 500); assert.deepEqual(notified, {taskId:id, attemptId:id});
    assert.ok(host.cancelCounts.get('gateway-agent-' + id) > 0);
    assert.equal((await receipt.done).terminationConfirmed, false);
  } finally { await host.dispose(); }
});

test('real llm/stream wiring persists boundary, first response, final usage and failed partial usage', async () => {
  const complete = await createHost({adapterChunks:[
    {type:'text-delta', index:0, text:'fixture'},
    {type:'usage', usage:{inputTokens:7, outputTokens:2, totalTokens:9, cacheReadTokens:3}},
    {type:'finish', reason:{kind:'completed'}},
  ]});
  try {
    const id = randomUUID();
    assert.equal((await complete.handler(taskRequest(id, 'observe complete stream'))).status, 200);
    await waitFor(async () => (await getTask(complete.handler, id)).status === 'completed');
    const audit = await getAudit(complete.handler, id);
    const call = audit.tasks[0].calls[0];
    assert.ok(call.adapterBoundaryPreparedAt);
    assert.equal(call.adapterBoundaryBasis, 'durable-preparation-immediately-before-next-invocation');
    assert.ok(call.firstResponseAt);
    assert.equal(call.outcome, 'completed');
    assert.equal(call.usageStatus, 'final');
    assert.equal(call.usageObservationCount, 1);
    assert.deepEqual(call.usage, {inputTokens:7, outputTokens:2, totalTokens:9, cacheReadTokens:3});
    assert.deepEqual(call.httpAttempts, {observability:'unavailable', count:null, basis:'no-host-transport-event'});
  } finally {
    await complete.dispose();
  }

  const failed = await createHost({adapterChunks:[
    {type:'usage', usage:{inputTokens:5, outputTokens:1}},
  ], adapterError:new Error('fixture adapter stream failure')});
  try {
    const id = randomUUID();
    assert.equal((await failed.handler(taskRequest(id, 'observe failed partial stream'))).status, 200);
    await waitFor(async () => (await getTask(failed.handler, id)).status === 'unknown');
    const audit = await getAudit(failed.handler, id);
    assert.equal(audit.tasks[0].failureCode, 'EXECUTION_UNCONFIRMED');
    const call = audit.tasks[0].calls[0];
    assert.equal(call.outcome, 'error');
    assert.equal(call.usageStatus, 'partial');
    assert.equal(call.usageObservationCount, 1);
    assert.deepEqual(call.usage, {inputTokens:5, outputTokens:1});
    assert.ok(call.endedAt);
  } finally {
    await failed.dispose();
  }
});

test('finishCall and final persistence failures expose a locally ended unconfirmed task instead of permanent running', async () => {
  let finishCallFailures = 0, finalFailures = 0;
  const host = await createHost({putFault(record) {
    if (record.status === 'running' && record.calls.some(call => call.endedAt !== null)) {
      finishCallFailures++;
      return true;
    }
    if (!['queued', 'running', 'cancel-requested'].includes(record.status)) {
      finalFailures++;
      return true;
    }
    return false;
  }});
  try {
    const id = randomUUID();
    const created = await host.handler(taskRequest(id));
    assert.equal(created.status, 200);
    const task = await waitFor(async () => {
      const current = await getTask(host.handler, id);
      return current.report?.lifecycle?.state === 'ended-local' ? current : null;
    });
    assert.equal(task.status, 'unknown');
    assert.equal(task.artifact, null);
    assert.equal(task.failureCode, 'EVIDENCE_STORAGE_FAILED');
    assert.deepEqual(task.report.lifecycle, {
      state: 'ended-local',
      localOutcome: 'unknown',
      persistence: 'unconfirmed',
      stopConfirmation: 'unconfirmed',
    });
    assert.equal(finishCallFailures, 1);
    assert.equal(finalFailures, 1);
  } finally {
    await host.dispose();
  }
});



test('final persistence failure exposes the completed local outcome without publishing an unconfirmed artifact', async () => {
  let finalFailures = 0;
  const host = await createHost({putFault(record) {
    if (record.status === 'completed') { finalFailures++; return true; }
    return false;
  }});
  try {
    const id = randomUUID();
    const created = await host.handler(taskRequest(id));
    assert.equal(created.status, 200);
    const task = await waitFor(async () => {
      const current = await getTask(host.handler, id);
      return current.report?.lifecycle?.state === 'ended-local' ? current : null;
    });
    assert.equal(task.status, 'unknown');
    assert.equal(task.artifact, null);
    assert.equal(task.failureCode, null);
    assert.deepEqual(task.report.lifecycle, {
      state: 'ended-local',
      localOutcome: 'completed',
      persistence: 'unconfirmed',
      stopConfirmation: null,
    });
    assert.equal(finalFailures, 1);
    assert.equal(host.records.get(id).status, 'running');
    assert.equal(host.records.get(id).calls[0].outcome, 'completed');
  } finally {
    await host.dispose();
  }
});

function deferred() {
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  return {promise, resolve: resolvePromise};
}

async function createCancellationHost({
  putFault, beforePromptDispatch, rootEvents = [], rootCancel, rootWhenIdle, descendants = [], listAgents,
  cancellationTimeoutMs = 30, lifecycleBinding,
} = {}) {
  const records = new Map();
  const agents = new Map();
  const ownership = new Map();
  const cancelCounts = new Map();
  let schema, handler, dispose, stream, closed = false, providerDispatches = 0, promptCalls = 0, idleCalls = 0;
  const hostSignal = new AbortController();
  const rootSession = {id: '', header: {}, snapshotEvents: () => rootEvents};
  const rootAgent = {
    id: '',
    session: rootSession,
    cancel(cause, options) {
      cancelCounts.set(this.id, (cancelCounts.get(this.id) ?? 0) + 1);
      if (rootCancel) return rootCancel({cause, options, signal: hostSignal});
      hostSignal.abort(new Error('fixture cancelled'));
    },
    async whenIdle() {
      idleCalls++;
      if (rootWhenIdle) return rootWhenIdle();
    },
  };
  function installDescendants() {
    const byName = new Map([['root', rootAgent]]);
    for (const spec of descendants) {
      const session = {id: spec.id, header: {id: spec.id, origin: 'subagent'}, snapshotEvents: () => spec.events ?? []};
      const child = {
        id: spec.id,
        session,
        cancel() {
          cancelCounts.set(this.id, (cancelCounts.get(this.id) ?? 0) + 1);
          return spec.cancel?.();
        },
        async whenIdle() { return spec.whenIdle?.(); },
      };
      agents.set(child.id, child);
      byName.set(spec.name ?? spec.id, child);
      ownership.set(child.id, byName.get(spec.owner ?? 'root'));
    }
  }
  const ctx = {
    webServer: {host: '127.0.0.1'},
    storageDomain: {async open(config) {
      schema = config.tables.tasks.valueSchema;
      return {
        async close() { closed = true; },
        table: () => ({
          get: id => records.get(id),
          entries: () => records.entries(),
          async put(id, value) {
            const candidate = schema.parse(structuredClone(value));
            if (await putFault?.(candidate)) throw new Error('P03_TEST_STORAGE_FAILURE');
            records.set(id, candidate);
          },
        }),
      };
    }},
    on(event, listener) {
      if (event === 'dispose') dispose = listener;
      if (event === 'llm/stream') stream = listener;
    },
    sessions: {get: id => agents.get(id)?.session},
    agents: {
      get: id => agents.get(id),
      list: () => listAgents ? listAgents([...agents.values()]) : [...agents.values()],
      isOwnedBy: (id, owner) => ownership.get(id) === owner,
    },
    connection: {fetch: {register(spec) { handler = spec.fetch; }}},
    agentPresets: {serviceFor: () => ({schemas: () => developmentRootTools.map(name => ({name}))})},
    tools: {schemas: () => developmentRootTools.map(name => ({name}))},
    sessionProjections: {stateOf: () => ({sandbox: 'workspace-write', approval: 'ask'})},
    sessionController: {
      async create(request) {
        rootSession.id = request.sessionId;
        rootSession.header = {id: request.sessionId};
        rootAgent.id = request.sessionId;
        agents.set(rootAgent.id, rootAgent);
        installDescendants();
        return request;
      },
      async resolveAgent() { return {agent: rootAgent}; },
      async rename() {},
      async selectModel() { return {selected: route}; },
      async prompt(request, signal) {
        signal.throwIfAborted();
        promptCalls++;
        await beforePromptDispatch?.();
        const options = {sessionId: request.sessionId, ...route, reasoningEffort: null, purpose: null,
          tools: developmentRootTools.map(name => ({name})), signal: hostSignal.signal};
        for await (const _chunk of stream(options, async function* () {
          providerDispatches++;
          yield {type: 'finish', reason: {kind: 'completed'}};
        })) { /* consume the real gateway middleware */ }
      },
    },
  };
  await apply(ctx, {cwd: moduleRoot, cancellationTimeoutMs,
    policy: {root: route, allowedRoutes: [route], toolSet: 'development', maxCalls: 8}}, {lifecycleBinding});
  return {records, cancelCounts, get handler() {return handler;}, get dispose() {return dispose;},
    get closed() {return closed;}, get providerDispatches() {return providerDispatches;},
    get promptCalls() {return promptCalls;}, get idleCalls() {return idleCalls;}};
}

test('cancel cleanup errors converge to unknown instead of leaving cancel-requested forever', {timeout: 2000}, async () => {
  const never = new Promise(() => {});
  const host = await createCancellationHost({
    rootCancel() { throw new Error('fixture cleanup failed'); },
    rootWhenIdle: () => never,
  });
  const id = randomUUID();
  try {
    assert.equal((await host.handler(taskRequest(id, 'wait for cancellation'))).status, 200);
    await waitFor(() => host.idleCalls > 0);
    const response = await host.handler(new Request(endpoint + '?action=cancel&id=' + id, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}',
    }));
    assert.equal(response.status, 200);
    const task = await waitFor(async () => {
      const current = await getTask(host.handler, id);
      return current.status === 'unknown' ? current : null;
    }, 1000);
    assert.equal(task.failureCode, 'EXECUTION_UNCONFIRMED');
    assert.equal(task.report.lifecycle.persistence, 'confirmed');
    assert.equal(task.report.lifecycle.stopConfirmation, 'unconfirmed');
  } finally {
    await host.dispose();
  }
});

test('ownership discovery errors converge to an unconfirmed terminal state', {timeout: 2000}, async () => {
  const never = new Promise(() => {});
  const host = await createCancellationHost({
    rootCancel() {},
    rootWhenIdle: () => never,
    listAgents() { throw new Error('fixture ownership lookup failed'); },
  });
  const id = randomUUID();
  try {
    assert.equal((await host.handler(taskRequest(id, 'fail owned-agent discovery'))).status, 200);
    await waitFor(() => host.idleCalls > 0);
    const response = await host.handler(new Request(endpoint + '?action=cancel&id=' + id, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}',
    }));
    assert.equal(response.status, 200);
    const task = await waitFor(async () => {
      const current = await getTask(host.handler, id);
      return current.status === 'unknown' ? current : null;
    }, 1000);
    assert.equal(host.cancelCounts.get('gateway-agent-' + id), 1);
    assert.equal(task.failureCode, 'EXECUTION_UNCONFIRMED');
    assert.equal(task.report.lifecycle.stopConfirmation, 'unconfirmed');
  } finally {
    await host.dispose();
  }
});

test('cancel intent wins a real prompt-dispatch race even when the cancel write fails', {timeout: 2000}, async () => {
  const entered = deferred(), release = deferred();
  let cancelWriteFailures = 0;
  const host = await createCancellationHost({
    beforePromptDispatch: async () => { entered.resolve(); await release.promise; },
    rootCancel() {},
    putFault(record) {
      if (record.status === 'cancel-requested') { cancelWriteFailures++; return true; }
      return false;
    },
  });
  const id = randomUUID();
  try {
    assert.equal((await host.handler(taskRequest(id, 'race cancellation with dispatch'))).status, 200);
    await entered.promise;
    const response = await host.handler(new Request(endpoint + '?action=cancel&id=' + id, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}',
    }));
    assert.equal(response.status, 200);
    const accepted = await response.json();
    assert.equal(accepted.status, 'cancel-requested');
    assert.equal(accepted.report.lifecycle.persistence, 'unconfirmed');
    release.resolve();
    const task = await waitFor(async () => {
      const current = await getTask(host.handler, id);
      return ['stopped', 'unknown'].includes(current.status) ? current : null;
    }, 1000);
    assert.equal(task.status, 'stopped');
    assert.equal(host.providerDispatches, 0);
    assert.equal(task.calls.length, 0);
    assert.equal(cancelWriteFailures, 1);
  } finally {
    release.resolve();
    await host.dispose();
  }
});

test('cancel during boundary persistence cannot reach adapter invocation', {timeout: 2000}, async () => {
  const boundaryEntered = deferred(), releaseBoundary = deferred(), cancelEntered = deferred();
  let heldBoundary = false;
  const host = await createCancellationHost({
    async putFault(record) {
      const call = record.calls[0];
      if (!heldBoundary && record.status === 'running' && call?.adapterBoundaryPreparedAt && call.endedAt === null) {
        heldBoundary = true;
        boundaryEntered.resolve();
        await releaseBoundary.promise;
      }
      return false;
    },
    rootCancel() { cancelEntered.resolve(); },
  });
  const id = randomUUID();
  try {
    assert.equal((await host.handler(taskRequest(id, 'cancel at adapter boundary'))).status, 200);
    await boundaryEntered.promise;
    const cancelResponse = host.handler(new Request(endpoint + '?action=cancel&id=' + id, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}',
    }));
    await cancelEntered.promise;
    releaseBoundary.resolve();
    assert.equal((await cancelResponse).status, 200);
    const task = await waitFor(async () => {
      const current = await getTask(host.handler, id);
      return ['stopped', 'unknown'].includes(current.status) ? current : null;
    }, 1000);
    assert.equal(host.providerDispatches, 0);
    assert.equal(task.calls.length, 1);
    assert.ok(task.calls[0].adapterBoundaryPreparedAt);
    assert.equal(task.calls[0].outcome, 'aborted');
    assert.deepEqual(task.calls[0].httpAttempts,
      {observability:'unavailable', count:null, basis:'no-host-transport-event'});
  } finally {
    releaseBoundary.resolve();
    await host.dispose();
  }
});

test('cancellation targets the exact owned agent tree and bounds an unresponsive descendant', {timeout: 2000}, async () => {
  const never = new Promise(() => {});
  let revealLateDescendant = false;
  const host = await createCancellationHost({
    rootCancel() { revealLateDescendant = true; },
    rootWhenIdle: () => never,
    listAgents: agents => revealLateDescendant ? agents : agents.filter(agent => agent.id !== 'owned-grandchild'),
    descendants: [
      {id: 'owned-child', owner: 'root', whenIdle: async () => {}},
      {id: 'owned-grandchild', owner: 'owned-child', whenIdle: () => never},
      {id: 'unrelated-agent', owner: 'missing', whenIdle: async () => {}},
    ],
  });
  const id = randomUUID();
  try {
    assert.equal((await host.handler(taskRequest(id, 'cancel exact descendants'))).status, 200);
    await waitFor(() => host.idleCalls > 0);
    const response = await host.handler(new Request(endpoint + '?action=cancel&id=' + id, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}',
    }));
    assert.equal(response.status, 200);
    const task = await waitFor(async () => {
      const current = await getTask(host.handler, id);
      return current.status === 'unknown' ? current : null;
    }, 1000);
    assert.equal(host.cancelCounts.get('gateway-agent-' + id), 1);
    assert.equal(host.cancelCounts.get('owned-child'), 1);
    assert.equal(host.cancelCounts.get('owned-grandchild'), 1);
    assert.equal(host.cancelCounts.get('unrelated-agent') ?? 0, 0);
    assert.equal(task.report.lifecycle.stopConfirmation, 'unconfirmed');
  } finally {
    await host.dispose();
  }
});

test('dispose completes bounded cleanup for a task already in cancellation', {timeout: 2000}, async () => {
  const never = new Promise(() => {});
  const host = await createCancellationHost({rootCancel() {}, rootWhenIdle: () => never});
  const id = randomUUID();
  assert.equal((await host.handler(taskRequest(id, 'dispose while cancelling'))).status, 200);
  await waitFor(() => host.idleCalls > 0);
  const response = await host.handler(new Request(endpoint + '?action=cancel&id=' + id, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}',
  }));
  assert.equal(response.status, 200);
  await Promise.race([host.dispose(), new Promise((_, reject) => setTimeout(() => reject(new Error('dispose timeout')), 500))]);
  assert.equal(host.closed, true);
  const task = host.records.get(id);
  assert.equal(task.status, 'unknown');
});

test('restart recovery fails closed when unknown cannot be persisted', async () => {
  const id = randomUUID();
  const durable = {
    id, sessionId: 'gateway-agent-' + id, goal: 'recover only after durable write',
    policy: {root: route, allowedRoutes: [route], toolSet: 'development', maxCalls: 8},
    status: 'running', createdAt: new Date().toISOString(), endedAt: null, artifact: null,
    calls: [], denials: [], toolOperations: [],
  };
  await assert.rejects(createHost({
    initialRecords: [durable],
    putFault: record => record.status === 'unknown',
  }), error => error.code === 'TASK_STORAGE_FAILED' && error.operation === 'recover');
});

test('restart recovery is distinguishable from a current-process unconfirmed local ending', async () => {
  const id = randomUUID();
  const durable = {
    id, sessionId: 'gateway-agent-' + id, goal: 'recover without replay',
    policy: {root: route, allowedRoutes: [route], toolSet: 'development', maxCalls: 8},
    status: 'running', createdAt: new Date().toISOString(), endedAt: null, artifact: null,
    calls: [], denials: [], toolOperations: [],
  };
  const host = await createHost({initialRecords: [durable]});
  try {
    const task = await getTask(host.handler, id);
    assert.equal(task.status, 'unknown');
    assert.deepEqual(task.report.lifecycle, {
      state: 'unknown-after-restart',
      localOutcome: null,
      persistence: 'confirmed',
      stopConfirmation: 'unconfirmed',
    });
  } finally {
    await host.dispose();
  }
});
