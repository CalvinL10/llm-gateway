import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRuntimeFixture } from './fixtures/test-runtime.mjs';
import { TaskLedger } from '../ledger.js';
import {
  analyzeTestMetrics,
  auditExport,
  auditTask,
  buildTraceTree,
  classifyRepoPath,
  evaluatePolicySensor,
  extractTextClaims,
  publicTask,
  safePolicySensor,
} from '../report.js';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {runtime, path: moduleRoot, remove: removeFixture} = await createRuntimeFixture('policy-sensor-');
test.after(removeFixture);
for (const file of ['package.json', 'index.js', 'ledger.js', 'report.js', 'panel.js', 'tools.js'])
  await copyFile(resolve(source, file), resolve(moduleRoot, file));
const [{apply}, {developmentRootTools}] = await Promise.all([
  import(pathToFileURL(resolve(moduleRoot, 'index.js'))),
  import(pathToFileURL(resolve(moduleRoot, 'tools.js'))),
]);
const route = {provider: 'fixture-development', model: 'scripted'};
const childRoute = {provider: 'fixture-deep', model: 'worker'};
const endpoint = 'http://127.0.0.1/api/gateway-agent-tasks';

const trustedGit = (() => {
  const exe = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = resolve(dir, exe);
    try { if (statSync(candidate).isFile()) return candidate; } catch {}
  }
  return 'git';
})();

function git(cwd, args) {
  return execFileSync(trustedGit, ['-C', cwd, ...args], {cwd: dirname(trustedGit), windowsHide: true, encoding: 'utf8'});
}

async function createTempGitRepo(t) {
  const dir = await mkdtemp(resolve(tmpdir(), 'gateway-sensor-git-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'sensor-test@example.invalid']);
  git(dir, ['config', 'user.name', 'Sensor Test']);
  await mkdir(resolve(dir, 'src'), {recursive: true});
  await mkdir(resolve(dir, 'tests'), {recursive: true});
  await writeFile(resolve(dir, 'package.json'), '{"name":"fixture-app","version":"1.0.0"}\n');
  await writeFile(resolve(dir, 'src/app.js'), 'export const add = (a, b) => a + b;\n');
  await writeFile(
    resolve(dir, 'tests/app.test.mjs'),
    "import assert from 'node:assert/strict';\nassert.equal(1 + 1, 2);\nassert.equal(2 + 2, 4);\n",
  );
  await writeFile(
    resolve(dir, 'tests/PRIVATE_SECRET_CASE.test.mjs'),
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\ntest('case', () => {\n  assert.equal(1, 1);\n  assert.equal(2, 2);\n});\n",
  );
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

async function createSensorHost({workspaceCwd, scenario, holdOnPrompt = false}) {
  const records = new Map();
  const agents = new Map();
  const listeners = new Map();
  let handler, dispose, turnCount = 0;
  const promptEntered = Promise.withResolvers();
  const promptRelease = Promise.withResolvers();

  const ctx = {
    webServer: {host: '127.0.0.1'},
    storageDomain: {
      async open(config) {
        const schema = config.tables.tasks.valueSchema;
        return {
          async close() {},
          table: () => ({
            get: id => records.get(id),
            entries: () => records.entries(),
            async put(id, value) {
              records.set(id, schema.parse(structuredClone(value)));
            },
          }),
        };
      },
    },
    on(event, listener) {
      listeners.set(event, listener);
      if (event === 'dispose') dispose = listener;
    },
    workspaceRegistry: {async create(cwd) { return {id: cwd, async attachSession() {}}; }},
    sessions: {get: id => agents.get(id)?.session},
    agents: {
      get: id => agents.get(id),
      list: () => [...agents.values()],
      isOwnedBy: () => false,
    },
    connection: {fetch: {register(spec) { handler = spec.fetch; }}},
    agentPresets: {serviceFor: () => ({schemas: () => developmentRootTools.map(name => ({name}))})},
    tools: {schemas: () => developmentRootTools.map(name => ({name}))},
    sessionProjections: {stateOf: session => ({sandbox: session.sandbox, approval: 'ask'})},
    sessionController: {
      async create(request) {
        const events = [];
        const session = {
          id: request.sessionId,
          header: {id: request.sessionId, cwd: request.cwd},
          sandbox: 'workspace-write',
          snapshotEvents() { return structuredClone(events); },
          append(type, data, sourceEventSeqs) {
            const event = {seq: events.length + 1, type, data, time: Date.now(), sourceEventSeqs};
            events.push(event);
            if (type === 'sandbox/mode') this.sandbox = data.mode;
            listeners.get('session/event')?.(session, event);
            return event;
          },
        };
        const agent = {
          id: request.sessionId,
          session,
          cancel() { agent.controller?.abort(new Error('cancelled')); },
          whenIdle() { return agent.idle ?? Promise.resolve(); },
          ctx: {tools: {restrict() { return () => {}; }}},
        };
        agents.set(agent.id, agent);
        return request;
      },
      async resolveAgent(id) { return {agent: agents.get(id)}; },
      async rename() {},
      async selectModel() { return {selected: route}; },
      async prompt(request, signal) {
        signal.throwIfAborted();
        const agent = agents.get(request.sessionId);
        const session = agent.session;
        const idle = Promise.withResolvers();
        agent.idle = idle.promise;
        agent.controller = new AbortController();
        session.append('user/message', {source: {kind: 'user', rpcId: request.requestId}});
        turnCount++;

        (async () => {
          try {
            if (holdOnPrompt) {
              promptEntered.resolve();
              await promptRelease.promise;
            }
            const options = {
              sessionId: session.id, ...route, reasoningEffort: null,
              purpose: null, tools: developmentRootTools.map(name => ({name})),
              signal: agent.controller.signal,
            };
            for await (const _chunk of listeners.get('llm/stream')(options, async function* () {
              yield {type: 'usage', usage: {inputTokens: 10, outputTokens: 5, totalTokens: 15}};
              yield {type: 'finish', reason: {kind: 'completed'}};
            })) {}

            const emitTool = async (name, {isError = false, pwshExitCode = null} = {}) => {
              const callId = randomUUID();
              const call = session.append('tool/call', {callId, name, turn: turnCount, step: 1});
              session.append('tool/result', {
                message: {content: [{type: 'tool-result', toolCallId: callId, isError, content: 'ok'}]},
              }, [call.seq]);
              if (name === 'pwsh' && pwshExitCode !== null) {
                listeners.get('tools/result')?.(
                  {name: 'pwsh', callId, agent},
                  {isError: false, value: {kind: 'foreground', exitCode: pwshExitCode}},
                );
              }
            };

            const finalText = await scenario({workspaceCwd, emitTool, session});
            const kind = agent.controller.signal.aborted ? 'aborted' : 'completed';
            if (kind === 'completed') {
              session.append('assistant/message', {
                turn: turnCount,
                message: {content: [{type: 'text', text: finalText}]},
              });
            }
            session.append('turn/end', {turn: turnCount, reason: {kind}});
          } catch {} finally {
            idle.resolve();
          }
        })();
      },
    },
  };

  await apply(ctx, {
    cwd: workspaceCwd,
    cancellationTimeoutMs: 30,
    policy: {root: route, allowedRoutes: [route], toolSet: 'development', maxCalls: 8},
  });

  async function api(path = endpoint, body) {
    const res = await handler(new Request(`http://127.0.0.1${path}`, body === undefined ? {} : {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    }));
    assert.equal(res.status, 200);
    return res.json();
  }

  async function runTask(goal = 'execute scenario') {
    const id = randomUUID();
    await api(endpoint, {requestId: id, goal});
    for (let i = 0; i < 400; i++) {
      const task = await api(`${endpoint}?id=${id}`);
      if (!['queued', 'running', 'cancel-requested'].includes(task.status)) return task;
      await new Promise(r => setTimeout(r, 15));
    }
    assert.fail('Sensor host task did not settle');
  }

  return {
    api,
    runTask,
    promptEntered,
    promptRelease,
    async dispose() {
      promptRelease.resolve();
      await dispose?.();
    },
  };
}

test('buildTraceTree builds causal OTel lineage across attempts, child tools, approvals, denials and sensors with strict redaction', async () => {
  const data = new Map();
  const table = {
    get: id => data.get(id),
    entries: () => data.entries(),
    put: async (id, value) => data.set(id, structuredClone(value)),
  };
  const ledger = new TaskLedger(table);
  const id = randomUUID();
  const policy = {
    root: route,
    allowedRoutes: [route, childRoute],
    allowedChildRoutes: [childRoute],
    toolSet: 'development',
    maxCalls: 8,
  };
  const {task} = await ledger.create({requestId: id, goal: 'SECRET_GOAL_TEXT'}, policy);
  await ledger.startAttempt(id, id);

  const rootCall = await ledger.admit(id, {
    sessionId: task.sessionId, parentSessionId: null, ...route, purpose: null,
  });
  const baseMs = Date.parse(rootCall.admittedAt);
  const ts = offset => new Date(baseMs + offset).toISOString();
  await ledger.recordTool(id, {
    sessionId: task.sessionId, seq: 1, name: 'subagent', outcome: 'pending',
    turn: 1, step: 1, startedAt: rootCall.admittedAt,
  });
  const childCall = await ledger.admit(id, {
    sessionId: 'child-session-1', parentSessionId: task.sessionId, ...childRoute, purpose: null,
  });
  const childMs = Date.parse(childCall.admittedAt);
  const childTs = offset => new Date(childMs + offset).toISOString();
  await ledger.recordTool(id, {
    sessionId: 'child-session-1', seq: 1, name: 'read', outcome: 'succeeded',
    resultSeq: 2, startedAt: childCall.admittedAt, endedAt: childTs(500),
    arguments: 'SECRET_FILE.txt',
  });
  await ledger.finishCall(id, childCall.id, 'stop', {inputTokens: 12, outputTokens: 4, totalTokens: 16},
    {finishObserved: true, endedAt: childTs(1000)});
  await ledger.recordTool(id, {
    sessionId: task.sessionId, seq: 1, name: 'subagent', outcome: 'succeeded',
    resultSeq: 3, endedAt: childTs(1500),
  });
  await ledger.recordTool(id, {
    sessionId: task.sessionId, seq: 4, name: 'edit', outcome: 'succeeded',
    resultSeq: 6, startedAt: ts(2000), endedAt: ts(3000),
    arguments: 'SECRET_ARG',
  });
  await ledger.recordApproval(id, {
    sessionId: task.sessionId, seq: 5, name: 'edit', outcome: 'allowed-once',
    askedAt: ts(2200), decidedAt: ts(2500), decisionSeq: 6,
  });
  await ledger.recordTool(id, {
    sessionId: task.sessionId, seq: 7, name: 'pwsh', outcome: 'succeeded',
    exitCode: 0, resultSeq: 8, startedAt: ts(4000), endedAt: ts(5000),
  });
  await ledger.finishCall(id, rootCall.id, 'stop', {inputTokens: 20, outputTokens: 10, totalTokens: 30},
    {finishObserved: true, endedAt: ts(6000)});
  await assert.rejects(
    ledger.admit(id, {sessionId: task.sessionId, parentSessionId: null, provider: 'forbidden', model: 'bad', purpose: null}),
    {code: 'ROUTE_NOT_AUTHORIZED'},
  );
  await ledger.finish(id, 'completed', 'SECRET_ARTIFACT_TEXT', null, null, ({task: t, attempt, finalStatus, finalArtifact, endedAt}) =>
    evaluatePolicySensor({task: t, attempt, status: finalStatus, finalText: finalArtifact, evaluatedAt: endedAt}));

  const continuationId = randomUUID();
  await ledger.beginContinuation(id, {continuationId, kind: 'continue', instruction: 'SECRET_CONTINUATION_INSTRUCTION', additionalCalls: 0});
  await ledger.startAttempt(id, continuationId);
  const contCall = await ledger.admit(id, {sessionId: task.sessionId, parentSessionId: null, ...route, purpose: null});
  await ledger.finishCall(id, contCall.id, 'stop', {inputTokens: 5, outputTokens: 2, totalTokens: 7}, {finishObserved: true});
  await ledger.finish(id, 'completed', 'SECRET_SECOND_ARTIFACT', null, null, ({task: t, attempt, finalStatus, finalArtifact, endedAt}) =>
    evaluatePolicySensor({task: t, attempt, status: finalStatus, finalText: finalArtifact, evaluatedAt: endedAt}));

  const stored = ledger.get(id);
  const pub = publicTask(stored);
  const exported = auditExport([stored]);
  const trace = exported.tasks[0].trace;

  assert.equal(exported.format, 'gateway-agent-audit-v1');
  assert.equal(trace.schema, 'gateway-otel-trace-v1');
  assert.equal(trace.traceId, id);
  assert.equal(trace.rootSpanId, `task:${id}`);
  assert.equal(trace.summary.orphanSpans, 0);
  assert.equal(trace.summary.attemptSpans, 2);
  assert.equal(trace.summary.llmSpans, 3);
  assert.equal(trace.summary.toolSpans, 4);
  assert.equal(trace.summary.approvalSpans, 1);
  assert.equal(trace.summary.denialSpans, 1);
  assert.equal(trace.summary.sensorSpans, 2);
  assert.ok(trace.summary.maxDepth >= 5);
  assert.deepEqual(pub.report.traceSummary, trace.summary);
  assert.deepEqual(buildTraceTree(stored).summary, trace.summary);

  const childLlmSpan = trace.spans.find(span => span.spanId === `llm:${childCall.id}`);
  assert.equal(childLlmSpan.parentSpanId, `tool:${task.sessionId}:1`);
  assert.equal(childLlmSpan.attributes.lineageBasis, 'subagent-tool');

  const approvalSpan = trace.spans.find(span => span.spanId === `approval:${task.sessionId}:5`);
  assert.equal(approvalSpan.parentSpanId, `tool:${task.sessionId}:4`);
  assert.equal(approvalSpan.attributes.lineageBasis, 'tool-call');

  const firstSensorSpan = trace.spans.find(span => span.spanId === `sensor:${id}`);
  assert.equal(firstSensorSpan.parentSpanId, `attempt:${id}`);
  assert.equal(firstSensorSpan.status, 'L1_AUTO_PASS');

  const serializedAudit = JSON.stringify(exported);
  const serializedSensorAndTrace = JSON.stringify({
    policySensor: pub.report.policySensor,
    traceSummary: pub.report.traceSummary,
  });
  for (const secret of ['SECRET_GOAL', 'SECRET_CONTINUATION', 'SECRET_ARTIFACT', 'SECRET_SECOND_ARTIFACT', 'SECRET_ARG', 'SECRET_FILE']) {
    assert.equal(serializedAudit.includes(secret), false, `audit leaked ${secret}`);
    assert.equal(serializedSensorAndTrace.includes(secret), false, `sensor/trace leaked ${secret}`);
  }
});

test('static path classification, test tamper metrics, and claim negation avoid false positives', () => {
  assert.equal(classifyRepoPath('tests/foo.test.mjs'), 'test');
  assert.equal(classifyRepoPath('src/math_test.py'), 'test');
  assert.equal(classifyRepoPath('src/test_math.py'), 'test');
  assert.equal(classifyRepoPath('presets/llm-gateway-single/agent.cordis.yml'), 'security');
  assert.equal(classifyRepoPath('integrations/dsh-agent-gateway/tools.js'), 'security');
  assert.equal(classifyRepoPath('package.json'), 'contract');
  assert.equal(classifyRepoPath('docs/architecture.md'), 'docs');
  assert.equal(classifyRepoPath('src/app.js'), 'source');

  assert.equal(classifyRepoPath('.env.production'), 'security');
  assert.equal(classifyRepoPath('config/service.key'), 'security');

  const jsBefore = analyzeTestMetrics(`
    import assert from 'node:assert/strict';
    const example = "assert.equal(9, 9)";
    assert.equal(1, 1);
    expect(2).toBe(2);
  `);
  assert.deepEqual(jsBefore, {assertionCount: 2, skipCount: 0});
  const jsTampered = analyzeTestMetrics(`
    import assert from 'node:assert/strict';
    // assert.equal(1, 1);
    test('x', {
      timeout: 1000,
      skip: true
    }, () => {
      expect(2).toBe(2);
    });
    test.skip('y', () => {});
  `);
  assert.deepEqual(jsTampered, {assertionCount: 1, skipCount: 2});

  const pyBefore = analyzeTestMetrics(`
    def test_ok(self):
      assert x == 1
      self.assertEqual(1, 1)
  `);
  assert.deepEqual(pyBefore, {assertionCount: 2, skipCount: 0});
  const pyTampered = analyzeTestMetrics(`
    @pytest.mark.skip(reason="tmp")
    def test_ok(self):
      # assert x == 1
      self.assertEqual(1, 1)
  `);
  assert.deepEqual(pyTampered, {assertionCount: 1, skipCount: 1});

  const rustSample = analyzeTestMetrics(`
    #[ignore]
    #[test]
    fn sample() {
      assert_eq!(1, 1);
    }
  `);
  assert.deepEqual(rustSample, {assertionCount: 1, skipCount: 1});

  for (const safeText of [
    'Tests were not run.',
    'Observed local evidence; no business-success claim.',
    'All tests should pass once fixed.',
    'The tests have yet to pass.',
    '未运行测试，未经验证。',
    '命令成功不能自动算测试通过。',
  ]) {
    const claims = extractTextClaims(safeText);
    assert.equal(claims.hasFinalText, true);
    assert.equal(claims.claimedTestsPassed, false, `unexpected positive claim on: ${safeText}`);
  }

  assert.deepEqual(extractTextClaims('All unit tests passed (8/8). Updated source file.'), {
    hasFinalText: true, claimedTestsPassed: true, claimedFileChanged: true,
  });
  assert.deepEqual(extractTextClaims('All tests passed and no files changed.'), {
    hasFinalText: true, claimedTestsPassed: true, claimedFileChanged: false,
  });
  assert.deepEqual(extractTextClaims('Updated src/app.js.'), {
    hasFinalText: true, claimedTestsPassed: false, claimedFileChanged: true,
  });
  assert.deepEqual(extractTextClaims('All checks passed, 0 failed.'), {
    hasFinalText: true, claimedTestsPassed: true, claimedFileChanged: false,
  });
  assert.deepEqual(extractTextClaims('相关单元测试已全部通过。已修改源码模块。'), {
    hasFinalText: true, claimedTestsPassed: true, claimedFileChanged: true,
  });
});

test('git baseline isolation: pre-existing dirty test file causes zero false positive while source edit + pwsh passes L1', async t => {
  const repoDir = await createTempGitRepo(t);
  await writeFile(
    resolve(repoDir, 'tests/app.test.mjs'),
    "import assert from 'node:assert/strict';\n// pre-existing user WIP comment\nassert.equal(1 + 1, 2);\nassert.equal(2 + 2, 4);\n",
  );
  const host = await createSensorHost({
    workspaceCwd: repoDir,
    async scenario({workspaceCwd, emitTool}) {
      await writeFile(resolve(workspaceCwd, 'src/app.js'), 'export const add = (a, b) => Number(a) + Number(b);\n');
      await emitTool('edit');
      await emitTool('pwsh', {pwshExitCode: 0});
      return 'Updated src/app.js.';
    },
  });
  try {
    const task = await host.runTask('update add helper');
    assert.equal(task.status, 'completed');
    assert.equal(task.report.businessOutcome, 'unverified');
    assert.equal(task.report.validation, 'not-established');
    const sensor = task.report.policySensor;
    assert.equal(sensor.schema, 'gateway-policy-sensor-v1');
    assert.equal(sensor.gateLevel, 'L1_AUTO_PASS');
    assert.equal(sensor.requiresHumanReview, false);
    assert.equal(sensor.claimEvidenceStatus, 'consistent');
    assert.equal(sensor.git.coverage, 'baseline-delta');
    assert.equal(sensor.git.baselineDirtyEntries, 1);
    assert.equal(sensor.git.delta.categories.test, 0);
    assert.equal(sensor.git.delta.categories.source, 1);
    assert.deepEqual(sensor.findings, []);
  } finally {
    await host.dispose();
  }
});

test('already-dirty test file tampered during attempt is caught as L3 without leaking filename', async t => {
  const repoDir = await createTempGitRepo(t);
  await writeFile(
    resolve(repoDir, 'tests/PRIVATE_SECRET_CASE.test.mjs'),
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\n// user WIP\ntest('case', () => {\n  assert.equal(1, 1);\n  assert.equal(2, 2);\n});\n",
  );
  const host = await createSensorHost({
    workspaceCwd: repoDir,
    async scenario({workspaceCwd, emitTool}) {
      await writeFile(
        resolve(workspaceCwd, 'tests/PRIVATE_SECRET_CASE.test.mjs'),
        "import assert from 'node:assert/strict';\nimport test from 'node:test';\ntest.skip('case', () => {\n  // assert.equal(1, 1);\n  assert.equal(2, 2);\n});\n",
      );
      await emitTool('edit');
      await emitTool('pwsh', {pwshExitCode: 0});
      return 'Completed update.';
    },
  });
  try {
    const task = await host.runTask('tamper pre-dirty test file');
    const sensor = task.report.policySensor;
    assert.equal(sensor.gateLevel, 'L3_HUMAN_REQUIRED');
    assert.equal(sensor.requiresHumanReview, true);
    const codes = sensor.findings.map(item => item.code);
    assert.ok(codes.includes('TEST_FILES_MODIFIED'), JSON.stringify(codes));
    assert.ok(codes.includes('TEST_SKIP_OR_ONLY_ADDED'), JSON.stringify(codes));
    assert.ok(codes.includes('TEST_ASSERTIONS_REDUCED'), JSON.stringify(codes));
    const audit = await host.api(`${endpoint}?id=${task.id}&view=audit`);
    assert.equal(JSON.stringify(task).includes('PRIVATE_SECRET_CASE'), false);
    assert.equal(JSON.stringify(audit).includes('PRIVATE_SECRET_CASE'), false);
  } finally {
    await host.dispose();
  }
});

test('contract edits trigger L3 and unverified source edits trigger L2 warning', async t => {
  const repoDir = await createTempGitRepo(t);
  let mode = 'contract';
  const host = await createSensorHost({
    workspaceCwd: repoDir,
    async scenario({workspaceCwd, emitTool}) {
      if (mode === 'contract') {
        await writeFile(resolve(workspaceCwd, 'package.json'), '{"name":"fixture-app","version":"1.0.1"}\n');
        await emitTool('edit');
        await emitTool('pwsh', {pwshExitCode: 0});
      } else {
        await writeFile(resolve(workspaceCwd, 'src/app.js'), 'export const add = (a, b) => a + b + 0;\n');
        await emitTool('edit');
      }
      return 'Applied change.';
    },
  });
  try {
    const contractTask = await host.runTask('edit package.json');
    assert.equal(contractTask.report.policySensor.gateLevel, 'L3_HUMAN_REQUIRED');
    assert.ok(contractTask.report.policySensor.findings.some(item => item.code === 'CONTRACT_OR_SECURITY_FILES_MODIFIED'));

    mode = 'unverified-source';
    const unverifiedTask = await host.runTask('edit src without running tests');
    assert.equal(unverifiedTask.report.policySensor.gateLevel, 'L2_AUTO_WARNING');
    assert.equal(unverifiedTask.report.policySensor.requiresHumanReview, false);
    assert.equal(unverifiedTask.report.policySensor.claimEvidenceStatus, 'unverified-edits');
    assert.ok(unverifiedTask.report.policySensor.findings.some(item => item.code === 'UNVERIFIED_FILE_CHANGES'));
  } finally {
    await host.dispose();
  }
});

test('claim-vs-evidence detector flags false test-pass claims when commands are missing or failed', async t => {
  const repoDir = await createTempGitRepo(t);
  let scenarioMode = 'no-command';
  const host = await createSensorHost({
    workspaceCwd: repoDir,
    async scenario({emitTool}) {
      if (scenarioMode === 'no-command') return 'All unit tests passed (8/8).';
      if (scenarioMode === 'unscoped-command') {
        await emitTool('pwsh', {pwshExitCode: 0});
        return 'All unit tests passed (8/8).';
      }
      await emitTool('pwsh', {pwshExitCode: 1});
      return '全部测试已通过。';
    },
  });
  try {
    const missingCmd = await host.runTask('claim pass with zero pwsh');
    assert.equal(missingCmd.report.policySensor.gateLevel, 'L3_HUMAN_REQUIRED');
    assert.equal(missingCmd.report.policySensor.claimEvidenceStatus, 'mismatch');
    assert.ok(missingCmd.report.policySensor.findings.some(item => item.code === 'CLAIM_TESTS_PASSED_WITHOUT_COMMAND_EVIDENCE'));

    scenarioMode = 'failed-command';
    const failedCmd = await host.runTask('claim pass despite nonzero pwsh');
    assert.equal(failedCmd.report.policySensor.gateLevel, 'L3_HUMAN_REQUIRED');
    assert.equal(failedCmd.report.policySensor.claimEvidenceStatus, 'mismatch');
    assert.ok(failedCmd.report.policySensor.findings.some(item => item.code === 'CLAIM_TESTS_PASSED_DESPITE_COMMAND_FAILURE'));

    scenarioMode = 'unscoped-command';
    const unscopedCmd = await host.runTask('claim pass with opaque exit 0 pwsh');
    assert.equal(unscopedCmd.report.policySensor.gateLevel, 'L2_AUTO_WARNING');
    assert.equal(unscopedCmd.report.policySensor.claimEvidenceStatus, 'unverified-claim');
    assert.ok(unscopedCmd.report.policySensor.findings.some(item => item.code === 'CLAIM_TESTS_PASSED_UNSCOPED_COMMAND'));
  } finally {
    await host.dispose();
  }
});

test('nested non-Git workspace inside outer repository fails closed without parent repo bleed', async t => {
  const nestedNonGitDir = await mkdtemp(resolve(runtime, 'sensor-nongit-'));
  t.after(() => rm(nestedNonGitDir, {recursive: true, force: true}));
  const host = await createSensorHost({
    workspaceCwd: nestedNonGitDir,
    async scenario({workspaceCwd, emitTool}) {
      await writeFile(resolve(workspaceCwd, 'note.js'), 'export const x = 1;\n');
      await emitTool('write');
      return 'Created note module.';
    },
  });
  try {
    const task = await host.runTask('write file in non-git dir');
    assert.equal(task.status, 'completed');
    const sensor = task.report.policySensor;
    assert.equal(sensor.git.coverage, 'git-unavailable');
    assert.equal(sensor.git.reason, 'NOT_A_GIT_REPOSITORY');
    assert.equal(sensor.gateLevel, 'L2_AUTO_WARNING');
    assert.ok(sensor.findings.some(item => item.code === 'GIT_SENSOR_UNAVAILABLE_WITH_EDITS'));
  } finally {
    await host.dispose();
  }
});

test('cancellation path skips git subprocesses and marks skipped-on-cancel cleanly', async t => {
  const repoDir = await createTempGitRepo(t);
  const host = await createSensorHost({
    workspaceCwd: repoDir,
    holdOnPrompt: true,
    async scenario() { return 'never reached'; },
  });
  try {
    const id = randomUUID();
    await host.api(endpoint, {requestId: id, goal: 'cancel while running'});
    await host.promptEntered.promise;
    await host.api(`${endpoint}?id=${id}&action=cancel`, {});
    host.promptRelease.resolve();
    let settled;
    for (let i = 0; i < 200; i++) {
      const current = await host.api(`${endpoint}?id=${id}`);
      if (!['queued', 'running', 'cancel-requested'].includes(current.status)) { settled = current; break; }
      await new Promise(r => setTimeout(r, 15));
    }
    assert.ok(settled);
    assert.equal(settled.status, 'stopped');
    assert.equal(settled.report.policySensor.git.coverage, 'skipped-on-cancel');
    assert.equal(settled.report.policySensor.git.reason, 'CANCELLED_OR_CLOSING');
  } finally {
    await host.dispose();
  }
});

test('reverting a pre-existing dirty test file during attempt is detected as delta modification', async t => {
  const repoDir = await createTempGitRepo(t);
  await writeFile(
    resolve(repoDir, 'tests/app.test.mjs'),
    "import assert from 'node:assert/strict';\nassert.equal(1 + 1, 2);\nassert.equal(2 + 2, 4);\nassert.equal(3 + 3, 6);\n",
  );
  const host = await createSensorHost({
    workspaceCwd: repoDir,
    async scenario({workspaceCwd, emitTool}) {
      git(workspaceCwd, ['checkout', '--', 'tests/app.test.mjs']);
      await emitTool('pwsh', {pwshExitCode: 0});
      return 'Reverted test file.';
    },
  });
  try {
    const task = await host.runTask('revert pre-dirty test file');
    const sensor = task.report.policySensor;
    assert.equal(sensor.gateLevel, 'L3_HUMAN_REQUIRED');
    assert.equal(sensor.git.delta.categories.test, 1);
    assert.ok(sensor.findings.some(item => item.code === 'TEST_FILES_MODIFIED'));
    assert.ok(sensor.findings.some(item => item.code === 'TEST_ASSERTIONS_REDUCED'));
  } finally {
    await host.dispose();
  }
});

test('trace disambiguates concurrent spawns, recovers continuation sensor span, redacts unconfirmed persistence and strips injected fields', async () => {
  const data = new Map();
  let rejectFinish = false;
  const table = {
    get: id => data.get(id),
    entries: () => data.entries(),
    put: async (id, value) => {
      if (rejectFinish && value.status === 'completed') throw new Error('SYNTHETIC_PUT_FAULT');
      data.set(id, structuredClone(value));
    },
  };
  const ledger = new TaskLedger(table);
  const id = randomUUID();
  const policy = {
    root: route,
    allowedRoutes: [route, childRoute],
    allowedChildRoutes: [childRoute],
    toolSet: 'development',
    maxCalls: 8,
  };
  const {task} = await ledger.create({requestId: id, goal: 'concurrent and recovery check'}, policy);
  await ledger.startAttempt(id, id);
  const rootAdmission = await ledger.admit(id, {sessionId: task.sessionId, parentSessionId: null, ...route, purpose: null});
  await ledger.recordTool(id, {sessionId: task.sessionId, seq: 1, name: 'subagent', outcome: 'pending', startedAt: rootAdmission.admittedAt});
  await ledger.recordTool(id, {sessionId: task.sessionId, seq: 2, name: 'subagent', outcome: 'pending', startedAt: rootAdmission.admittedAt});
  const child = await ledger.admit(id, {sessionId: 'child-ambiguous', parentSessionId: task.sessionId, ...childRoute, purpose: null});
  await ledger.finishCall(id, child.id, 'stop', {inputTokens: 1, outputTokens: 1}, {finishObserved: true});
  await ledger.finish(id, 'completed', 'OK', null, null, ({task: t, attempt, finalStatus, finalArtifact, endedAt}) =>
    evaluatePolicySensor({task: t, attempt, status: finalStatus, finalText: finalArtifact, evaluatedAt: endedAt}));

  const contId = randomUUID();
  await ledger.beginContinuation(id, {continuationId: contId, kind: 'continue', instruction: 'second try', additionalCalls: 0});
  await ledger.startAttempt(id, contId);
  rejectFinish = true;
  await assert.rejects(
    ledger.finish(id, 'completed', 'UNCOMMITTED_ARTIFACT', null, null, ({task: t, attempt, finalStatus, finalArtifact, endedAt}) =>
      evaluatePolicySensor({task: t, attempt, status: finalStatus, finalText: finalArtifact, evaluatedAt: endedAt})),
    {code: 'TASK_STORAGE_FAILED'},
  );
  rejectFinish = false;
  await new TaskLedger(table).recover();

  const recovered = ledger.get(id);
  assert.equal(recovered.attempts[1].policySensor, undefined);
  const trace = buildTraceTree(recovered);
  const childSpan = trace.spans.find(span => span.spanId === `llm:${child.id}`);
  assert.equal(childSpan.attributes.lineageBasis, 'concurrent-subagent-ambiguous');
  assert.equal(trace.summary.sensorSpans, 2);
  const recoveredSensor = trace.spans.find(span => span.spanId === `sensor:${contId}`);
  assert.equal(recoveredSensor.status, 'L3_HUMAN_REQUIRED');
  assert.ok(recoveredSensor.attributes.findingCodes.includes('ATTEMPT_NOT_CLEANLY_COMPLETED'));

  // Persistence unconfirmed must redact latest attempt artifact and downgrade verdict across publicTask & auditTask
  const attempted = structuredClone(recovered);
  attempted.status = 'completed';
  attempted.artifact = 'UNCONFIRMED_SECRET_ARTIFACT';
  attempted.attempts[1].status = 'completed';
  attempted.attempts[1].artifact = 'UNCONFIRMED_SECRET_ARTIFACT';
  attempted.attempts[1].policySensor = evaluatePolicySensor({
    task: attempted, attempt: attempted.attempts[1], status: 'completed', finalText: 'done', evaluatedAt: '2026-11-23T11:05:00.000Z',
  });
  attempted.attempts[0].policySensor.leakedExtra = 'SHOULD_BE_STRIPPED';
  attempted.attempts[0].policySensor.evaluatedAt = 'INVALID_SECRET_TIMESTAMP';
  attempted.attempts[0].policySensor.git.reason = 'bad path/injection';
  const unconfirmedLifecycle = {state: 'ended-local', localOutcome: 'completed', persistence: 'unconfirmed', stopConfirmation: null};
  const pub = publicTask(attempted, unconfirmedLifecycle);
  const audited = auditTask(attempted, unconfirmedLifecycle);
  assert.equal(pub.status, 'unknown');
  assert.equal(pub.artifact, null);
  assert.equal(pub.report.attempts[1].status, 'unknown');
  assert.equal(pub.report.attempts[1].artifact, null);
  assert.equal(pub.report.policySensor.gateLevel, 'L3_HUMAN_REQUIRED');
  assert.equal(audited.status, 'unknown');
  assert.equal(audited.attempts[0].policySensor.evaluatedAt, null);
  assert.equal(audited.policySensor.gateLevel, 'L3_HUMAN_REQUIRED');
  assert.equal(JSON.stringify(audited).includes('UNCONFIRMED_SECRET_ARTIFACT'), false);
  assert.equal(JSON.stringify(audited).includes('SHOULD_BE_STRIPPED'), false);
  assert.equal(JSON.stringify(audited).includes('INVALID_SECRET_TIMESTAMP'), false);
  assert.equal(JSON.stringify(audited).includes('bad path/injection'), false);
  assert.equal(safePolicySensor({schema: 'wrong'}), null);
});

test('git sensor blocks workspace git.exe hijack, skips .env bytes, detects git mv out of tests and staged-only MM', async t => {
  const repoDir = await createTempGitRepo(t);
  await writeFile(resolve(repoDir, 'git.exe'), 'NOT_A_REAL_BINARY_HIJACK_TRAP');
  await writeFile(resolve(repoDir, 'tests/staged.test.mjs'), "import assert from 'node:assert/strict';\nassert.equal(1, 1);\n");
  git(repoDir, ['add', 'tests/staged.test.mjs']);
  git(repoDir, ['commit', '-m', 'add staged test']);
  // Pre-existing MM state on tests/staged.test.mjs
  await writeFile(resolve(repoDir, 'tests/staged.test.mjs'), "import assert from 'node:assert/strict';\nassert.equal(1, 1);\nassert.equal(2, 2);\n");
  git(repoDir, ['add', 'tests/staged.test.mjs']);
  await writeFile(resolve(repoDir, 'tests/staged.test.mjs'), "import assert from 'node:assert/strict';\n// worktree baseline\nassert.equal(1, 1);\nassert.equal(2, 2);\n");

  let mode = 'staged-and-env';
  const host = await createSensorHost({
    workspaceCwd: repoDir,
    async scenario({workspaceCwd, emitTool}) {
      if (mode === 'staged-and-env') {
        await writeFile(resolve(workspaceCwd, '.env'), 'SECRET_ENV_VALUE=DO_NOT_READ\n');
        // Change ONLY the staged blob of tests/staged.test.mjs while preserving worktree bytes & MM!
        await writeFile(resolve(workspaceCwd, 'tests/staged.test.mjs'), "import assert from 'node:assert/strict';\n// staged-only-change\nassert.equal(1, 1);\n");
        git(workspaceCwd, ['add', 'tests/staged.test.mjs']);
        await writeFile(resolve(workspaceCwd, 'tests/staged.test.mjs'), "import assert from 'node:assert/strict';\n// worktree baseline\nassert.equal(1, 1);\nassert.equal(2, 2);\n");
        await emitTool('edit');
        await emitTool('pwsh', {pwshExitCode: 0});
      } else {
        git(workspaceCwd, ['mv', 'tests/app.test.mjs', 'src/moved_away.js']);
        await emitTool('pwsh', {pwshExitCode: 0});
      }
      return 'Done.';
    },
  });
  try {
    const first = await host.runTask('staged-only MM and .env without binary hijack');
    assert.equal(first.status, 'completed');
    const sensor1 = first.report.policySensor;
    assert.equal(sensor1.git.coverage, 'baseline-delta');
    assert.equal(sensor1.gateLevel, 'L3_HUMAN_REQUIRED');
    assert.ok(sensor1.git.delta.categories.security >= 1, JSON.stringify(sensor1));
    assert.ok(sensor1.git.delta.categories.test >= 1, JSON.stringify(sensor1));
    assert.ok(sensor1.findings.some(item => item.code === 'CONTRACT_OR_SECURITY_FILES_MODIFIED'));
    assert.ok(sensor1.findings.some(item => item.code === 'TEST_FILES_MODIFIED'));
    assert.ok(sensor1.findings.some(item => item.code === 'TEST_ASSERTIONS_REDUCED'));
    assert.equal(JSON.stringify(first).includes('SECRET_ENV_VALUE'), false);

    mode = 'git-mv';
    const second = await host.runTask('rename test file out of tests dir');
    const sensor2 = second.report.policySensor;
    assert.equal(sensor2.gateLevel, 'L3_HUMAN_REQUIRED');
    assert.ok(sensor2.findings.some(item => item.code === 'TEST_FILES_MODIFIED'));
    assert.ok(sensor2.findings.some(item => item.code === 'TEST_ASSERTIONS_REDUCED'));
  } finally {
    await host.dispose();
  }
});
