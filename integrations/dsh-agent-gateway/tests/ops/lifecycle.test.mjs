import assert from 'node:assert/strict';
import {access, mkdir, readFile, writeFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import test from 'node:test';
import {createTestScratch} from '../fixtures/test-runtime.mjs';
import {
  initializeLifecycle, lifecycleStatus, recoverLifecycle, startLifecycle, stopLifecycle, upgradeLifecycle,
} from '../../ops/lifecycle.mjs';

const source = resolve(import.meta.dirname, '../..');
const runtime = resolve(source, 'runtime');
const lifecycleHost = resolve(source, 'ops/lifecycle-host.mjs');

async function pathExists(path) {
  try { await access(path); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function createHostAdapter() {
  const processes = new Map();
  let nextPid = 3000;
  let failNextStop = false;
  let failNextAbort = false;
  let failNextSpawnInspection = false;
  let nextStateWriteError = null;
  let nextSpawn = {};
  let lastSpawnPid = null;
  const calls = {spawn: 0, abort: 0, graceful: 0, stateWrite: 0};

  const commandLine = (options, controlPipe = options.controlPipe) => [
    process.execPath, lifecycleHost,
    '--launcher', options.launcher, '--patch', options.patch,
    '--home', options.home, '--workspace', options.workspace,
    '--control-pipe', controlPipe,
  ].join(' ');

  function configureNextSpawn(options) {
    nextSpawn = {...nextSpawn, ...options};
  }

  function visibleProcess(item) {
    return item.replacement ?? item.original;
  }

  return {
    exit(pid) {
      const item = processes.get(pid);
      visibleProcess(item).alive = false;
      item.boundAlive = false;
    },
    reuse(pid) {
      const process = visibleProcess(processes.get(pid));
      process.alive = true;
      process.info.creation += '-reused';
    },
    failNextRestart(options = {}) { configureNextSpawn({ready: false, ...options}); },
    failOneStop() { failNextStop = true; },
    failOneAbort() { failNextAbort = true; },
    failNextProcessInfo() { failNextSpawnInspection = true; },
    failNextStateWrite(error = Object.assign(new Error('intentional state write ENOSPC'), {code: 'ENOSPC'})) {
      nextStateWriteError = error;
    },
    hideOneSpawn({abortFails = false, listening = false, replaceLeaseOnAbortControlPipe = null} = {}) {
      configureNextSpawn({hidden: true, listening, abortFails, replaceLeaseOnAbortControlPipe});
    },
    replaceNextSpawnIdentity({controlPipe = '\\\\.\\pipe\\foreign-lifecycle', listening = true, ready = true} = {}) {
      configureNextSpawn({replacementControlPipe: controlPipe, replacementListening: listening, replacementReady: ready});
    },
    lastSpawnPid() { return lastSpawnPid; },
    controlPipe(pid) { return processes.get(pid)?.options.controlPipe ?? null; },
    isAlive(pid) { return visibleProcess(processes.get(pid)).alive; },
    calls() { return {...calls}; },
    async beforeStateWrite() {
      calls.stateWrite++;
      if (!nextStateWriteError) return;
      const error = nextStateWriteError;
      nextStateWriteError = null;
      throw error;
    },
    async processInfo(pid) {
      if (pid === process.pid) {
        return {pid, creation: 'test-controller', executable: process.execPath, commandLine: process.argv.join(' ')};
      }
      const item = processes.get(pid);
      if (!item) return null;
      if (failNextSpawnInspection) {
        failNextSpawnInspection = false;
        throw new Error('intentional process inspection refusal');
      }
      const observed = visibleProcess(item);
      return observed.alive && !observed.hidden ? observed.info : null;
    },
    async listeningOwners(port) {
      return [...processes.values()].flatMap(item => {
        const process = visibleProcess(item);
        return process.alive && process.listening && item.port === port
          ? [{address: '127.0.0.1', port, pid: process.info.pid}]
          : [];
      });
    },
    spawnService(options) {
      calls.spawn++;
      const pid = ++nextPid;
      lastSpawnPid = pid;
      const behavior = {
        ready: true, hidden: false, listening: true, abortFails: false, gracefulFails: false,
        replacementControlPipe: null, replacementListening: true, replacementReady: true,
        replaceLeaseOnAbortControlPipe: null,
        ...nextSpawn,
      };
      nextSpawn = {};
      const abortFails = behavior.abortFails || failNextAbort;
      failNextAbort = false;
      const original = {
        alive: !behavior.replacementControlPipe,
        hidden: behavior.hidden,
        listening: behavior.listening,
        ready: behavior.ready,
        info: {
          pid,
          creation: `test-${pid}`,
          executable: process.execPath,
          commandLine: commandLine(options),
        },
      };
      const replacement = behavior.replacementControlPipe ? {
        alive: true,
        hidden: false,
        listening: behavior.replacementListening,
        ready: behavior.replacementReady,
        info: {
          pid,
          creation: `foreign-${pid}`,
          executable: process.execPath,
          commandLine: commandLine(options, behavior.replacementControlPipe),
        },
      } : null;
      const item = {
        boundAlive: original.alive,
        port: Number(options.port),
        options,
        original,
        replacement,
        abortFails,
        gracefulFails: behavior.gracefulFails,
        replaceLeaseOnAbortControlPipe: behavior.replaceLeaseOnAbortControlPipe,
      };
      processes.set(pid, item);
      writeFileSync(options.lease, JSON.stringify({
        pid,
        controlPipe: replacement ? behavior.replacementControlPipe : options.controlPipe,
      }) + '\n');
      return {
        pid,
        async abortSpawn() {
          calls.abort++;
          if (item.abortFails) throw new Error('intentional bound abort refusal');
          item.boundAlive = false;
          item.original.alive = false;
          if (item.replaceLeaseOnAbortControlPipe) {
            writeFileSync(options.lease, JSON.stringify({
              pid, controlPipe: item.replaceLeaseOnAbortControlPipe,
            }) + '\n');
          }
        },
      };
    },
    async probeHttp(_host, port) {
      const item = [...processes.values()].find(candidate => {
        const process = visibleProcess(candidate);
        return process.alive && process.listening && candidate.port === port;
      });
      return item && visibleProcess(item).ready ? 401 : null;
    },
    async gracefulStop(service) {
      calls.graceful++;
      if (failNextStop) {
        failNextStop = false;
        throw new Error('intentional stop refusal');
      }
      const item = processes.get(service.pid);
      if (item?.gracefulFails) {
        item.gracefulFails = false;
        throw new Error('intentional cleanup refusal');
      }
      if (item) {
        visibleProcess(item).alive = false;
        item.boundAlive = false;
      }
    },
  };
}

function nestedErrors(error) {
  return [error, ...(error instanceof AggregateError ? error.errors.flatMap(nestedErrors) : [])];
}

function hasErrorCode(error, code) {
  return nestedErrors(error).some(item => item?.code === code);
}

function hasErrorMessage(error, pattern) {
  return nestedErrors(error).some(item => pattern.test(String(item?.message ?? item)));
}

async function makeLifecycle(t, prefix, port) {
  const {path: base, remove} = await createTestScratch(`${prefix}-`);
  t.after(remove);
  const home = resolve(base, 'home'), workspace = resolve(base, 'workspace'), release = resolve(base, 'release');
  await mkdir(workspace, {recursive: true});
  await mkdir(release, {recursive: true});
  await writeFile(resolve(release, 'subscription.patch.json'), '[]\n');
  const hostAdapter = createHostAdapter();
  await initializeLifecycle({home, workspace, runtime, release, port}, {hostAdapter});
  return {
    base, home, workspace, release, hostAdapter,
    statePath: resolve(home, '.gateway-lifecycle/service.json'),
    leasePath: resolve(home, '.gateway-lifecycle/service.lease'),
  };
}

test('explicit recovery reconciles a dead process but refuses a reused PID, foreign port or live lease', async t => {
  const {path: base, remove} = await createTestScratch('p02b-dead-recover-');
  t.after(remove);
  const home = resolve(base, 'home'), workspace = resolve(base, 'workspace'), release = resolve(base, 'release');
  await mkdir(workspace, {recursive: true});
  await mkdir(release, {recursive: true});
  await writeFile(resolve(release, 'subscription.patch.json'), '[]');
  const hostAdapter = createHostAdapter();
  await initializeLifecycle({home, workspace, runtime, release, port: 39092}, {hostAdapter});
  const started = await startLifecycle(home, {hostAdapter});
  const statePath = resolve(home, '.gateway-lifecycle/service.json');
  const leasePath = resolve(home, '.gateway-lifecycle/service.lease');
  hostAdapter.exit(started.pid);
  await writeFile(leasePath, JSON.stringify({pid: started.pid, controlPipe: hostAdapter.controlPipe(started.pid)}));
  await assert.rejects(stopLifecycle(home, {hostAdapter}), /ownership is lost/);
  const listen = hostAdapter.listeningOwners;
  hostAdapter.listeningOwners = async port => [{pid: 999, port}];
  await assert.rejects(recoverLifecycle(home, {hostAdapter}), /port has a live owner/);
  hostAdapter.listeningOwners = listen;
  await writeFile(leasePath, JSON.stringify({pid: process.pid, controlPipe: '\\\\.\\pipe\\foreign-controller'}));
  await assert.rejects(recoverLifecycle(home, {hostAdapter}), /leased by PID/);
  await writeFile(leasePath, JSON.stringify({pid: started.pid, controlPipe: hostAdapter.controlPipe(started.pid)}));
  hostAdapter.reuse(started.pid);
  await assert.rejects(recoverLifecycle(home, {hostAdapter}), /ownership is lost/);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).service.pid, started.pid);
  hostAdapter.exit(started.pid);
  const recovered = await recoverLifecycle(home, {hostAdapter});
  assert.equal(recovered.status, 'running');
  assert.notEqual(recovered.pid, started.pid);
  assert.deepEqual(JSON.parse(await readFile(leasePath, 'utf8')), {
    pid: recovered.pid, controlPipe: hostAdapter.controlPipe(recovered.pid),
  });
  assert.equal(await pathExists(resolve(home, '.gateway-lifecycle/drain')), false);
});

test('lifecycle removes drain before stop attempts and retains it after ambiguous stop or restart failures', {timeout: 30000}, async () => {
  const {path: base, remove} = await createTestScratch('p02b-recover-');
  const home = resolve(base, 'home');
  const workspace = resolve(base, 'workspace');
  const release = resolve(base, 'release');
  const drain = resolve(home, '.gateway-lifecycle/drain');
  const ledger = resolve(home, 'storages/gateway_agent_tasks.json');
  const hostAdapter = createHostAdapter();

  try {
    await mkdir(workspace, {recursive: true});
    await mkdir(release, {recursive: true});
    await writeFile(resolve(release, 'subscription.patch.json'), '[]\n');
    await initializeLifecycle({home, workspace, runtime, release, port: 39091}, {hostAdapter});
    const started = await startLifecycle(home, {hostAdapter});

    await mkdir(resolve(home, 'storages'), {recursive: true});
    await writeFile(ledger, JSON.stringify({tables: {tasks: {
      queued: {id: 'queued', status: 'queued'}, active: {id: 'active', status: 'running'},
    }}}));
    await assert.rejects(stopLifecycle(home, {hostAdapter}), /Stop blocked by active tasks: queued:queued, active:running/);
    assert.equal(await pathExists(drain), false, 'a queued pre-stop refusal must remove the drain marker');
    await assert.rejects(recoverLifecycle(home, {hostAdapter}), /Recovery blocked by active tasks: queued:queued, active:running/);
    assert.equal(await pathExists(drain), false, 'a pre-stop refusal must return the unchanged service to normal operation');
    assert.equal((await lifecycleStatus(home, {hostAdapter})).pid, started.pid);

    await writeFile(ledger, JSON.stringify({tables: {tasks: {active: {id: 'active', status: 'completed'}}}}));

    hostAdapter.failOneStop();
    await assert.rejects(stopLifecycle(home, {hostAdapter}), /intentional stop refusal/);
    assert.equal(await pathExists(drain), true, 'an attempted stop failure must stay drained');
    assert.equal((await lifecycleStatus(home, {hostAdapter})).status, 'degraded');

    hostAdapter.failNextRestart({gracefulFails: true});
    await assert.rejects(recoverLifecycle(home, {hostAdapter, timeoutMilliseconds: 5}),
      /did not become stably ready/);

    const status = await lifecycleStatus(home, {hostAdapter});
    assert.equal(status.status, 'stopped');
    assert.equal(hostAdapter.calls().abort, 1, 'failed graceful cleanup must fall back to the bound child abort');
    assert.equal(await pathExists(drain), true, 'a failed post-stop restart must stay drained');
    assert.equal(await pathExists(resolve(home, '.gateway-lifecycle/service.lease')), false);
    const state = JSON.parse(await readFile(resolve(home, '.gateway-lifecycle/service.json'), 'utf8'));
    assert.equal(state.service, null);
  } finally {
    await remove();
  }
});


test('dead-service recovery preserves terminal task data across readiness failure and requires consecutive authenticated readiness', async t => {
  const {home, hostAdapter, leasePath} = await makeLifecycle(t, 'p02b-preserved-recovery', 39104);
  const started = await startLifecycle(home, {hostAdapter});
  const ledger = resolve(home, 'storages/gateway_agent_tasks.json');
  const settings = resolve(home, 'settings.yaml');
  const history = JSON.stringify({tables: {tasks: {
    done: {id: 'done', status: 'completed', calls: [{id: 'previous-call'}]},
    uncertain: {id: 'uncertain', status: 'unknown', calls: [{id: 'unconfirmed-call'}]},
    limited: {id: 'limited', status: 'limited', calls: [{id: 'consumed-call'}]},
  }}}) + '\n';
  await mkdir(resolve(home, 'storages'), {recursive: true});
  await writeFile(ledger, history);
  await writeFile(settings, 'recoveryFixture: unchanged\n');
  hostAdapter.exit(started.pid);
  assert.equal((await lifecycleStatus(home, {hostAdapter})).status, 'degraded');
  hostAdapter.failNextRestart();
  await assert.rejects(recoverLifecycle(home, {hostAdapter, timeoutMilliseconds: 5}), /did not become stably ready/);
  assert.equal((await lifecycleStatus(home, {hostAdapter})).status, 'stopped');
  assert.equal(await pathExists(leasePath), false);
  assert.equal(await pathExists(resolve(home, '.gateway-lifecycle/drain')), true);
  assert.equal(await readFile(ledger, 'utf8'), history);
  assert.equal(await readFile(settings, 'utf8'), 'recoveryFixture: unchanged\n');

  const observations = [401, 404, 401, 401, 401];
  let probes = 0;
  hostAdapter.probeHttp = async () => observations[probes++] ?? 401;
  const recovered = await recoverLifecycle(home, {hostAdapter});
  assert.equal(recovered.status, 'running');
  assert.notEqual(recovered.pid, started.pid);
  assert.equal(probes, observations.length, 'a non-401 response resets the consecutive-readiness count');
  assert.equal(await pathExists(resolve(home, '.gateway-lifecycle/drain')), false);
  assert.equal(await readFile(ledger, 'utf8'), history, 'terminal and unknown tasks must not be reset or replayed');
  assert.equal(await readFile(settings, 'utf8'), 'recoveryFixture: unchanged\n');
  await stopLifecycle(home, {hostAdapter});
});

test('readiness timeout distinguishes an unprobed port, HTTP failures and insufficient consecutive readiness without leaking probe values', async t => {
  const cases = [
    {name: 'port not listening', listening: false, response: 401, lastHttp: 'not-probed', probes: 0, ready: 0},
    {name: 'HTTP did not respond', response: null, lastHttp: 'no-response', probes: 1, ready: 0},
    {name: 'HTTP route not ready', response: 404, lastHttp: '404', probes: 1, ready: 0},
    {name: 'not enough ready observations', response: 401, lastHttp: '401', probes: 1, ready: 1},
    {name: 'unexpected adapter value', response: 'private-probe-value', lastHttp: 'invalid-status', probes: 1, ready: 0},
  ];
  for (const example of cases) await t.test(example.name, async t => {
    const {home, hostAdapter, leasePath} = await makeLifecycle(t, 'p02b-readiness-detail', 39105);
    if (example.listening === false) hostAdapter.failNextRestart({listening: false});
    hostAdapter.probeHttp = async () => example.response;
    await assert.rejects(startLifecycle(home, {hostAdapter, timeoutMilliseconds: 100}), error => {
      assert.match(error.message, /did not become stably ready/);
      assert.ok(error.message.includes(`httpProbes=${example.probes}; lastHttp=${example.lastHttp}; consecutiveReady=${example.ready}/3`));
      assert.ok(!error.message.includes('private-probe-value'));
      return true;
    });
    assert.equal((await lifecycleStatus(home, {hostAdapter})).status, 'stopped');
    assert.equal(await pathExists(leasePath), false);
    assert.equal(hostAdapter.isAlive(hostAdapter.lastSpawnPid()), false);
  });
});

test('unidentified spawned process uses its child-bound receipt and removes only its matching lease', async t => {
  const {path: base, remove} = await createTestScratch('p11a-unidentified-spawn-');
  t.after(remove);
  const home = resolve(base, 'home'), workspace = resolve(base, 'workspace'), release = resolve(base, 'release');
  await mkdir(workspace, {recursive: true});
  await mkdir(release, {recursive: true});
  await writeFile(resolve(release, 'subscription.patch.json'), '[]\n');
  const hostAdapter = createHostAdapter();
  await initializeLifecycle({home, workspace, runtime, release, port: 39093}, {hostAdapter});

  hostAdapter.hideOneSpawn();
  await assert.rejects(startLifecycle(home, {hostAdapter}), /Could not identify spawned service process/);
  const pid = hostAdapter.lastSpawnPid();
  assert.equal(hostAdapter.calls().abort, 1);
  assert.deepEqual(await hostAdapter.listeningOwners(39093), []);
  assert.equal(await pathExists(resolve(home, '.gateway-lifecycle/service.lease')), false);
  const state = JSON.parse(await readFile(resolve(home, '.gateway-lifecycle/service.json'), 'utf8'));
  assert.equal(state.service, null, 'successful child-bound cleanup must not claim a live service');
  assert.equal((await lifecycleStatus(home, {hostAdapter})).status, 'stopped');
  assert.ok(pid > 0);
});

test('unidentified spawned process retains degraded facts when child-bound cleanup fails', async t => {
  const {path: base, remove} = await createTestScratch('p11a-unidentified-spawn-degraded-');
  t.after(remove);
  const home = resolve(base, 'home'), workspace = resolve(base, 'workspace'), release = resolve(base, 'release');
  await mkdir(workspace, {recursive: true});
  await mkdir(release, {recursive: true});
  await writeFile(resolve(release, 'subscription.patch.json'), '[]\n');
  const hostAdapter = createHostAdapter();
  await initializeLifecycle({home, workspace, runtime, release, port: 39094}, {hostAdapter});

  hostAdapter.hideOneSpawn({abortFails: true});
  await assert.rejects(startLifecycle(home, {hostAdapter}), error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /could not be identified or cleaned up safely/);
    assert.match(error.errors[1].message, /intentional bound abort refusal/);
    return true;
  });
  const pid = hostAdapter.lastSpawnPid();
  const state = JSON.parse(await readFile(resolve(home, '.gateway-lifecycle/service.json'), 'utf8'));
  assert.equal(state.service.pid, pid);
  assert.equal(state.service.phase, 'degraded');
  assert.equal(state.service.identityStatus, 'unidentified');
  assert.equal(state.service.cleanupStatus, 'failed');
  assert.equal(await pathExists(resolve(home, '.gateway-lifecycle/service.lease')), true);
  assert.deepEqual(await hostAdapter.listeningOwners(39094), []);
  assert.equal(hostAdapter.isAlive(pid), true, 'absence of a listener is not proof of termination');
  assert.equal((await lifecycleStatus(home, {hostAdapter})).status, 'degraded');
  await assert.rejects(recoverLifecycle(home, {hostAdapter}), /Recovery refused for unverified spawn/);
  assert.equal(hostAdapter.calls().spawn, 1, 'recovery must not dispatch a second hidden process');
});

test('initial state ENOSPC releases the bound child and lease before reporting failure', async t => {
  const {home, hostAdapter, statePath, leasePath} = await makeLifecycle(t, 'p11a-start-write', 39101);
  hostAdapter.failNextStateWrite();
  await assert.rejects(startLifecycle(home, {hostAdapter}), error => hasErrorCode(error, 'ENOSPC'));
  assert.equal(hostAdapter.calls().abort, 1);
  assert.equal(hostAdapter.calls().graceful, 0);
  assert.equal(hostAdapter.isAlive(hostAdapter.lastSpawnPid()), false);
  assert.equal(await pathExists(leasePath), false);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).service, null);
});

test('state write and bound abort failures retain both errors and degraded spawn facts', async t => {
  const {home, hostAdapter, statePath, leasePath} = await makeLifecycle(t, 'p11a-start-write-abort', 39102);
  hostAdapter.failNextStateWrite();
  hostAdapter.failOneAbort();
  await assert.rejects(startLifecycle(home, {hostAdapter}), error => {
    assert.ok(error instanceof AggregateError);
    assert.ok(hasErrorCode(error, 'ENOSPC'));
    assert.ok(hasErrorMessage(error, /bound abort refusal/));
    return true;
  });
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.service.pid, hostAdapter.lastSpawnPid());
  assert.equal(state.service.cleanupStatus, 'failed');
  assert.equal(state.service.phase, 'degraded');
  assert.equal(await pathExists(leasePath), true);
  assert.equal(hostAdapter.isAlive(state.service.pid), true);
  await assert.rejects(startLifecycle(home, {hostAdapter}), /already running|degraded/);
  assert.equal(hostAdapter.calls().spawn, 1);
});

test('initial process inspection exception still releases its bound child', async t => {
  const {home, hostAdapter, statePath, leasePath} = await makeLifecycle(t, 'p11a-inspection', 39103);
  hostAdapter.failNextProcessInfo();
  await assert.rejects(startLifecycle(home, {hostAdapter}), /Could not inspect spawned service/);
  assert.equal(hostAdapter.calls().abort, 1);
  assert.equal(hostAdapter.isAlive(hostAdapter.lastSpawnPid()), false);
  assert.equal(await pathExists(leasePath), false);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).service, null);
});

test('identified not-ready child falls back from graceful failure to bound abort', async t => {
  const {home, hostAdapter, statePath, leasePath} = await makeLifecycle(t, 'p11a-fallback', 39104);
  hostAdapter.failNextRestart({gracefulFails:true});
  await assert.rejects(startLifecycle(home, {hostAdapter, timeoutMilliseconds:5}), /did not become stably ready/);
  assert.equal(hostAdapter.calls().graceful, 1);
  assert.equal(hostAdapter.calls().abort, 1);
  assert.equal(hostAdapter.isAlive(hostAdapter.lastSpawnPid()), false);
  assert.equal(await pathExists(leasePath), false);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).service, null);
});

test('failed graceful and bound cleanup remain degraded, retaining all causes', async t => {
  const {home, hostAdapter, statePath} = await makeLifecycle(t, 'p11a-both-cleanups', 39105);
  hostAdapter.failNextRestart({gracefulFails:true, abortFails:true});
  await assert.rejects(startLifecycle(home, {hostAdapter, timeoutMilliseconds:5}), error => {
    for (const pattern of [/did not become stably ready/, /cleanup refusal/, /bound abort refusal/])
      assert.ok(hasErrorMessage(error, pattern));
    return true;
  });
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.service.cleanupStatus, 'failed');
  assert.equal(state.service.identityStatus, 'verified');
  assert.equal(hostAdapter.isAlive(state.service.pid), true);
});

test('spawn cleanup never removes a lease with the same PID and a different pipe', async t => {
  const {home, hostAdapter, leasePath, statePath} = await makeLifecycle(t, 'p11a-foreign-lease', 39106);
  const foreign = '\\\\.\\pipe\\foreign-lease';
  hostAdapter.hideOneSpawn({replaceLeaseOnAbortControlPipe:foreign});
  await assert.rejects(startLifecycle(home, {hostAdapter}), error => hasErrorMessage(error, /refused to remove a lease/));
  assert.equal(JSON.parse(await readFile(leasePath, 'utf8')).controlPipe, foreign);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).service.cleanupStatus, 'failed');
});

test('a same-PID foreign pipe identity is neither adopted nor gracefully terminated', async t => {
  const {home, hostAdapter, leasePath, statePath} = await makeLifecycle(t, 'p11a-foreign-identity', 39107);
  hostAdapter.replaceNextSpawnIdentity();
  await assert.rejects(startLifecycle(home, {hostAdapter}), error => hasErrorMessage(error, /did not match/));
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.service.identityStatus, 'mismatched');
  assert.equal(hostAdapter.calls().graceful, 0);
  assert.equal(hostAdapter.calls().abort, 1, 'bound receipt refers only to the original child');
  assert.equal(hostAdapter.isAlive(state.service.pid), true, 'foreign replacement must survive');
  assert.notEqual(JSON.parse(await readFile(leasePath, 'utf8')).controlPipe, state.service.controlPipe);
  await assert.rejects(recoverLifecycle(home, {hostAdapter}), /Recovery refused for unverified spawn/);
  assert.equal(hostAdapter.calls().spawn, 1);
});

test('upgrade does not erase unresolved candidate ownership or launch an unsafe rollback', async t => {
  const {base, home, hostAdapter, statePath} = await makeLifecycle(t, 'p11a-upgrade-cleanup', 39108);
  await startLifecycle(home, {hostAdapter});
  const release = resolve(base, 'candidate');
  await mkdir(release);
  await writeFile(resolve(release, 'subscription.patch.json'), '[]');
  hostAdapter.failNextRestart({gracefulFails:true, abortFails:true});
  await assert.rejects(upgradeLifecycle(home, release, {hostAdapter, timeoutMilliseconds:5}), /rollback was not started/);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.activeRelease, release);
  assert.equal(state.service.pid, hostAdapter.lastSpawnPid());
  assert.equal(state.service.cleanupStatus, 'failed');
  assert.equal(hostAdapter.isAlive(state.service.pid), true);
  assert.equal(hostAdapter.calls().spawn, 2);
});

test('normal stop releases the exact lease after process and port exit', async t => {
  const {home, hostAdapter, statePath, leasePath} = await makeLifecycle(t, 'p11a-stop-lease', 39109);
  const started = await startLifecycle(home, {hostAdapter});
  assert.equal(JSON.parse(await readFile(leasePath, 'utf8')).pid, started.pid);
  await stopLifecycle(home, {hostAdapter});
  assert.equal(hostAdapter.isAlive(started.pid), false);
  assert.equal(await pathExists(leasePath), false);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).service, null);
});
