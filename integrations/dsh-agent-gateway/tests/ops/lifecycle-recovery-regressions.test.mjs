import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import fs from 'node:fs/promises';
import {access, mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {TaskLedger} from '../../ledger.js';
import {startLifecycle, recoverLifecycle, withLifecycleOperationLock} from '../../ops/lifecycle.mjs';

// Public lifecycle operations with isolated files and an OS-process adapter.
// No installed runtime, provider, network listener, or daily Home is used.
const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../ops');
const route = {provider: 'offline-fixture', model: 'never-called'};
const policy = {root: route, allowedRoutes: [route], maxCalls: 4};
async function present(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function fixture(t) {
  const parent = await realpath(tmpdir());
  const base = await mkdtemp(resolve(parent, 'p12-a-lifecycle-regression-'));
  t.after(async () => {
    const canonical = await realpath(base), child = relative(parent, canonical);
    assert.equal(canonical, base, 'scratch root must not be redirected');
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    await rm(canonical, {recursive: true, force: true});
  });
  const home = resolve(base, 'home'), workspace = resolve(base, 'workspace');
  const runtime = resolve(base, 'runtime'), release = resolve(base, 'release');
  const directory = resolve(home, '.gateway-lifecycle');
  const statePath = resolve(directory, 'service.json'), leasePath = resolve(directory, 'service.lease');
  const lockPath = resolve(directory, 'operation.lock'), drainPath = resolve(directory, 'drain');
  const ledgerPath = resolve(home, 'storages/gateway_agent_tasks.json');
  for (const path of [directory, workspace, runtime, release, dirname(ledgerPath)]) await mkdir(path, {recursive: true});
  // Real local config-validation child, not a pretend installed DSH runtime.
  const launcher = resolve(runtime, 'offline-launcher.mjs');
  await writeFile(launcher, "if (!process.argv.includes('--dump-config')) process.exit(1);\n");
  await writeFile(resolve(release, 'subscription.patch.json'), '[]\n');
  const state = {home, workspace, runtime, launcher, activeRelease: release,
    host: '127.0.0.1', port: 39991, permissionMode: 'workspace-write', runtimeVersions: {}, service: {
      pid: 830001, creation: 'crashed-service', executable: process.execPath,
      launcher, patch: resolve(release, 'subscription.patch.json'), home, workspace,
      controlPipe: 'offline-old-pipe', phase: 'running', identityStatus: 'verified', cleanupStatus: null,
    }};
  const processes = new Map();
  let spawned = 0, stopped = 0, portOwners = [], onStartup = async () => {};
  const identity = service => ({pid: service.pid, creation: service.creation, executable: service.executable,
    commandLine: [process.execPath, resolve(source, 'lifecycle-host.mjs'), service.launcher, service.patch,
      home, workspace, service.controlPipe].join(' ')});
  const hostAdapter = {
    async processInfo(pid) {
      if (pid === process.pid) return {pid, creation: 'offline-controller'};
      return processes.get(pid) ?? null;
    },
    async listeningOwners() { return portOwners; },
    spawnService(options) {
      spawned++;
      const pid = 840000 + spawned;
      processes.set(pid, identity({...options, pid, creation: 'offline-new-service', executable: process.execPath}));
      portOwners = [{pid, port: state.port}];
      writeFileSync(leasePath, JSON.stringify({pid, controlPipe: options.controlPipe}));
      return {pid, async abortSpawn() { processes.delete(pid); portOwners = []; }};
    },
    async probeHttp() { await onStartup(); return 401; },
    async gracefulStop(service) { stopped++; processes.delete(service.pid); portOwners = []; },
  };
  const saveState = () => writeFile(statePath, JSON.stringify(state));
  await saveState();
  await writeFile(leasePath, JSON.stringify({pid: state.service.pid, controlPipe: state.service.controlPipe}));
  const records = new Map();
  const persistRecords = () => writeFile(ledgerPath, JSON.stringify({tables: {tasks: Object.fromEntries(records)}}));
  const ledger = new TaskLedger({get: id => records.get(id), entries: () => records.entries(),
    async put(id, value) { records.set(id, structuredClone(value)); await persistRecords(); }});
  return {base, home, state, statePath, leasePath, lockPath, drainPath, ledgerPath, ledger, hostAdapter, processes,
    saveState, identity, get spawned() { return spawned; }, get stopped() { return stopped; },
    setPortOwners(value) { portOwners = value; }, onStartup(fn) { onStartup = fn; }};
}
async function seedActive(f, status = 'running') {
  const {task} = await f.ledger.create({requestId: randomUUID(), goal: 'ordinary interrupted task'}, policy);
  if (status !== 'queued') {
    await f.ledger.startAttempt(task.id, task.attempts[0].id);
    await f.ledger.admit(task.id, {...route, sessionId: task.sessionId, parentSessionId: null, purpose: null});
  }
  if (status === 'cancel-requested') await f.ledger.cancel(task.id);
  return f.ledger.get(task.id);
}

test('ordinary start recovers a dead service with stale rows as unknown, never replay', async t => {
  const f = await fixture(t), originals = [];
  for (const status of ['queued', 'running', 'cancel-requested']) originals.push(await seedActive(f, status));
  let recovered = false, unexpectedDispatches = 0;
  f.onStartup(async () => {
    if (recovered) return;
    // Model startup with REAL ledger.recover(); gateway apply() wiring is tested separately.
    const disk = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
    const rows = new Map(Object.entries(disk.tables.tasks));
    const restartedLedger = new TaskLedger({get: id => rows.get(id), entries: () => rows.entries(),
      async put(id, value) { rows.set(id, structuredClone(value)); }});
    await restartedLedger.recover();
    for (const task of restartedLedger.list()) {
      assert.equal(task.status, 'unknown');
      assert.equal(task.attempts[0].status, 'unknown');
      assert.equal(task.attempts[0].failureCode, 'EXECUTION_UNCONFIRMED');
      assert.equal(task.calls.length, originals.find(old => old.id === task.id).calls.length);
      assert.ok(task.calls.every(call => call.outcome === 'unknown'));
      if (await restartedLedger.startAttempt(task.id, task.attempts[0].id)) unexpectedDispatches++;
    }
    await writeFile(f.ledgerPath, JSON.stringify({tables: {tasks: Object.fromEntries(rows)}}));
    recovered = true;
  });
  const result = await startLifecycle(f.home, {hostAdapter: f.hostAdapter, timeoutMilliseconds: 4000});
  assert.equal(result.status, 'running');
  assert.equal(f.spawned, 1);
  assert.equal(f.stopped, 0, 'must not issue a stop to an exited process');
  assert.equal(recovered, true);
  assert.equal(unexpectedDispatches, 0);
  assert.equal(await present(f.drainPath), false);
  assert.equal(await present(f.lockPath), false);
});

test('native bundle config overrides retain the lifecycle drain-path check', async t => {
  const f = await fixture(t);
  await writeFile(resolve(f.state.activeRelease, 'subscription.patch.json'), JSON.stringify([
    {id:'gateway-agent-tasks',disabled:false,config:{policy}},
  ]));
  await assert.rejects(startLifecycle(f.home, {hostAdapter:f.hostAdapter}), /does not use the lifecycle drain path/);
  assert.equal(f.spawned, 0);
  assert.equal(f.stopped, 0);
});

for (const obstacle of ['live PID', 'foreign port', 'live lease', 'unverified spawn', 'PID reuse']) {
  test(`ordinary start refuses ${obstacle} without stopping any process`, async t => {
    const f = await fixture(t);
    if (obstacle === 'live PID') f.processes.set(f.state.service.pid, {pid:f.state.service.pid});
    if (obstacle === 'foreign port') f.setPortOwners([{pid:990001}]);
    if (obstacle === 'live lease') {
      f.processes.set(990002, {pid:990002});
      await writeFile(f.leasePath, JSON.stringify({pid:990002, controlPipe:'foreign'}));
    }
    if (obstacle === 'unverified spawn') {
      f.state.service.cleanupStatus = 'failed'; f.state.service.identityStatus = 'unidentified'; await f.saveState();
    }
    if (obstacle === 'PID reuse') {
      const inspect = f.hostAdapter.processInfo; let checks = 0;
      f.hostAdapter.processInfo = async pid => pid === f.state.service.pid && ++checks === 2 ? {pid} : inspect(pid);
    }
    const before = await readFile(f.statePath, 'utf8');
    await assert.rejects(startLifecycle(f.home, {hostAdapter:f.hostAdapter}), /live|owned|leased|unverified/);
    assert.equal(f.spawned, 0); assert.equal(f.stopped, 0);
    assert.equal(await readFile(f.statePath, 'utf8'), before);
  });
}

test('failed operation-lock initialization cleans its own file and permits a healthy retry', async t => {
  const f = await fixture(t);
  const inspect = f.hostAdapter.processInfo;
  const original = new Error('transient-process-inspection-failure');
  let fail = true, bodies = 0;
  f.hostAdapter.processInfo = async pid => {
    if (pid === process.pid && fail) { fail = false; throw original; }
    return inspect(pid);
  };
  const operation = () => withLifecycleOperationLock(f.home, () => { bodies++; }, {hostAdapter: f.hostAdapter});
  await assert.rejects(operation(), error => error === original);
  assert.equal(await present(f.lockPath), false, 'must remove the file created by failed initialization');
  assert.equal(bodies, 0);
  await operation();
  assert.equal(bodies, 1);
  assert.equal(await present(f.lockPath), false);
});

for (const status of ['queued', 'running', 'cancel-requested']) {
  test(`live service still refuses recovery with ${status} work`, async t => {
    const f = await fixture(t);
    await seedActive(f, status);
    f.processes.set(f.state.service.pid, f.identity(f.state.service));
    f.setPortOwners([{pid: f.state.service.pid}]);
    const before = await readFile(f.statePath, 'utf8'), ledgerBefore = await readFile(f.ledgerPath, 'utf8');
    await assert.rejects(recoverLifecycle(f.home, {hostAdapter: f.hostAdapter}), /Recovery blocked by active tasks/);
    assert.equal(f.spawned, 0); assert.equal(f.stopped, 0);
    assert.equal(await readFile(f.statePath, 'utf8'), before);
    assert.equal(await readFile(f.ledgerPath, 'utf8'), ledgerBefore);
    assert.equal(await present(f.drainPath), false);
    assert.equal(await present(f.lockPath), false);
  });
}

test('live service idle recovery retains both drain checks and refuses newly visible active work', async t => {
  const f = await fixture(t);
  f.processes.set(f.state.service.pid, f.identity(f.state.service));
  const read = fs.readFile;
  let activeReads = 0;
  await writeFile(f.ledgerPath, JSON.stringify({tables: {tasks: {}}}));
  // A task already in admission when drain begins becomes durable between checks.
  // No out-of-order native events; only a normal delayed storage commit.
  const stub = t.mock.method(fs, 'readFile', async (path, ...options) => {
    if (path === f.ledgerPath && ++activeReads === 2) await seedActive(f, 'running');
    return read(path, ...options);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(recoverLifecycle(f.home, {hostAdapter: f.hostAdapter}), /Recovery blocked by active tasks/);
    assert.equal(activeReads, 2);
    assert.equal(f.spawned, 0); assert.equal(f.stopped, 0);
  } finally { stub.mock.restore(); syncBuiltinESMExports(); }
});

for (const obstacle of ['foreign port', 'live lease', 'unverified failed spawn']) {
  test(`dead service with stale work does not bypass ${obstacle} protection`, async t => {
    const f = await fixture(t);
    await seedActive(f);
    let expected;
    if (obstacle === 'foreign port') {
      f.setPortOwners([{pid: 990001}]); expected = /port has a live owner/;
    } else if (obstacle === 'live lease') {
      f.processes.set(990002, {pid: 990002, creation: 'foreign-owner'});
      await writeFile(f.leasePath, JSON.stringify({pid: 990002, controlPipe: 'foreign-lease'}));
      expected = /leased by PID 990002/;
    } else {
      f.state.service.cleanupStatus = 'failed'; f.state.service.identityStatus = 'unidentified';
      await f.saveState(); expected = /Recovery refused for unverified spawn/;
    }
    const before = await readFile(f.statePath, 'utf8'), leaseBefore = await readFile(f.leasePath, 'utf8');
    const ledgerBefore = await readFile(f.ledgerPath, 'utf8');
    await assert.rejects(recoverLifecycle(f.home, {hostAdapter: f.hostAdapter}), expected);
    assert.equal(f.spawned, 0); assert.equal(f.stopped, 0);
    assert.equal(await readFile(f.statePath, 'utf8'), before);
    assert.equal(await readFile(f.leasePath, 'utf8'), leaseBefore);
    assert.equal(await readFile(f.ledgerPath, 'utf8'), ledgerBefore);
    assert.equal(await present(f.drainPath), true, 'uncertain recovery must remain drained');
    assert.equal(await present(f.lockPath), false);
  });
}

test('reused PID never authorizes stopping or clearing the recorded service', async t => {
  const f = await fixture(t);
  f.processes.set(f.state.service.pid, {...f.identity(f.state.service), creation: 'another-process'});
  const before = await readFile(f.statePath, 'utf8');
  await assert.rejects(recoverLifecycle(f.home, {hostAdapter: f.hostAdapter}), /ownership is lost/);
  assert.equal(f.spawned, 0); assert.equal(f.stopped, 0);
  assert.equal(await readFile(f.statePath, 'utf8'), before);
});

test('PID reuse between dead-service checks cannot turn skipped task checks into a live stop', async t => {
  const f = await fixture(t);
  await seedActive(f);
  const inspect = f.hostAdapter.processInfo;
  let serviceChecks = 0;
  f.hostAdapter.processInfo = async pid => {
    if (pid === f.state.service.pid && ++serviceChecks === 2) {
      // A new unrelated process receives the old PID after the initial exited observation.
      f.processes.set(pid, {pid, creation: 'reused', executable: process.execPath, commandLine: 'unrelated'});
    }
    return inspect(pid);
  };
  const before = await readFile(f.statePath, 'utf8');
  await assert.rejects(recoverLifecycle(f.home, {hostAdapter: f.hostAdapter}), /exited-only recovery cannot stop/);
  assert.equal(serviceChecks, 2);
  assert.equal(f.spawned, 0); assert.equal(f.stopped, 0);
  assert.equal(await readFile(f.statePath, 'utf8'), before);
});

test('service inspection failure is not evidence of exit and does not touch state or work', async t => {
  const f = await fixture(t);
  await seedActive(f);
  const inspect = f.hostAdapter.processInfo, original = new Error('process-query-failed');
  f.hostAdapter.processInfo = async pid => {
    if (pid === f.state.service.pid) throw original;
    return inspect(pid);
  };
  const before = await readFile(f.statePath, 'utf8');
  await assert.rejects(recoverLifecycle(f.home, {hostAdapter: f.hostAdapter}), error => error === original);
  assert.equal(f.spawned, 0); assert.equal(f.stopped, 0);
  assert.equal(await readFile(f.statePath, 'utf8'), before);
  assert.equal(await present(f.drainPath), false);
});

test('a live operation-lock owner is preserved and concurrent lifecycle bodies cannot enter', async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  let bodies = 0;
  const first = withLifecycleOperationLock(f.home, async () => {
    bodies++; entered.resolve(); await release.promise;
  }, {hostAdapter: f.hostAdapter});
  await entered.promise;
  try {
    const owner = await readFile(f.lockPath, 'utf8');
    await assert.rejects(withLifecycleOperationLock(f.home, () => { bodies++; }, {hostAdapter: f.hostAdapter}),
      /Another lifecycle operation owns Home/);
    assert.equal(await readFile(f.lockPath, 'utf8'), owner);
    assert.equal(bodies, 1);
  } finally { release.resolve(); await first; }
  assert.equal(await present(f.lockPath), false);
});

test('an EEXIST from initialization is propagated, not mistaken for exclusive-open contention', async t => {
  const f = await fixture(t), original = Object.assign(new Error('inspection EEXIST'), {code: 'EEXIST'});
  f.hostAdapter.processInfo = async () => { throw original; };
  let entered = false;
  await assert.rejects(withLifecycleOperationLock(f.home, () => { entered = true; }, {hostAdapter: f.hostAdapter}),
    error => error === original);
  assert.equal(entered, false);
  assert.equal(await present(f.lockPath), false);
});

test('operation-lock owner-record write failure is cleaned and retry succeeds', async t => {
  const f = await fixture(t), original = Object.assign(new Error('owner-write-full'), {code: 'ENOSPC'});
  const probe = await open(resolve(f.base, 'handle-probe'), 'wx');
  const prototype = Object.getPrototypeOf(probe), write = prototype.writeFile;
  await probe.close();
  let injected = false, entered = 0;
  const stub = t.mock.method(prototype, 'writeFile', async function (...args) {
    const own = await this.stat(), lock = await stat(f.lockPath);
    if (!injected && own.dev === lock.dev && own.ino === lock.ino) { injected = true; throw original; }
    return write.apply(this, args);
  });
  try {
    await assert.rejects(withLifecycleOperationLock(f.home, () => { entered++; }, {hostAdapter: f.hostAdapter}),
      error => error === original);
    assert.equal(injected, true); assert.equal(entered, 0);
    assert.equal(await present(f.lockPath), false);
  } finally { stub.mock.restore(); }
  await withLifecycleOperationLock(f.home, () => { entered++; }, {hostAdapter: f.hostAdapter});
  assert.equal(entered, 1);
});

test('lock cleanup failure remains visible alongside the original initialization error', async t => {
  const f = await fixture(t), original = new Error('original-inspection-failure');
  const cleanupError = Object.assign(new Error('lock-cleanup-denied'), {code: 'EACCES'});
  f.hostAdapter.processInfo = async () => { throw original; };
  const unlink = fs.unlink;
  const stub = t.mock.method(fs, 'unlink', async path => {
    if (path === f.lockPath) throw cleanupError;
    return unlink(path);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(withLifecycleOperationLock(f.home, () => assert.fail('must not enter'), {hostAdapter: f.hostAdapter}), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, original);
      assert.deepEqual(error.errors, [original, cleanupError]);
      return true;
    });
    assert.equal(await present(f.lockPath), true);
  } finally { stub.mock.restore(); syncBuiltinESMExports(); }
});
