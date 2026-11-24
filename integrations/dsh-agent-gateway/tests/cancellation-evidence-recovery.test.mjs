import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {copyFile, mkdir, mkdtemp, realpath, rm} from 'node:fs/promises';
import {dirname, isAbsolute, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {inspectRuntime} from '../ops/runtime-paths.mjs';

// Only committed helpers/runtime dependencies: no daily Home or live transport.
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {runtime} = await inspectRuntime(resolve(source, 'runtime'));
const moduleRoot = await mkdtemp(resolve(runtime, 'cancellation-evidence-'));
test.after(async () => {
  const target = await realpath(moduleRoot), within = relative(runtime, target);
  assert.equal(target, moduleRoot);
  assert.ok(!isAbsolute(within) && within.startsWith('cancellation-evidence-') && !/[\\/]/.test(within));
  await rm(target, {recursive:true, force:true});
});
for (const file of ['package.json', 'index.js', 'ledger.js', 'report.js', 'panel.js', 'tools.js'])
  await copyFile(resolve(source, file), resolve(moduleRoot, file));
const [{apply}, {developmentRootTools, reconciliationTools}] = await Promise.all([
  import(pathToFileURL(resolve(moduleRoot, 'index.js'))),
  import(pathToFileURL(resolve(moduleRoot, 'tools.js'))),
]);
const route = {provider:'fixture-development', model:'scripted'};
const endpoint = 'http://127.0.0.1/api/gateway-agent-tasks';
const sleep = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));
async function waitFor(check) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(5);
  }
  assert.fail('Native fixture did not reach the expected state');
}

async function createHost({maxConcurrentTasks = 1, holdNative = false, pendingSpawn = false,
  failSnapshotAfterCancel = false, failEvidence = () => false} = {}) {
  const records = new Map(), agents = new Map(), listeners = new Map(), executions = new Map();
  const starts = [], failedWrites = [], activeByWorkspace = new Map(), maxByWorkspace = new Map();
  const snapshotFailures = [];
  let gateway, handler, shutdown, cleaning = false, active = 0, maxActive = 0;
  const workspaces = [
    {id:'alpha', label:'Alpha', cwd:resolve(moduleRoot, 'alpha')},
    {id:'alpha-alias', label:'Alpha alias', cwd:resolve(moduleRoot, 'alpha')},
    {id:'beta', label:'Beta', cwd:resolve(moduleRoot, 'beta')},
  ];
  for (const {cwd} of workspaces) await mkdir(cwd, {recursive:true});
  const schemaNames = agent => agent.allowedTools ?? developmentRootTools;
  const ctx = {
    webServer:{host:'127.0.0.1'},
    storageDomain:{async open(config) {
      const schema = config.tables.tasks.valueSchema;
      return {async close() {}, table:() => ({
        get:id => records.get(id), entries:() => records.entries(),
        async put(id, value) {
          const candidate = schema.parse(structuredClone(value));
          if (failEvidence(candidate)) {
            failedWrites.push(structuredClone(candidate));
            throw new Error('P12_TRANSIENT_EVIDENCE_WRITE');
          }
          records.set(id, candidate);
        },
      })};
    }},
    on(event, listener) { listeners.set(event, listener); },
    workspaceRegistry:{async create(cwd) { return {id:cwd, async attachSession() {}}; }},
    sessions:{get:id => agents.get(id)?.session},
    agents:{get:id => agents.get(id), list:() => [...agents.values()],
      isOwnedBy:(id, owner) => agents.get(id)?.owner === owner},
    connection:{fetch:{register(value) { handler = value.fetch; }}},
    agentPresets:{serviceFor:() => ({schemas:agent => schemaNames(agent).map(name => ({name}))})},
    tools:{schemas:agent => schemaNames(agent).map(name => ({name}))},
    sessionProjections:{stateOf:session => ({sandbox:session.sandbox, approval:'ask'})},
    sessionController:{
      async create(request) {
        const events = [];
        const session = {id:request.sessionId, header:{id:request.sessionId, cwd:request.cwd},
          sandbox:'workspace-write', snapshotEvents() {
            if (failSnapshotAfterCancel && agent.controller?.signal.aborted && !snapshotFailures.length) {
              snapshotFailures.push(session.id);
              throw new Error('P12_NATIVE_SESSION_SNAPSHOT_UNAVAILABLE');
            }
            return structuredClone(events);
          },
          append(type, data, sourceEventSeqs) {
            const event = {seq:events.length + 1, type, data, time:Date.now(), sourceEventSeqs};
            events.push(event);
            if (type === 'sandbox/mode') this.sandbox = data.mode;
            listeners.get('session/event')?.(session, event);
            return event;
          }};
        const agent = {id:request.sessionId, session, idleCalls:0, restrictionReleases:0,
          cancel() { this.controller?.abort(new Error('Operator cancelled native work')); },
          whenIdle() { this.idleCalls++; return this.idle ?? Promise.resolve(); },
          ctx:{tools:{restrict({allow}) {
            const previous = agent.allowedTools;
            agent.allowedTools = [...allow];
            return () => { agent.allowedTools = previous; agent.restrictionReleases++; };
          }}},
        };
        agents.set(agent.id, agent);
        return request;
      },
      async resolveAgent(id) { return {agent:agents.get(id)}; },
      async rename() {}, async selectModel() { return {selected:route}; },
      async prompt(request, signal) {
        signal.throwIfAborted();
        const agent = agents.get(request.sessionId), session = agent.session;
        const idle = Promise.withResolvers(), release = Promise.withResolvers();
        agent.idle = idle.promise;
        agent.controller = new AbortController();
        const workspace = session.header.cwd;
        active++;
        activeByWorkspace.set(workspace, (activeByWorkspace.get(workspace) ?? 0) + 1);
        maxActive = Math.max(maxActive, active);
        maxByWorkspace.set(workspace, Math.max(maxByWorkspace.get(workspace) ?? 0, activeByWorkspace.get(workspace)));
        const execution = {attemptId:request.requestId, agent, release, workspace,
          spawnEntered:Promise.withResolvers(), spawnRegistration:Promise.withResolvers(),
          childCleanup:Promise.withResolvers(),
          tools:[...schemaNames(agent)], sandbox:session.sandbox};
        starts.push(execution);
        executions.set(request.requestId, execution);
        session.append('user/message', {source:{kind:'user', rpcId:request.requestId}});
        // Prompt acceptance precedes completion; idle includes native cancellation
        // cleanup and never resolves before that work ends (no reversed events).
        execution.work = (async () => {
          try {
            const options = {sessionId:session.id, ...route, purpose:null,
              tools:schemaNames(agent).map(name => ({name})), signal:agent.controller.signal};
            for await (const _chunk of listeners.get('llm/stream')(options, async function* () {
              yield {type:'usage', usage:{inputTokens:3, outputTokens:1}};
              yield {type:'finish', reason:{kind:'completed'}};
            })) { /* scripted native stream; no external adapter */ }
            const callId = randomUUID();
            const call = session.append('tool/call', {callId, name:'read', turn:starts.length, step:1});
            session.append('tool/result', {message:{content:[{type:'tool-result', toolCallId:callId,
              isError:false, content:'local evidence'}]}}, [call.seq]);
            if (pendingSpawn && starts.length === 1) {
              // Generic host-defense coverage, not a reproduction of native spawn:
              // foreground preparation was entered before cancellation.
              // Ownership becomes visible only after that preparation completes;
              // root idle includes the child and its cancellation cleanup.
              execution.spawnEntered.resolve();
              await execution.spawnRegistration.promise;
              const childStopped = Promise.withResolvers();
              const child = {id:randomUUID(), owner:agent, cancelCalls:0,
                cancel() { this.cancelCalls++; childStopped.resolve(); },
                whenIdle() { return this.idle; }};
              child.idle = (async () => { await childStopped.promise; await execution.childCleanup.promise; })();
              execution.child = child;
              agents.set(child.id, child);
              if (cleaning) child.cancel();
              await child.idle;
            }
            if (typeof holdNative === 'function' ? holdNative(execution) : holdNative) await release.promise;
            const kind = agent.controller.signal.aborted ? 'aborted' : 'completed';
            session.append('assistant/message', {turn:starts.length,
              message:{content:[{type:'text', text:'Observed local evidence; no business-success claim.'}]}});
            session.append('turn/end', {turn:starts.length, reason:{kind}});
          } finally {
            active--;
            activeByWorkspace.set(workspace, activeByWorkspace.get(workspace) - 1);
            idle.resolve();
          }
        })();
        execution.work.catch(() => {});
      },
    },
  };
  await apply(ctx, {workspaces, maxConcurrentTasks, cancellationTimeoutMs:30,
    policy:{root:route, allowedRoutes:[route], toolSet:'development', maxCalls:8}}, {
    lifecycleBinding:{connect(value) { gateway = value; }, onOperatorCancel() {}},
  });
  return {records, agents, starts, failedWrites, snapshotFailures, maxByWorkspace,
    get active() { return active; }, get maxActive() { return maxActive; },
    start(workspaceId = 'alpha') {
      return gateway.start({requestId:randomUUID(), goal:'Read local evidence', workspaceId});
    },
    continue(id, input) { return gateway.continue(id, input); },
    release(id) { executions.get(id)?.release.resolve(); },
    shutdown() { return shutdown ??= listeners.get('dispose')(); },
    async task(id) { return (await handler(new Request(`${endpoint}?id=${id}`))).json(); },
    async dispose() {
      cleaning = true;
      const disposing = this.shutdown();
      for (const execution of executions.values()) {
        execution.release.resolve(); execution.spawnRegistration.resolve(); execution.childCleanup.resolve();
        execution.child?.cancel();
      }
      await disposing;
      await Promise.all([...executions.values()].map(execution => execution.work));
    },
  };
}

const reconciliation = () => ({continuationId:randomUUID(), kind:'reconcile',
  instruction:'Explicitly reconcile local evidence read-only; do not repeat the business task.', additionalCalls:0});

test('host defense: pending foreground child registration is discovered after timeout before dispatch',
  {timeout:5000}, async () => {
    const host = await createHost({pendingSpawn:true});
    try {
      const first = await host.start();
      await waitFor(() => host.starts.length === 1);
      const execution = host.starts[0];
      await execution.spawnEntered.promise;
      const second = await host.start();
      assert.deepEqual(await first.stop(), {confirmed:false});
      assert.equal((await first.done).task.status, 'unknown');
      execution.spawnRegistration.resolve();
      await waitFor(() => execution.child?.cancelCalls === 1);
      assert.equal(host.active, 1, 'Root foreground work still awaits child cleanup');
      assert.equal((await host.task(second.taskId)).status, 'queued');
      execution.childCleanup.resolve();
      assert.equal((await second.done).task.status, 'completed');
      assert.equal(host.maxActive, 1);
      assert.equal((await first.done).terminationConfirmed, false);
      assert.equal((await host.task(first.taskId)).status, 'unknown');
    } finally { await host.dispose(); }
  });

test('host defense: session evidence-read failure after cancel cannot manufacture confirmed termination',
  {timeout:5000}, async () => {
    const host = await createHost({holdNative:true, failSnapshotAfterCancel:true});
    try {
      const first = await host.start();
      await waitFor(() => host.records.get(first.taskId)?.toolOperations?.length &&
        host.agents.get(first.sessionId)?.idleCalls > 0);
      const second = await host.start();
      assert.deepEqual(await first.stop(), {confirmed:false});
      const ended = await first.done;
      assert.equal(ended.task.status, 'unknown');
      assert.equal(ended.task.failureCode, 'EXECUTION_UNCONFIRMED');
      assert.deepEqual(host.snapshotFailures, [first.sessionId]);
      await sleep(70);
      assert.equal(host.starts.length, 1);
      assert.equal((await host.task(second.taskId)).status, 'queued');
      host.release(first.attemptId);
      await waitFor(() => host.starts.length === 2);
      assert.equal(host.maxActive, 1);
      assert.equal((await first.done).terminationConfirmed, false);
      host.release(second.attemptId);
      assert.equal((await second.done).task.status, 'completed');
    } finally { await host.dispose(); }
  });

test('scheduler fallback releases reconciliation scope only with late native termination', {timeout:5000}, async () => {
  let failed = false;
  const host = await createHost({holdNative:execution => execution.tools.length === reconciliationTools.length,
    failSnapshotAfterCancel:true, failEvidence(task) {
      if (!failed && task.toolOperations.length) { failed = true; return true; }
      return false;
    }});
  try {
    const first = await host.start();
    assert.equal((await first.done).task.status, 'unknown');
    const repair = await host.continue(first.taskId, reconciliation());
    await waitFor(() => host.starts.length === 2 && host.agents.get(first.sessionId).idleCalls >= 3);
    const agent = host.agents.get(first.sessionId);
    const next = await host.start();
    assert.deepEqual(await repair.stop(), {confirmed:false});
    assert.equal((await repair.done).task.status, 'unknown');
    assert.equal((await repair.done).task.failureCode, 'EXECUTION_UNCONFIRMED');
    assert.equal(agent.restrictionReleases, 0);
    assert.deepEqual(agent.allowedTools, reconciliationTools);
    host.release(repair.attemptId);
    await waitFor(() => host.starts.length === 3);
    assert.equal(agent.restrictionReleases, 1, 'Scheduler fallback also releases the native execution scope');
    assert.equal(agent.allowedTools, undefined);
    assert.equal((await next.done).task.status, 'completed');
    assert.equal(host.maxActive, 1);
    await assert.rejects(host.continue(first.taskId, reconciliation()),
      {code:'EXECUTION_TERMINATION_UNCONFIRMED'}, 'Original receipt remains conservative, not spuriously running');
  } finally { await host.dispose(); }
});

test('dispose stays bounded while unconfirmed native work keeps its slot', {timeout:5000}, async () => {
  const host = await createHost({holdNative:true});
  try {
    const first = await host.start();
    await waitFor(() => host.agents.get(first.sessionId)?.idleCalls > 0);
    const second = await host.start();
    assert.deepEqual(await first.stop(), {confirmed:false});
    await host.shutdown();
    assert.equal(host.active, 1, 'Shutdown did not pretend native work ended');
    assert.equal(host.starts.length, 1);
    assert.equal((await second.done).task.status, 'stopped');
    assert.equal((await first.done).task.status, 'unknown');
  } finally { await host.dispose(); }
});

for (const scenario of [
  {name:'same workspace', maxConcurrentTasks:1, secondWorkspace:'alpha'},
  {name:'global slot across workspaces', maxConcurrentTasks:1, secondWorkspace:'beta'},
  {name:'canonical workspace lease with spare capacity', maxConcurrentTasks:2, secondWorkspace:'alpha-alias'},
]) test(`cancellation timeout retains ${scenario.name} until native idle, without replay`, {timeout:5000}, async () => {
  const host = await createHost({...scenario, holdNative:true});
  try {
    const first = await host.start();
    await waitFor(() => host.records.get(first.taskId)?.toolOperations?.length &&
      host.agents.get(first.sessionId)?.idleCalls > 0);
    const second = await host.start(scenario.secondWorkspace);
    assert.equal((await host.task(second.taskId)).status, 'queued');
    assert.deepEqual(await first.stop(), {confirmed:false});
    const ended = await first.done;
    assert.equal(ended.terminationConfirmed, false);
    assert.equal(ended.task.status, 'unknown');
    assert.equal(ended.task.failureCode, 'EXECUTION_UNCONFIRMED');
    await sleep(70);
    assert.equal(host.starts.length, 1, 'A timed out, but its native work has not ended');
    assert.equal(host.active, 1);
    assert.equal((await host.task(second.taskId)).status, 'queued');
    await assert.rejects(host.continue(first.taskId, reconciliation()), {code:'EXECUTION_TERMINATION_UNCONFIRMED'});

    host.release(first.attemptId);
    await waitFor(() => host.starts.length === 2);
    assert.equal(host.maxActive, 1);
    assert.equal(host.maxByWorkspace.get(host.starts[0].workspace), 1);
    assert.equal((await host.task(first.taskId)).status, 'unknown', 'Late idle must not rewrite the interrupted outcome');
    assert.equal((await first.done).terminationConfirmed, false, 'The original timeout receipt stays conservative');
    assert.equal(host.starts.filter(value => value.attemptId === first.attemptId).length, 1);
    host.release(second.attemptId);
    assert.equal((await second.done).task.status, 'completed');
  } finally { await host.dispose(); }
});

for (const failRepair of [false, true]) test(`evidence failures belong to each attempt: ${failRepair ? 'new failure stays unknown' : 'healthy explicit reconcile recovers'}`,
  {timeout:5000}, async () => {
    const failedAttempts = new Set();
    const host = await createHost({failEvidence(task) {
      const attempt = task.attempts.at(-1);
      if (!['initial', ...(failRepair ? ['reconcile'] : [])].includes(attempt.kind) ||
          failedAttempts.has(attempt.id) ||
          !task.toolOperations.some(operation => operation.attemptId === attempt.id)) return false;
      failedAttempts.add(attempt.id);
      return true;
    }});
    try {
      const first = await host.start();
      const initial = await first.done;
      assert.equal(initial.terminationConfirmed, true);
      assert.equal(initial.task.status, 'unknown');
      assert.equal(initial.task.failureCode, 'EVIDENCE_STORAGE_FAILED');
      assert.equal(initial.task.artifact, null);
      assert.equal(host.failedWrites.length, 1);
      const prior = structuredClone(host.records.get(first.taskId).attempts[0]);
      assert.equal(prior.failureCode, 'EVIDENCE_STORAGE_FAILED');
      await assert.rejects(host.continue(first.taskId, {...reconciliation(), kind:'continue'}),
        {code:'RECONCILIATION_REQUIRED'});
      assert.equal(host.starts.length, 1, 'Storage recovery never automatically replays the task');

      const input = reconciliation();
      const repair = await host.continue(first.taskId, input);
      const ended = await repair.done;
      assert.equal(ended.terminationConfirmed, true);
      assert.equal(ended.task.status, failRepair ? 'unknown' : 'reconciled');
      assert.equal(ended.task.failureCode, failRepair ? 'EVIDENCE_STORAGE_FAILED' : null);
      assert.notEqual(ended.task.status, 'completed', 'Read-only reconciliation is not business completion');
      assert.equal(host.failedWrites.length, failRepair ? 2 : 1);
      assert.equal(host.starts.length, 2);
      assert.equal(host.starts[1].sandbox, 'read-only');
      assert.deepEqual(host.starts[1].tools, reconciliationTools);
      const stored = host.records.get(first.taskId);
      assert.deepEqual(stored.attempts[0], prior, 'Prior failure evidence remains unchanged');
      assert.equal(stored.attempts[1].kind, 'reconcile');
      assert.equal(stored.attempts[1].status, failRepair ? 'unknown' : 'reconciled');
      assert.ok(stored.attempts[1].reconciliationEvidence);
      assert.deepEqual(stored.calls.map(call => call.attemptId), [first.attemptId, repair.attemptId]);
      assert.equal(await host.continue(first.taskId, input), repair);
      assert.equal(host.starts.length, 2, 'An idempotent continuation does not replay');
    } finally { await host.dispose(); }
  });
