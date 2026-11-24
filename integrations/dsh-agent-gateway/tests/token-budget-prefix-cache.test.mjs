import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {copyFile, readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {runInNewContext} from 'node:vm';
import {createRuntimeFixture} from './fixtures/test-runtime.mjs';
import {TaskLedger, summarizeTokenUsage} from '../ledger.js';
import {auditExport, buildPrefixCacheReport, publicTask} from '../report.js';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {path: moduleRoot, remove} = await createRuntimeFixture('token-budget-');
test.after(remove);
for (const file of ['package.json', 'index.js', 'ledger.js', 'report.js', 'panel.js', 'tools.js'])
  await copyFile(resolve(source, file), resolve(moduleRoot, file));
const [{apply}, {developmentRootTools}] = await Promise.all([
  import(pathToFileURL(resolve(moduleRoot, 'index.js'))),
  import(pathToFileURL(resolve(moduleRoot, 'tools.js'))),
]);

const rootRoute = {provider: 'fixture-lead', model: 'planner'};
const childRoute = {provider: 'fixture-deep', model: 'worker'};
const basePolicy = {
  root: rootRoute,
  allowedRoutes: [rootRoute, childRoute],
  allowedChildRoutes: [childRoute],
  maxCalls: 12,
  maxTotalTokens: 1000,
  tokenWarningRatio: 0.8,
};

function setupLedger() {
  const data = new Map();
  const table = {
    get: id => data.get(id),
    entries: () => data.entries(),
    put: async (id, value) => data.set(id, structuredClone(value)),
  };
  return {ledger: new TaskLedger(table), data};
}

async function createRunningTask(ledger, policy = basePolicy, extra = {}) {
  const {task} = await ledger.create({requestId: randomUUID(), goal: 'PRIVATE_TOKEN_TEST_GOAL', ...extra}, policy);
  return (await ledger.startAttempt(task.id, task.attempts[0].id)).task;
}

const panelSource = await readFile(new URL('../panel.js', import.meta.url), 'utf8');
const jsonResponse = (value, ok = true, status = 200) => ({ok, status, json: async () => value});

function panelHarness(fetchImpl) {
  const nodes = new Map();
  const storage = new Map();
  let uuidCounter = 0;
  const element = () => ({
    textContent: '', value: '', children: [], style: {}, dataset: {}, disabled: false,
    append(...children) { this.children.push(...children); if (!this.value) this.value = children[0]?.value ?? ''; },
    replaceChildren(...children) { this.children = [...children]; this.value = children[0]?.value ?? ''; },
    showModal() {}, close() { this.onclose?.(); }, attachShadow() { return root; },
  });
  const dialog = element();
  const root = {
    set innerHTML(_) {},
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    querySelector: () => dialog,
  };
  const document = {
    readyState: 'complete', getElementById: () => null, body: element(),
    createElement: () => element(), createDocumentFragment: () => element(),
    createTextNode: textContent => ({textContent}),
  };
  runInNewContext(panelSource, {
    document, fetch: fetchImpl,
    crypto: {randomUUID: () => '50000000-0000-4000-8000-' + String(++uuidCounter).padStart(12, '0')},
    localStorage: {getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v)},
    setInterval: () => 1, clearInterval() {},
  });
  return {
    nodes,
    open: async () => {
      nodes.get('open').onclick();
      await new Promise(resolveWait => setImmediate(resolveWait));
    },
  };
}

test('tree-level maxTotalTokens enforces cumulative cap across root and child calls without refunding failures', async () => {
  const {ledger} = setupLedger();
  const task = await createRunningTask(ledger);

  const root1 = await ledger.admit(task.id, {sessionId: task.sessionId, parentSessionId: null, ...rootRoute, purpose: null});
  await ledger.finishCall(task.id, root1.id, 'tool-calls', {inputTokens: 300, outputTokens: 100, totalTokens: 400});

  const child1 = await ledger.admit(task.id, {sessionId: 'child-1', parentSessionId: task.sessionId, ...childRoute, purpose: null});
  await ledger.finishCall(task.id, child1.id, 'error', {inputTokens: 350, outputTokens: 50}); // fallback sum = 400 -> total 800

  let projected = publicTask(ledger.get(task.id));
  assert.equal(projected.report.tokenBudget.enabled, true);
  assert.equal(projected.report.tokenBudget.observedTotalTokens, 800);
  assert.equal(projected.report.tokenBudget.remaining, 200);
  assert.equal(projected.report.tokenBudget.warningTriggered, true);
  assert.equal(projected.report.tokenBudget.limitDenied, false);

  const root2 = await ledger.admit(task.id, {sessionId: task.sessionId, parentSessionId: null, ...rootRoute, purpose: null});
  await ledger.finishCall(task.id, root2.id, 'aborted', {inputTokens: 180, outputTokens: 70, totalTokens: 250}); // total 1050 >= 1000

  await assert.rejects(
    ledger.admit(task.id, {sessionId: 'child-2', parentSessionId: task.sessionId, ...childRoute, purpose: null}),
    {code: 'TASK_TOKEN_LIMIT'},
  );
  await ledger.finish(task.id, 'completed', 'premature claim');

  const stored = ledger.get(task.id);
  assert.equal(stored.status, 'limited');
  assert.equal(stored.denials.at(-1).code, 'TASK_TOKEN_LIMIT');

  projected = publicTask(stored);
  assert.equal(projected.status, 'limited');
  assert.equal(projected.artifact, null);
  assert.equal(projected.report.stopReason, 'TASK_TOKEN_LIMIT');
  assert.equal(projected.report.budget.limitDenied, false);
  assert.equal(projected.report.tokenBudget.observedTotalTokens, 1050);
  assert.equal(projected.report.tokenBudget.remaining, 0);
  assert.equal(projected.report.tokenBudget.limitDenied, true);
  assert.equal(projected.report.tokenBudget.everLimitDenied, true);
  assert.equal(projected.report.policySensor.gateLevel, 'L3_HUMAN_REQUIRED');
});

test('missing usage calls stay explicitly unaccounted and are never zero-filled', async () => {
  const {ledger} = setupLedger();
  const task = await createRunningTask(ledger, {...basePolicy, maxTotalTokens: 1000});

  const c1 = await ledger.admit(task.id, {sessionId: task.sessionId, parentSessionId: null, ...rootRoute, purpose: null});
  await ledger.finishCall(task.id, c1.id, 'error', null);
  const c2 = await ledger.admit(task.id, {sessionId: task.sessionId, parentSessionId: null, ...rootRoute, purpose: null});
  await ledger.finishCall(task.id, c2.id, 'stop', {reasoningTokens: 25});
  const c3 = await ledger.admit(task.id, {sessionId: task.sessionId, parentSessionId: null, ...rootRoute, purpose: null});
  await ledger.finishCall(task.id, c3.id, 'stop', {inputTokens: 600, outputTokens: 100, totalTokens: 700}, {finishObserved: true});

  const summary = summarizeTokenUsage(ledger.get(task.id).calls);
  assert.deepEqual(summary, {
    observedTotalTokens: 700,
    directTotalCalls: 1,
    componentFallbackCalls: 0,
    missingUsageCalls: 2,
    measuredCalls: 1,
    coverage: 'partial-usage-missing',
  });

  const report = publicTask(ledger.get(task.id)).report;
  assert.equal(report.tokenBudget.measuredCalls, 1);
  assert.equal(report.tokenBudget.missingUsageCalls, 2);
  assert.equal(report.tokenBudget.coverage, 'partial-usage-missing');
  assert.equal(report.tokenBudget.warningTriggered, false);
  assert.equal(report.observations.usage.missing, 1);
  assert.equal(report.observations.usage.partial, 1);
  assert.equal(report.observations.usage.final, 1);
});

test('continuation token budget enforces authorized increments and rejects exhausted or unconfigured extensions', async () => {
  const {ledger} = setupLedger();
  const task = await createRunningTask(ledger, {...basePolicy, maxTotalTokens: 500});
  const call1 = await ledger.admit(task.id, {sessionId: task.sessionId, parentSessionId: null, ...rootRoute, purpose: null});
  await ledger.finishCall(task.id, call1.id, 'stop', {inputTokens: 400, outputTokens: 120, totalTokens: 520});
  await ledger.finish(task.id, 'completed', 'initial exhausted');

  await assert.rejects(
    ledger.beginContinuation(task.id, {
      continuationId: randomUUID(), kind: 'continue', instruction: 'no extra tokens', additionalCalls: 0, additionalTotalTokens: 0,
    }, [], undefined, [500]),
    {code: 'TASK_TOKEN_LIMIT'},
  );
  await assert.rejects(
    ledger.beginContinuation(task.id, {
      continuationId: randomUUID(), kind: 'continue', instruction: 'wrong increment', additionalCalls: 0, additionalTotalTokens: 250,
    }, [], undefined, [500]),
    {code: 'CONTINUATION_TOKEN_LIMIT_NOT_AUTHORIZED'},
  );

  const contId = randomUUID();
  const continued = await ledger.beginContinuation(task.id, {
    continuationId: contId, kind: 'continue', instruction: 'authorized token boost', additionalCalls: 0, additionalTotalTokens: 500,
  }, [], undefined, [500]);
  assert.equal(continued.created, true);
  assert.equal(continued.attempt.additionalTotalTokens, 500);
  assert.equal(continued.attempt.tokenBudgetBefore, 500);
  assert.equal(continued.attempt.tokenBudgetAfter, 1000);

  await ledger.startAttempt(task.id, contId);
  const call2 = await ledger.admit(task.id, {sessionId: task.sessionId, parentSessionId: null, ...rootRoute, purpose: null});
  await ledger.finishCall(task.id, call2.id, 'stop', {inputTokens: 200, outputTokens: 50, totalTokens: 250});
  await ledger.finish(task.id, 'completed', 'continued cleanly');

  const projected = publicTask(ledger.get(task.id));
  assert.equal(projected.report.tokenBudget.initialMaxTotalTokens, 500);
  assert.equal(projected.report.tokenBudget.addedTotalTokens, 500);
  assert.equal(projected.report.tokenBudget.maxTotalTokens, 1000);
  assert.equal(projected.report.tokenBudget.remaining, 230);
  assert.equal(projected.report.attempts[0].tokenBudgetAfter, 500);
  assert.equal(projected.report.attempts[1].tokenBudgetBefore, 500);
  assert.equal(projected.report.attempts[1].tokenBudgetAfter, 1000);

  // Unconfigured token limit refuses token increments.
  const noTokenTask = await createRunningTask(ledger, {root: rootRoute, allowedRoutes: [rootRoute], maxCalls: 4});
  await ledger.finish(noTokenTask.id, 'completed', 'ok');
  await assert.rejects(
    ledger.beginContinuation(noTokenTask.id, {
      continuationId: randomUUID(), kind: 'continue', instruction: 'try token add', additionalCalls: 0, additionalTotalTokens: 500,
    }, [], undefined, [500]),
    {code: 'TOKEN_LIMIT_NOT_AUTHORIZED'},
  );

  // Overshoot case: an authorized increment that still leaves observedTotalTokens >= newCap is rejected upfront.
  const overshootTask = await createRunningTask(ledger, {...basePolicy, maxTotalTokens: 500});
  const overCall = await ledger.admit(overshootTask.id, {sessionId: overshootTask.sessionId, parentSessionId: null, ...rootRoute, purpose: null});
  await ledger.finishCall(overshootTask.id, overCall.id, 'stop', {inputTokens: 1000, outputTokens: 200, totalTokens: 1200});
  await ledger.finish(overshootTask.id, 'completed', 'large overshoot');
  await assert.rejects(
    ledger.beginContinuation(overshootTask.id, {
      continuationId: randomUUID(), kind: 'continue', instruction: 'insufficient boost', additionalCalls: 0, additionalTotalTokens: 500,
    }, [], undefined, [500, 1000]),
    {code: 'TASK_TOKEN_LIMIT'},
  );
  const sufficient = await ledger.beginContinuation(overshootTask.id, {
    continuationId: randomUUID(), kind: 'continue', instruction: 'sufficient boost', additionalCalls: 0, additionalTotalTokens: 1000,
  }, [], undefined, [500, 1000]);
  assert.equal(sufficient.created, true);
  assert.equal(sufficient.attempt.tokenBudgetAfter, 1500);
});

test('prefixCache computes exact hit rate, leaves missing fields unreported, and flags same-session cache drops', async () => {
  const {ledger} = setupLedger();
  const task = await createRunningTask(ledger, {root: rootRoute, allowedRoutes: [rootRoute, childRoute], allowedChildRoutes: [childRoute], maxCalls: 12});

  const c1 = await ledger.admit(task.id, {sessionId: task.sessionId, parentSessionId: null, ...rootRoute, purpose: null});
  await ledger.finishCall(task.id, c1.id, 'tool-calls', {inputTokens: 150, cacheReadTokens: 850, cacheWriteTokens: 50, outputTokens: 20}); // 0.85

  // Different session -> cannot trigger cross-turn drop on root.
  const child = await ledger.admit(task.id, {sessionId: 'child-session', parentSessionId: task.sessionId, ...childRoute, purpose: null});
  await ledger.finishCall(task.id, child.id, 'stop', {inputTokens: 900, cacheReadTokens: 100, outputTokens: 10}); // 0.10

  // Missing cacheReadTokens -> unreported (never counted as 0%).
  const cMissing = await ledger.admit(task.id, {sessionId: task.sessionId, parentSessionId: null, ...rootRoute, purpose: null});
  await ledger.finishCall(task.id, cMissing.id, 'tool-calls', {inputTokens: 500, outputTokens: 20});

  // Tiny prompt (<100 tokens) -> too small to raise drop alert on this child session/route.
  const cTiny = await ledger.admit(task.id, {sessionId: 'tiny-session', parentSessionId: task.sessionId, ...childRoute, purpose: null});
  await ledger.finishCall(task.id, cTiny.id, 'tool-calls', {inputTokens: 10, cacheReadTokens: 90, outputTokens: 5}); // 0.90, total 100
  const cTiny2 = await ledger.admit(task.id, {sessionId: 'tiny-session', parentSessionId: task.sessionId, ...childRoute, purpose: null});
  await ledger.finishCall(task.id, cTiny2.id, 'stop', {inputTokens: 40, cacheReadTokens: 10, outputTokens: 5}); // 0.20, total 50 (<100 -> no alert)

  // Same (sessionId, provider, model) drop on root: 0.85 -> 0.20 with promptTotal=1000 >= 100 -> alert!
  const c2 = await ledger.admit(task.id, {sessionId: task.sessionId, parentSessionId: null, ...rootRoute, purpose: null});
  await ledger.finishCall(task.id, c2.id, 'stop', {inputTokens: 800, cacheReadTokens: 200, cacheWriteTokens: 30, outputTokens: 25});

  await ledger.finish(task.id, 'completed', 'done');
  const stored = ledger.get(task.id);
  const pc = buildPrefixCacheReport(stored.calls);
  assert.equal(pc.schema, 'gateway-prefix-cache-v1');
  assert.equal(pc.eligibleCalls, 5);
  assert.equal(pc.unreportedCalls, 1);
  assert.equal(pc.cacheReadTokensSum, 1250);
  assert.equal(pc.uncachedInputTokensSum, 1900);
  assert.equal(pc.cacheWriteTokensSum, 80);
  assert.equal(pc.overallHitRate, 0.3968);
  assert.equal(pc.dropAlertCount, 1);
  assert.deepEqual(pc.dropAlerts, [{
    code: 'PREFIX_CACHE_DROP',
    sessionId: task.sessionId,
    callId: c2.id,
    previousCallId: c1.id,
    previousHitRate: 0.85,
    currentHitRate: 0.2,
    dropDelta: 0.65,
  }]);

  const exported = auditExport([stored]);
  assert.deepEqual(exported.tasks[0].prefixCache, pc);
  assert.doesNotMatch(JSON.stringify(exported), /PRIVATE_TOKEN_TEST_GOAL/);
});

test('runtime apply enforces maxTotalTokens over llm/stream and authorizes token limits on HTTP endpoints', async () => {
  const records = new Map();
  const agents = new Map();
  let handler, dispose, stream, turn = 0;
  const ctx = {
    webServer: {host: '127.0.0.1'},
    storageDomain: {async open(config) {
      const schema = config.tables.tasks.valueSchema;
      return {
        async close() {},
        table: () => ({
          get: id => records.get(id),
          entries: () => records.entries(),
          async put(id, value) { records.set(id, schema.parse(structuredClone(value))); },
        }),
      };
    }},
    on(event, listener) {
      if (event === 'dispose') dispose = listener;
      if (event === 'llm/stream') stream = listener;
    },
    sessions: {get: id => agents.get(id)?.session},
    agents: {get: id => agents.get(id), list: () => [...agents.values()], isOwnedBy: () => false},
    connection: {fetch: {register(spec) { handler = spec.fetch; }}},
    agentPresets: {serviceFor: () => ({schemas: () => developmentRootTools.map(name => ({name}))})},
    tools: {schemas: () => developmentRootTools.map(name => ({name}))},
    sessionProjections: {stateOf: () => ({sandbox: 'workspace-write', approval: 'ask'})},
    sessionController: {
      async create(request) {
        const events = [];
        const session = {id: request.sessionId, header: {id: request.sessionId}, snapshotEvents: () => structuredClone(events)};
        const agent = {id: request.sessionId, session, cancel() {}, async whenIdle() {}};
        agents.set(request.sessionId, agent);
        session.events = events;
        return request;
      },
      async resolveAgent(id) { return {agent: agents.get(id)}; },
      async rename() {},
      async selectModel() { return {selected: rootRoute}; },
      async prompt(request, signal) {
        turn++;
        const agent = agents.get(request.sessionId);
        const options = {
          sessionId: request.sessionId, ...rootRoute, reasoningEffort: null, purpose: null,
          tools: developmentRootTools.map(name => ({name})), signal,
        };
        try {
          for await (const _chunk of stream(options, async function* () {
            yield {type: 'usage', usage: {inputTokens: 100, cacheReadTokens: 400, outputTokens: 50, totalTokens: 550}};
            yield {type: 'finish', reason: {kind: 'completed'}};
          })) {}
          // Attempt second admission in the same turn -> should fail with TASK_TOKEN_LIMIT (>= 500).
          for await (const _chunk of stream(options, async function* () {
            yield {type: 'finish', reason: {kind: 'completed'}};
          })) {}
        } catch (error) {
          agent.session.events.push({seq: turn * 10, type: 'turn/end', data: {turn, reason: {kind: 'error', error: {code: error.code}}}});
          return;
        }
        agent.session.events.push({seq: turn * 10, type: 'turn/end', data: {turn, reason: {kind: 'completed'}}});
      },
    },
  };

  await apply(ctx, {
    cwd: moduleRoot,
    authorizedTaskMaxTotalTokens: [500, 1000],
    authorizedContinuationTokenIncrements: [500],
    policy: {root: rootRoute, allowedRoutes: [rootRoute], toolSet: 'development', maxCalls: 8, maxTotalTokens: 500, tokenWarningRatio: 0.75},
  });

  try {
    const configRes = await handler(new Request('http://127.0.0.1/api/gateway-agent-tasks'));
    const configJson = await configRes.json();
    assert.deepEqual(configJson.authorizedTaskMaxTotalTokens, [500, 1000]);
    assert.deepEqual(configJson.authorizedContinuationTokenIncrements, [500]);

    const badRes = await handler(new Request('http://127.0.0.1/api/gateway-agent-tasks', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({requestId: randomUUID(), goal: 'unauthorized token limit', maxTotalTokens: 777}),
    }));
    assert.equal(badRes.status, 400);
    assert.equal((await badRes.json()).error, 'TOKEN_LIMIT_NOT_AUTHORIZED');

    const id = randomUUID();
    const okRes = await handler(new Request('http://127.0.0.1/api/gateway-agent-tasks', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({requestId: id, goal: 'bounded token run', maxTotalTokens: 500}),
    }));
    assert.equal(okRes.status, 200);

    let settled;
    for (let i = 0; i < 100; i++) {
      const r = await handler(new Request(`http://127.0.0.1/api/gateway-agent-tasks?id=${id}`));
      settled = await r.json();
      if (!['queued', 'running', 'cancel-requested'].includes(settled.status)) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
    assert.equal(settled.status, 'limited');
    assert.equal(settled.report.stopReason, 'TASK_TOKEN_LIMIT');
    assert.equal(settled.report.tokenBudget.observedTotalTokens, 550);
    assert.equal(settled.report.observations.prefixCache.overallHitRate, 0.8);
  } finally {
    await dispose();
  }
});

test('panel budget text displays tokenBudget and prefixCache when active and stays unchanged when inactive', async () => {
  const simplePolicy = {root: rootRoute, allowedRoutes: [rootRoute], toolSet: 'development', maxCalls: 8};
  const legacyTask = publicTask({
    id: '50000000-0000-4000-8000-000000000001', sessionId: 'gateway-agent-legacy',
    goal: 'legacy', workspaceId: 'default', policy: simplePolicy, status: 'completed',
    createdAt: '2026-11-23T00:00:00.000Z', endedAt: '2026-11-23T00:01:00.000Z', artifact: 'OK',
    calls: [], denials: [], toolOperations: [], approvalOperations: [],
  });
  const activeTask = publicTask({
    id: '50000000-0000-4000-8000-000000000002', sessionId: 'gateway-agent-active',
    goal: 'token + cache', workspaceId: 'default', policy: {...simplePolicy, maxTotalTokens: 1000, tokenWarningRatio: 0.8},
    status: 'completed', createdAt: '2026-11-23T00:00:00.000Z', endedAt: '2026-11-23T00:01:00.000Z', artifact: 'OK',
    calls: [
      {id: 'c1', sessionId: 'gateway-agent-active', parentSessionId: null, ...rootRoute, purpose: null, outcome: 'tool-calls',
        admittedAt: '2026-11-23T00:00:01.000Z', usageStatus: 'final', usage: {inputTokens: 100, cacheReadTokens: 700, totalTokens: 800}},
      {id: 'c2', sessionId: 'gateway-agent-active', parentSessionId: null, ...rootRoute, purpose: null, outcome: 'stop',
        admittedAt: '2026-11-23T00:00:02.000Z', usageStatus: 'final', usage: {inputTokens: 100, cacheReadTokens: 100, totalTokens: 200}},
      {id: 'c3', sessionId: 'gateway-agent-active', parentSessionId: null, ...rootRoute, purpose: null, outcome: 'error',
        admittedAt: '2026-11-23T00:00:03.000Z', usageStatus: 'missing', usage: null},
    ],
    denials: [], toolOperations: [], approvalOperations: [],
  });

  const {nodes, open} = panelHarness(async () => jsonResponse({
    policy: simplePolicy, authorizedTaskMaxCalls: [8],
    workspaces: [{id: 'default', label: 'Fixture workspace'}],
    capabilities: {commandExecution: 'disabled', validation: 'not-established'},
    tasks: [legacyTask, activeTask],
  }));
  await open();

  const select = id => { nodes.get('tasks').value = id; nodes.get('tasks').onchange(); };
  select(legacyTask.id);
  assert.equal(
    nodes.get('budget').textContent,
    '初始额度 8；显式追加 0；累计上限 8；已用 0；剩余 8；历史限额拒绝 无。',
  );

  select(activeTask.id);
  assert.match(nodes.get('budget').textContent, /Token 预算：已观测 1000\/1000（剩余 0，另有 1 次缺失用量未计入，已达告警阈值）。/);
  assert.match(nodes.get('budget').textContent, /Prefix-Cache 命中率：80\.0%（2 次可观测，跨轮击穿告警 1 次）。/);
});

test('partial usage never shrinks observed totalTokens, input-only stays partial-usage-missing, and auxiliary calls do not skew prefixCache drops', async () => {
  const {ledger} = setupLedger();
  const task = await createRunningTask(ledger, {...basePolicy, maxTotalTokens: 500});

  const c1 = await ledger.admit(task.id, {sessionId: task.sessionId, parentSessionId: null, ...rootRoute, purpose: null});
  await ledger.recordUsage(task.id, c1.id, {inputTokens: 150, cacheReadTokens: 850, totalTokens: 550});
  // Later partial snapshot without totalTokens summing to 400 (< 550) must not reduce observed consumption.
  await ledger.finishCall(task.id, c1.id, 'tool-calls', {inputTokens: 300, outputTokens: 100}, {finishObserved: true});
  assert.equal(summarizeTokenUsage(ledger.get(task.id).calls).observedTotalTokens, 550);
  await assert.rejects(
    ledger.admit(task.id, {sessionId: task.sessionId, parentSessionId: null, ...rootRoute, purpose: null}),
    {code: 'TASK_TOKEN_LIMIT'},
  );
  await ledger.finish(task.id, 'completed', 'limited');

  // Auxiliary call on same (sessionId, provider, model) with low hit rate must not create false PREFIX_CACHE_DROP for root.
  const auxTask = await createRunningTask(ledger, {...basePolicy, maxTotalTokens: 10000});
  const r1 = await ledger.admit(auxTask.id, {sessionId: auxTask.sessionId, parentSessionId: null, ...rootRoute, purpose: null});
  await ledger.finishCall(auxTask.id, r1.id, 'tool-calls', {inputTokens: 150, cacheReadTokens: 850, outputTokens: 20}, {finishObserved: true});
  const aux = await ledger.admit(auxTask.id, {sessionId: auxTask.sessionId, parentSessionId: null, ...rootRoute, purpose: 'compaction'});
  await ledger.finishCall(auxTask.id, aux.id, 'stop', {inputTokens: 900, cacheReadTokens: 100, outputTokens: 20}, {finishObserved: true});
  const r2 = await ledger.admit(auxTask.id, {sessionId: auxTask.sessionId, parentSessionId: null, ...rootRoute, purpose: null});
  await ledger.finishCall(auxTask.id, r2.id, 'stop', {inputTokens: 200, cacheReadTokens: 800, outputTokens: 20}, {finishObserved: true});
  await ledger.finish(auxTask.id, 'completed', 'done');

  const pc = buildPrefixCacheReport(ledger.get(auxTask.id).calls);
  assert.equal(pc.dropAlertCount, 0);

  // Input-only partial observation must not report coverage: 'complete'.
  const inputOnlySummary = summarizeTokenUsage([{usage: {inputTokens: 100}}]);
  assert.equal(inputOnlySummary.observedTotalTokens, 100);
  assert.equal(inputOnlySummary.coverage, 'partial-usage-missing');
});

test('failed usage persistence under active maxTotalTokens blocks subsequent llm/stream admissions', async () => {
  const records = new Map();
  const agents = new Map();
  let handler, dispose, stream, adapterDispatches = 0, secondAdmissionError = null;
  const ctx = {
    webServer: {host: '127.0.0.1'},
    storageDomain: {async open(config) {
      const schema = config.tables.tasks.valueSchema;
      return {
        async close() {},
        table: () => ({
          get: id => records.get(id),
          entries: () => records.entries(),
          async put(id, value) {
            const candidate = schema.parse(structuredClone(value));
            if (candidate.status === 'running' && candidate.calls[0]?.endedAt === null &&
                (candidate.calls[0]?.usageObservationCount ?? 0) > 0) {
              throw new Error('SYNTHETIC_USAGE_PERSIST_FAILURE');
            }
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
    agents: {get: id => agents.get(id), list: () => [...agents.values()], isOwnedBy: () => false},
    connection: {fetch: {register(spec) { handler = spec.fetch; }}},
    agentPresets: {serviceFor: () => ({schemas: () => developmentRootTools.map(name => ({name}))})},
    tools: {schemas: () => developmentRootTools.map(name => ({name}))},
    sessionProjections: {stateOf: () => ({sandbox: 'workspace-write', approval: 'ask'})},
    sessionController: {
      async create(request) {
        const events = [];
        const session = {id: request.sessionId, header: {id: request.sessionId}, snapshotEvents: () => structuredClone(events)};
        const agent = {id: request.sessionId, session, cancel() {}, async whenIdle() {}};
        agents.set(request.sessionId, agent);
        session.events = events;
        return request;
      },
      async resolveAgent(id) { return {agent: agents.get(id)}; },
      async rename() {},
      async selectModel() { return {selected: rootRoute}; },
      async prompt(request, signal) {
        const agent = agents.get(request.sessionId);
        const options = {
          sessionId: request.sessionId, ...rootRoute, reasoningEffort: null, purpose: null,
          tools: developmentRootTools.map(name => ({name})), signal,
        };
        for await (const _chunk of stream(options, async function* () {
          adapterDispatches++;
          yield {type: 'usage', usage: {inputTokens: 450, outputTokens: 150, totalTokens: 600}};
          yield {type: 'finish', reason: {kind: 'completed'}};
        })) {}
        try {
          for await (const _chunk of stream(options, async function* () {
            adapterDispatches++;
            yield {type: 'finish', reason: {kind: 'completed'}};
          })) {}
        } catch (error) {
          secondAdmissionError = error.code;
        }
        agent.session.events.push({seq: 10, type: 'turn/end', data: {turn: 1, reason: {kind: 'completed'}}});
      },
    },
  };

  await apply(ctx, {
    cwd: moduleRoot,
    policy: {root: rootRoute, allowedRoutes: [rootRoute], toolSet: 'development', maxCalls: 8, maxTotalTokens: 500},
  });
  try {
    const id = randomUUID();
    const res = await handler(new Request('http://127.0.0.1/api/gateway-agent-tasks', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({requestId: id, goal: 'usage persistence failure blocks second call'}),
    }));
    assert.equal(res.status, 200);
    let settled;
    for (let i = 0; i < 100; i++) {
      settled = await (await handler(new Request(`http://127.0.0.1/api/gateway-agent-tasks?id=${id}`))).json();
      if (!['queued', 'running', 'cancel-requested'].includes(settled.status)) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
    assert.equal(adapterDispatches, 1);
    assert.equal(secondAdmissionError, 'EVIDENCE_STORAGE_FAILED');
    assert.equal(settled.status, 'unknown');
    assert.equal(settled.failureCode, 'EVIDENCE_STORAGE_FAILED');
  } finally {
    await dispose();
  }
});
