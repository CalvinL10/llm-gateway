import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {copyFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRuntimeFixture} from './fixtures/test-runtime.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {path: moduleRoot, remove} = await createRuntimeFixture('scheduler-test-');
test.after(remove);
for (const file of ['package.json','index.js','ledger.js','report.js','panel.js','tools.js'])
  await copyFile(resolve(source, file), resolve(moduleRoot, file));
const [{apply}, {developmentRootTools}] = await Promise.all([
  import(pathToFileURL(resolve(moduleRoot, 'index.js'))),
  import(pathToFileURL(resolve(moduleRoot, 'tools.js'))),
]);

const route = {provider:'fixture-development', model:'scripted'};
const endpoint = 'http://127.0.0.1/api/gateway-agent-tasks';
const sleep = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));

async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(10);
  }
  throw new Error(`condition not reached; last=${JSON.stringify(last)}`);
}

function deferred() {
  const value = Promise.withResolvers();
  value.settled = false;
  value.promise.finally(() => { value.settled = true; }).catch(() => {});
  return value;
}

async function createSchedulerHost({maxConcurrentTasks = 2, aliasAlpha = false} = {}) {
  const records = new Map(), agents = new Map(), workspaceByCwd = new Map();
  const listeners = new Map(), gates = new Map(), starts = [];
  let handler, runtime, active = 0, maxActive = 0, createCount = 0, promptCount = 0;
  const activeByWorkspace = new Map(), maxByWorkspace = new Map();
  const workspaces = [
    {id:'alpha', label:'Alpha', cwd:resolve('synthetic-alpha')},
    {id:'beta', label:'Beta', cwd:resolve('synthetic-beta')},
  ];
  if (aliasAlpha) workspaces.push({id:'alpha-alias', label:'Alpha alias', cwd:workspaces[0].cwd});
  for (const item of workspaces)
    if (!workspaceByCwd.has(item.cwd)) workspaceByCwd.set(item.cwd, item.id);

  const ctx = {
    webServer:{host:'127.0.0.1'},
    storageDomain:{async open(config) {
      const schema = config.tables.tasks.valueSchema;
      return {async close() {}, table:() => ({
        get:id => records.get(id),
        entries:() => records.entries(),
        async put(id, value) { records.set(id, schema.parse(structuredClone(value))); },
      })};
    }},
    on(event, listener) { listeners.set(event, listener); },
    workspaceRegistry:{async create(cwd) {
      return {id:`native-${workspaceByCwd.get(cwd)}`, async attachSession() {}};
    }},
    sessions:{get:id => agents.get(id)?.session},
    agents:{get:id => agents.get(id), list:() => [...agents.values()], isOwnedBy:() => false},
    connection:{fetch:{register(spec) { handler = spec.fetch; }}},
    agentPresets:{serviceFor:() => ({schemas:() => developmentRootTools.map(name => ({name}))})},
    tools:{schemas:() => developmentRootTools.map(name => ({name}))},
    sessionProjections:{stateOf:() => ({sandbox:'workspace-write', approval:'ask'})},
    sessionController:{
      async create(request) {
        createCount++;
        let seq = 0;
        const workspaceId = workspaceByCwd.get(request.cwd);
        const events = [];
        const session = {id:request.sessionId, header:{id:request.sessionId},
          snapshotEvents:() => structuredClone(events),
          append(type, data) { events.push({seq:++seq, type, data}); }};
        const agent = {id:request.sessionId, session, cancel() {}, async whenIdle() {}};
        agents.set(request.sessionId, agent);
        agent.workspaceId = workspaceId;
        return request;
      },
      async resolveAgent(sessionId) { return {agent:agents.get(sessionId)}; },
      async rename() {},
      async selectModel() { return {selected:route}; },
      async prompt(request, signal) {
        promptCount++;
        const agent = agents.get(request.sessionId), workspaceId = agent.workspaceId;
        const gate = deferred();
        gates.set(request.requestId, gate);
        active++;
        activeByWorkspace.set(workspaceId, (activeByWorkspace.get(workspaceId) ?? 0) + 1);
        maxActive = Math.max(maxActive, active);
        maxByWorkspace.set(workspaceId, Math.max(maxByWorkspace.get(workspaceId) ?? 0,
          activeByWorkspace.get(workspaceId)));
        starts.push({attemptId:request.requestId, workspaceId, active});
        agent.session.append('user/message', {source:{kind:'user', rpcId:request.requestId}});
        const onAbort = () => gate.reject(signal.reason ?? new Error('cancelled'));
        signal.addEventListener('abort', onAbort, {once:true});
        try {
          await gate.promise;
          agent.session.append('assistant/message', {turn:1, message:{content:[{type:'text', text:'done'}]}});
          agent.session.append('turn/end', {turn:1, reason:{kind:'completed'}});
        } finally {
          signal.removeEventListener('abort', onAbort);
          active--;
          activeByWorkspace.set(workspaceId, activeByWorkspace.get(workspaceId) - 1);
        }
      },
    },
  };

  await apply(ctx, {workspaces, maxConcurrentTasks, cancellationTimeoutMs:200,
    policy:{root:route, allowedRoutes:[route], toolSet:'development', maxCalls:8}}, {
    lifecycleBinding:{connect(value) { runtime = value; }, onOperatorCancel() {}},
  });

  return {
    records, starts, maxByWorkspace,
    get active() { return active; }, get maxActive() { return maxActive; },
    get createCount() { return createCount; }, get promptCount() { return promptCount; },
    start(workspaceId, goal='scheduler fixture') {
      return runtime.start({requestId:randomUUID(), goal, workspaceId});
    },
    release(attemptId) { gates.get(attemptId)?.resolve(); },
    async task(id) {
      const response = await handler(new Request(`${endpoint}?id=${id}`));
      assert.equal(response.status, 200);
      return response.json();
    },
    async dispose() { await listeners.get('dispose')(); },
  };
}

test('global concurrency is bounded while development work in one workspace remains serial', async () => {
  const host = await createSchedulerHost({maxConcurrentTasks:2});
  try {
    const first = await host.start('alpha', 'alpha one');
    const second = await host.start('alpha', 'alpha two');
    const third = await host.start('beta', 'beta one');
    const fourth = await host.start('beta', 'beta two');

    await waitFor(() => host.starts.length === 2);
    assert.deepEqual(host.starts.map(item => item.workspaceId), ['alpha', 'beta']);
    assert.equal(host.maxActive, 2);
    assert.equal((await host.task(second.taskId)).status, 'queued');
    assert.equal((await host.task(fourth.taskId)).status, 'queued');

    host.release(first.attemptId);
    await first.done;
    await waitFor(() => host.starts.some(item => item.attemptId === second.attemptId));
    assert.equal(host.active, 2, 'another workspace may continue while the alpha lease changes hands');

    host.release(third.attemptId);
    await third.done;
    await waitFor(() => host.starts.some(item => item.attemptId === fourth.attemptId));
    host.release(second.attemptId);
    host.release(fourth.attemptId);
    const ended = await Promise.all([second.done, fourth.done]);
    assert.deepEqual(ended.map(value => value.task.status), ['completed', 'completed']);
    assert.equal(host.maxActive, 2);
    assert.equal(host.maxByWorkspace.get('alpha'), 1);
    assert.equal(host.maxByWorkspace.get('beta'), 1);
  } finally {
    await host.dispose();
  }
});

test('configured aliases of one native workspace cannot bypass write serialization', async () => {
  const host = await createSchedulerHost({maxConcurrentTasks:2, aliasAlpha:true});
  try {
    const first = await host.start('alpha');
    await waitFor(() => host.promptCount === 1);
    const alias = await host.start('alpha-alias');
    const independent = await host.start('beta');
    await waitFor(() => host.starts.length === 2);
    assert.equal((await host.task(alias.taskId)).status, 'queued');
    assert.deepEqual(host.starts.map(item => item.workspaceId), ['alpha', 'beta']);
    host.release(first.attemptId);
    await first.done;
    await waitFor(() => host.starts.some(item => item.attemptId === alias.attemptId));
    host.release(alias.attemptId);
    host.release(independent.attemptId);
    await Promise.all([alias.done, independent.done]);
    assert.equal(host.maxByWorkspace.get('alpha'), 1);
    assert.equal(host.maxActive, 2);
  } finally { await host.dispose(); }
});

test('queued cancellation creates no session or prompt and a large cancelled batch releases every slot', async () => {
  const host = await createSchedulerHost({maxConcurrentTasks:1});
  try {
    const receipts = [];
    for (let index = 0; index < 40; index++) receipts.push(await host.start('alpha', `batch ${index}`));
    await waitFor(() => host.promptCount === 1);
    const queued = await host.task(receipts[10].taskId);
    assert.equal(queued.status, 'queued');
    assert.equal(queued.report.attempts[0].startedAt, null);

    const results = await Promise.all(receipts.map(receipt => receipt.stop()));
    assert.ok(results.every(value => value.confirmed === true));
    const ended = await Promise.all(receipts.map(receipt => receipt.done));
    assert.ok(ended.every(value => value.task.status === 'stopped'));
    assert.equal(host.createCount, 1);
    assert.equal(host.promptCount, 1);
    assert.equal(host.active, 0);
    assert.ok([...host.records.values()].every(task => task.calls.length === 0));

    const followUp = await host.start('alpha', 'follow-up after cancellation');
    await waitFor(() => host.promptCount === 2);
    host.release(followUp.attemptId);
    assert.equal((await followUp.done).task.status, 'completed');
    assert.equal(host.active, 0);
  } finally {
    await host.dispose();
  }
});

test('dispose cancels queued and running work and drains scheduler receipts', async () => {
  const host = await createSchedulerHost({maxConcurrentTasks:2});
  const receipts = [];
  for (let index = 0; index < 12; index++) receipts.push(await host.start(index % 2 ? 'alpha' : 'beta', `dispose ${index}`));
  await waitFor(() => host.promptCount === 2);
  await host.dispose();
  const ended = await Promise.all(receipts.map(receipt => receipt.done));
  assert.ok(ended.every(value => value.task.status === 'stopped'));
  assert.equal(host.active, 0);
  assert.equal(host.createCount, 2);
  assert.equal(host.promptCount, 2);
});
