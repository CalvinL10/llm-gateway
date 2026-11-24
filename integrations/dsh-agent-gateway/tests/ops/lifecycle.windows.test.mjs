import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import test from 'node:test';
import {createTestScratch} from '../fixtures/test-runtime.mjs';
import {
  initializeLifecycle, lifecycleStatus, startLifecycle, stopLifecycle, upgradeLifecycle, windowsHost,
} from '../../ops/lifecycle.mjs';

const source = resolve(import.meta.dirname, '../..');
const runtime = resolve(source, 'runtime');

async function freePort() {
  const server = createServer();
  await new Promise((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  await new Promise(ok => server.close(ok));
  return port;
}

async function makeRelease(base, name, patch = []) {
  const release = resolve(base, name);
  await mkdir(release, {recursive: true});
  await writeFile(resolve(release, 'subscription.patch.json'), JSON.stringify(patch, null, 2) + '\n');
  return release;
}

async function makeBadRelease(base) {
  const release = resolve(base, 'release-bad');
  await mkdir(release, {recursive: true});
  await writeFile(resolve(release, 'subscription.patch.json'), JSON.stringify([
    {
      id: 'web-runtime',
      name: '@deepseek-ai/dsh-web-app',
      config: {
        openBrowser: 'P11A_INTENTIONAL_INVALID_BOOLEAN',
        printUrl: true,
        surfaceContext: true,
        trustedHosts: [],
      },
    },
  ], null, 2) + '\n');
  return release;
}

async function cleanupHome(home) {
  try {
    const status = await lifecycleStatus(home);
    if (status.status === 'running') await stopLifecycle(home);
  } catch {}
}

const windows = process.platform === 'win32' ? test : test.skip;

windows('Windows lifecycle owns its process and port, rejects conflicts, and restores a failed upgrade',
  {timeout: 180000}, async t => {
    const {path: base, remove} = await createTestScratch('p02b-windows-');
    const workspace = resolve(base, 'workspace');
    const home = resolve(base, 'home');
    await mkdir(workspace, {recursive: true});
    const releaseA = await makeRelease(base, 'release-a');
    const releaseB = await makeRelease(base, 'release-b');
    const badRelease = await makeBadRelease(base);
    const homes = [home];
    t.after(async () => {
      for (const item of homes) await cleanupHome(item);
      const states = await Promise.all(homes.map(item => lifecycleStatus(item).catch(() => ({status: 'stopped'}))));
      if (states.every(state => state.status === 'stopped')) await remove();
    });

    const port = await freePort();
    await initializeLifecycle({home, workspace, runtime, release: releaseA, port});
    const started = await startLifecycle(home);
    const owners = await windowsHost.listeningOwners(port);
    assert.ok(owners.some(owner => owner.pid === started.pid), 'started PID must own the configured port');
    assert.equal(await windowsHost.probeHttp('127.0.0.1', port), 401);
    assert.equal((await lifecycleStatus(home)).status, 'running');

    await assert.rejects(startLifecycle(home), /already running/);
    assert.equal((await lifecycleStatus(home)).pid, started.pid, 'repeated start must preserve the original process');

    const sentinel = resolve(home, 'user-data-sentinel.txt');
    await writeFile(sentinel, 'preserve me\n');
    const ledger = resolve(home, 'storages/gateway_agent_tasks.json');
    await mkdir(resolve(home, 'storages'), {recursive: true});
    await writeFile(ledger, JSON.stringify({tables: {tasks: {
      queued: {id: 'queued', status: 'queued'}, active: {id: 'active', status: 'running'},
    }}}));
    await assert.rejects(upgradeLifecycle(home, releaseB), /Upgrade blocked by active tasks: queued:queued, active:running/);
    assert.equal((await lifecycleStatus(home)).pid, started.pid, 'active work must leave the original service running');
    await writeFile(ledger, JSON.stringify({tables: {tasks: {active: {id: 'active', status: 'completed'}}}}));

    const upgraded = await upgradeLifecycle(home, releaseB);
    assert.equal(upgraded.status, 'upgraded');
    assert.equal(upgraded.previousRelease, releaseA);
    assert.equal(upgraded.release, releaseB);
    const afterUpgrade = await lifecycleStatus(home);
    assert.equal(afterUpgrade.status, 'running');
    assert.equal(afterUpgrade.release, releaseB);
    assert.equal(await windowsHost.probeHttp('127.0.0.1', port), 401);

    await assert.rejects(upgradeLifecycle(home, badRelease, {timeoutMilliseconds: 30000}),
      /previous runtime, release and configuration were restored/);
    const restored = await lifecycleStatus(home);
    assert.equal(restored.status, 'running');
    assert.equal(restored.release, releaseB);
    assert.equal(restored.runtime, runtime);
    assert.ok((await windowsHost.listeningOwners(port)).some(owner => owner.pid === restored.pid));
    assert.equal(await windowsHost.probeHttp('127.0.0.1', port), 401);
    const restoredState = JSON.parse(await readFile(resolve(home, '.gateway-lifecycle/service.json'), 'utf8'));
    const restoredLease = JSON.parse(await readFile(resolve(home, '.gateway-lifecycle/service.lease'), 'utf8'));
    assert.equal(restoredLease.pid, restored.pid);
    assert.equal(restoredLease.controlPipe, restoredState.service.controlPipe);

    const stopped = await stopLifecycle(home);
    assert.equal(stopped.graceful, true);
    assert.equal(await windowsHost.processInfo(restored.pid), null);
    assert.deepEqual(await windowsHost.listeningOwners(port), []);
    await assert.rejects(readFile(resolve(home, '.gateway-lifecycle/service.lease')),
      error => error?.code === 'ENOENT');

    const state = JSON.parse(await readFile(resolve(home, '.gateway-lifecycle/service.json'), 'utf8'));
    assert.equal(state.activeRelease, releaseB);
    assert.equal(state.service, null);
    assert.equal(await readFile(sentinel, 'utf8'), 'preserve me\n');
  });

// Separate independent Homes: slow native CIM queries must not combine unrelated
// startup-failure/foreign-owner scenarios into the upgrade scenario's deadline.
// Keep the original per-test timeout and all ownership/readiness assertions.
async function isolatedHome(t) {
  const {path: base, remove} = await createTestScratch('p02b-windows-');
  const workspace = resolve(base, 'workspace');
  const home = resolve(base, 'home');
  await mkdir(workspace, {recursive: true});
  t.after(async () => {
    await cleanupHome(home);
    if ((await lifecycleStatus(home)).status === 'stopped') {
      await remove();
    }
  });
  return {base, workspace, home};
}

windows('Windows failed initial startup leaves no owned service or listener',
  {timeout: 180000}, async t => {
    const {base, workspace, home: badHome} = await isolatedHome(t);
    const badRelease = await makeBadRelease(base);

    const badPort = await freePort();
    await initializeLifecycle({home: badHome, workspace, runtime, release: badRelease, port: badPort});
    await assert.rejects(startLifecycle(badHome), /exited before readiness|did not become stably ready/);
    assert.equal((await lifecycleStatus(badHome)).status, 'stopped');
    assert.deepEqual(await windowsHost.listeningOwners(badPort), []);
    const state = JSON.parse(await readFile(resolve(badHome, '.gateway-lifecycle/service.json'), 'utf8'));
    assert.equal(state.service, null);
    await assert.rejects(readFile(resolve(badHome, '.gateway-lifecycle/service.lease')),
      error => error?.code === 'ENOENT');
    const stderr = await readFile(resolve(badHome, '.gateway-lifecycle/service.stderr.log'), 'utf8');
    assert.match(stderr, /openBrowser expected boolean.*P11A_INTENTIONAL_INVALID_BOOLEAN/s);
  });

windows('Windows startup refuses a foreign port owner without stopping it',
  {timeout: 180000}, async t => {
    const {base, workspace, home: occupiedHome} = await isolatedHome(t);
    const releaseA = await makeRelease(base, 'release-a');

    const occupiedPort = await freePort();
    const holder = createServer();
    await new Promise((ok, fail) => holder.once('error', fail).listen(occupiedPort, '127.0.0.1', ok));
    try {
      await initializeLifecycle({home: occupiedHome, workspace, runtime, release: releaseA, port: occupiedPort});
      await assert.rejects(startLifecycle(occupiedHome), /already owned by PID/);
      assert.equal(holder.listening, true, 'lifecycle must not stop an unrelated port owner');
      assert.ok((await windowsHost.listeningOwners(occupiedPort)).some(owner => owner.pid === process.pid));
    } finally {
      await new Promise(ok => holder.close(ok));
    }
    assert.equal((await lifecycleStatus(occupiedHome)).status, 'stopped');
  });
