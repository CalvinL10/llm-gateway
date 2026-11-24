import {execFile, spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {constants, closeSync, openSync} from 'node:fs';
import {createConnection} from 'node:net';
import {
  access, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile,
} from 'node:fs/promises';
import {promisify} from 'node:util';
import {dirname, isAbsolute, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectRuntime} from './runtime-paths.mjs';

const execFileAsync = promisify(execFile);
const opsDir = dirname(fileURLToPath(import.meta.url));
const gatewayRoot = resolve(opsDir, '..');
const lifecycleHost = resolve(opsDir, 'lifecycle-host.mjs');
const defaultRuntime = resolve(gatewayRoot, 'runtime');
const activeStatuses = new Set(['queued', 'running', 'cancel-requested']);
const lifecycleName = '.gateway-lifecycle';
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const sleep = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;

async function waitWithTimeout(promise, timeoutMilliseconds, message) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMilliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function exists(path) {
  try { await access(path, constants.F_OK); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function normalizeDirectory(label, value, {create = false} = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty path`);
  const absolute = resolve(value);
  if (create) await mkdir(absolute, {recursive: true});
  const canonical = await realpath(absolute).catch(error => {
    if (error?.code === 'ENOENT') throw new Error(`${label} does not exist: ${absolute}`);
    throw error;
  });
  if (!(await stat(canonical)).isDirectory()) throw new Error(`${label} is not a directory: ${absolute}`);
  return canonical;
}

function overlaps(left, right) {
  const relation = relative(left, right);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

function assertSeparated(paths) {
  for (let left = 0; left < paths.length; left++) {
    for (let right = left + 1; right < paths.length; right++) {
      if (overlaps(paths[left][1], paths[right][1]) || overlaps(paths[right][1], paths[left][1])) {
        throw new Error(`${paths[left][0]} and ${paths[right][0]} must be separate, non-nested directories`);
      }
    }
  }
}

function pathsFor(home) {
  const directory = resolve(home, lifecycleName);
  return {
    directory,
    state: resolve(directory, 'service.json'),
    operationLock: resolve(directory, 'operation.lock'),
    serviceLease: resolve(directory, 'service.lease'),
    drain: resolve(directory, 'drain'),
    stdout: resolve(directory, 'service.stdout.log'),
    stderr: resolve(directory, 'service.stderr.log'),
  };
}

async function readJson(path, fallback = null) {
  if (!await exists(path)) return structuredClone(fallback);
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { throw new Error(`Invalid JSON at ${path}: ${error.message}`); }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), {recursive: true});
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await rename(temporary, path);
}

function powershell(script) {
  return execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, maxBuffer: 1024 * 1024,
  });
}

async function requestStop(controlPipe) {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(controlPipe);
    let response = '';
    const timeout = setTimeout(() => socket.destroy(new Error('Lifecycle control pipe timeout')), 5000);
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', chunk => { response += chunk; });
    socket.once('connect', () => socket.end('stop\n'));
    socket.once('close', hadError => {
      clearTimeout(timeout);
      if (!hadError && (!response.trim() || response.trim() === 'stopping')) resolvePromise();
      else if (!hadError) reject(new Error(`Unexpected lifecycle control response: ${response.trim()}`));
    });
  });
}

export const windowsHost = {
  async processInfo(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const script = [
      `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction SilentlyContinue`,
      'if ($null -eq $p) { exit 3 }',
      '[pscustomobject]@{ pid = [int]$p.ProcessId; creation = $p.CreationDate.ToUniversalTime().ToString("o"); executable = $p.ExecutablePath; commandLine = $p.CommandLine } | ConvertTo-Json -Compress',
    ].join('; ');
    try {
      const {stdout} = await powershell(script);
      return JSON.parse(stdout.trim());
    } catch (error) {
      if (error?.code === 3) return null;
      throw error;
    }
  },

  async listeningOwners(port) {
    const script = [
      `$items = @(Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue)`,
      '$items | Select-Object LocalAddress, LocalPort, OwningProcess | ConvertTo-Json -Compress',
    ].join('; ');
    const {stdout} = await powershell(script);
    if (!stdout.trim()) return [];
    const parsed = JSON.parse(stdout.trim());
    return (Array.isArray(parsed) ? parsed : [parsed]).map(item => ({
      address: item.LocalAddress, port: Number(item.LocalPort), pid: Number(item.OwningProcess),
    }));
  },

  spawnService({launcher, patch, home, workspace, host, port, permissionMode, controlPipe, lease, stdout, stderr}) {
    const stdoutFd = openSync(stdout, 'a');
    let stderrFd;
    try {
      stderrFd = openSync(stderr, 'a');
      const child = spawn(process.execPath, ['--expose-internals', lifecycleHost,
        '--launcher', launcher, '--patch', patch, '--home', home, '--workspace', workspace,
        '--host', host, '--port', String(port), '--permission-mode', permissionMode,
        '--control-pipe', controlPipe, '--lease', lease,
      ], {
        cwd: workspace,
        env: {...process.env},
        detached: true,
        windowsHide: true,
        stdio: ['ignore', stdoutFd, stderrFd],
      });
      let spawnError = null;
      child.once('error', error => { spawnError = error; });
      const closed = new Promise(resolvePromise => child.once('close', resolvePromise));
      child.unref();
      return {
        pid: child.pid,
        async abortSpawn({timeoutMilliseconds = 5000} = {}) {
          if (!Number.isInteger(child.pid) || child.pid <= 0) {
            await waitWithTimeout(closed, timeoutMilliseconds,
              'Spawn failure did not settle before cleanup timeout');
            if (!spawnError) throw new Error('Lifecycle host did not expose a PID or a spawn error');
            return;
          }
          if (child.exitCode === null && child.signalCode === null) {
            const signalled = child.kill();
            if (!signalled && child.exitCode === null && child.signalCode === null) {
              throw new Error(`Could not signal spawned lifecycle host ${child.pid}`);
            }
          }
          await waitWithTimeout(closed, timeoutMilliseconds,
            `Spawned lifecycle host ${child.pid} did not exit within ${timeoutMilliseconds}ms`);
        },
      };
    } finally {
      closeSync(stdoutFd);
      if (stderrFd !== undefined) closeSync(stderrFd);
    }
  },

  async probeHttp(host, port) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(`http://${host}:${port}/`, {redirect: 'manual', signal: controller.signal});
      return response.status;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  },

  async gracefulStop(service) {
    await requestStop(service.controlPipe);
  },
};

function verifyIdentity(info, service) {
  if (!info || info.pid !== service.pid || info.creation !== service.creation) return false;
  if (comparable(resolve(info.executable ?? '')) !== comparable(resolve(service.executable))) return false;
  const command = comparable(String(info.commandLine ?? ''));
  return [lifecycleHost, service.launcher, service.patch, service.home, service.workspace, service.controlPipe]
    .every(value => typeof value === 'string' && value
      && command.includes(comparable(value)));
}

async function acquireOperationLock(home, hostAdapter) {
  const paths = pathsFor(home);
  await mkdir(paths.directory, {recursive: true});
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try {
      handle = await open(paths.operationLock, 'wx');
      const info = await hostAdapter.processInfo(process.pid);
      await handle.writeFile(JSON.stringify({pid: process.pid, creation: info?.creation ?? null}) + '\n');
      return async () => {
        await handle.close();
        await unlink(paths.operationLock).catch(error => { if (error?.code !== 'ENOENT') throw error; });
      };
    } catch (error) {
      if (handle) {
        // Exclusive creation succeeded: this is initialization failure, even if
        // the later inspection/write reports EEXIST. Never enter owner takeover.
        const cleanupErrors = [];
        let owned;
        try { owned = await handle.stat({bigint: true}); }
        catch (cleanupError) { cleanupErrors.push(cleanupError); }
        try { await handle.close(); }
        catch (cleanupError) { cleanupErrors.push(cleanupError); }
        if (owned) {
          try {
            const current = await stat(paths.operationLock, {bigint: true});
            if (current.dev !== owned.dev || current.ino !== owned.ino) {
              throw new Error('Operation lock changed ownership during initialization cleanup');
            }
            await unlink(paths.operationLock);
          } catch (cleanupError) {
            if (cleanupError?.code !== 'ENOENT') cleanupErrors.push(cleanupError);
          }
        }
        if (cleanupErrors.length) {
          throw new AggregateError([error, ...cleanupErrors],
            'Lifecycle operation lock initialization failed; cleanup was incomplete', {cause: error});
        }
        throw error;
      }
      if (error?.code !== 'EEXIST') throw error;
      const owner = await readJson(paths.operationLock, {});
      const info = await hostAdapter.processInfo(Number(owner.pid));
      if (info && (!owner.creation || info.creation === owner.creation)) {
        throw new Error(`Another lifecycle operation owns Home ${home} (PID ${owner.pid})`);
      }
      await unlink(paths.operationLock).catch(unlinkError => { if (unlinkError?.code !== 'ENOENT') throw unlinkError; });
    }
  }
  throw new Error(`Could not acquire lifecycle operation lock for ${home}`);
}

async function withLock(home, hostAdapter, operation) {
  const release = await acquireOperationLock(home, hostAdapter);
  try { return await operation(); } finally { await release(); }
}

export async function withLifecycleOperationLock(home, operation, {hostAdapter = windowsHost} = {}) {
  if (typeof operation !== 'function') throw new TypeError('Lifecycle operation must be callable');
  const loaded = await loadState(home);
  return withLock(loaded.state.home, hostAdapter, async () => {
    const fresh = await loadState(loaded.state.home);
    return operation({home:fresh.state.home, state:structuredClone(fresh.state),
      statePath:fresh.statePath, hostAdapter});
  });
}

function findGatewayConfig(patch) {
  let config = null;
  for (const entry of patch) {
    for (const inserted of entry?.insert ?? []) if (inserted?.id === 'gateway-agent-tasks') config = inserted.config;
    // Native bundle installations already insert the row; releases override it.
    if (entry?.id === 'gateway-agent-tasks' && entry.config !== undefined) config = entry.config;
  }
  return config;
}

async function validateRelease({home, workspace, release, launcher, permissionMode, runtime}) {
  const canonical = await normalizeDirectory('Release', release);
  assertSeparated([['Home', home], ['Workspace', workspace], ['Release', canonical], ['Runtime', runtime]]);
  const patchPath = resolve(canonical, 'subscription.patch.json');
  await access(patchPath, constants.R_OK).catch(() => { throw new Error(`Release patch is missing: ${patchPath}`); });
  const patch = await readJson(patchPath, null);
  if (!Array.isArray(patch)) throw new Error(`Release patch must be a top-level array: ${patchPath}`);
  const gatewayConfig = findGatewayConfig(patch);
  if (gatewayConfig) {
    const expectedDrain = resolve(home, lifecycleName, 'drain');
    if (comparable(resolve(gatewayConfig.lifecycleDrainPath ?? '')) !== comparable(expectedDrain)) {
      throw new Error(`Gateway release does not use the lifecycle drain path: ${expectedDrain}`);
    }
  }
  const deploymentState = await readJson(resolve(canonical, 'deployment-state.json'), null);
  if (deploymentState) {
    for (const [label, expected] of [['home', home], ['workspace', workspace]]) {
      if (typeof deploymentState[label] !== 'string'
          || comparable(resolve(deploymentState[label])) !== comparable(expected)) {
        throw new Error(`Release belongs to another ${label}: ${deploymentState[label] ?? 'missing'}`);
      }
    }
  }
  await execFileAsync(process.execPath, [launcher, '--profile', 'web', '--patch', patchPath, '--dump-config'], {
    cwd: workspace,
    env: {...process.env, DSH_HOME: home, DSH_PERMISSION_MODE: permissionMode},
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {release: canonical, patch: patchPath};
}

async function readActiveTasks(home) {
  const ledger = resolve(home, 'storages/gateway_agent_tasks.json');
  if (!await exists(ledger)) return [];
  const value = await readJson(ledger, null);
  const table = value?.tables?.tasks;
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    throw new Error(`Cannot verify active tasks in ${ledger}`);
  }
  return Object.values(table).filter(task => activeStatuses.has(task?.status))
    .map(task => ({id: task.id, status: task.status}));
}

async function beginDrain(home, reason) {
  const path = pathsFor(home).drain;
  await writeFile(path, JSON.stringify({reason, requestedAt: new Date().toISOString()}) + '\n');
}

async function endDrain(home) {
  await unlink(pathsFor(home).drain).catch(error => { if (error?.code !== 'ENOENT') throw error; });
}

async function assertNoActiveTasks(home, action) {
  const active = await readActiveTasks(home);
  if (active.length) throw new Error(`${action} blocked by active tasks: ${active.map(task => `${task.id}:${task.status}`).join(', ')}`);
}

async function waitForService(service, hostAdapter, timeoutMilliseconds = 30000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastOwners = [], readyChecks = 0;
  let httpProbes = 0, lastHttp = 'not-probed';
  while (Date.now() < deadline) {
    const info = await hostAdapter.processInfo(service.pid);
    if (!verifyIdentity(info, service)) throw new Error(`Managed service exited before readiness on port ${service.port}`);
    lastOwners = await hostAdapter.listeningOwners(service.port);
    if (lastOwners.some(owner => owner.pid !== service.pid)) {
      throw new Error(`Port ${service.port} was acquired by another process during startup: ${lastOwners.map(owner => owner.pid).join(', ')}`);
    }
    if (lastOwners.some(owner => owner.pid === service.pid)) {
      const status = hostAdapter.probeHttp ? await hostAdapter.probeHttp(service.host, service.port) : 401;
      if (hostAdapter.probeHttp) {
        httpProbes++;
        // Retain only status metadata: never log response bodies, URLs or arbitrary adapter values.
        lastHttp = status === null ? 'no-response'
          : Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : 'invalid-status';
      }
      if (status === 401) {
        readyChecks++;
        if (readyChecks >= 3) return info;
      } else {
        readyChecks = 0;
      }
    } else {
      readyChecks = 0;
    }
    await sleep(500);
  }
  throw new Error(`Managed service did not become stably ready on port ${service.port} within ${timeoutMilliseconds}ms; owners=${lastOwners.map(owner => owner.pid).join(',') || 'none'}; httpProbes=${httpProbes}; lastHttp=${lastHttp}; consecutiveReady=${readyChecks}/3`);
}

async function waitForExit(pid, hostAdapter, timeoutMilliseconds = 15000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (!await hostAdapter.processInfo(pid)) return;
    await sleep(100);
  }
  throw new Error(`Managed process ${pid} did not stop within ${timeoutMilliseconds}ms`);
}

async function removeStaleLease(state, hostAdapter) {
  const leasePath = pathsFor(state.home).serviceLease;
  if (!await exists(leasePath)) return;
  const lease = await readJson(leasePath, {});
  const owner = await hostAdapter.processInfo(Number(lease.pid));
  if (owner) throw new Error(`Home ${state.home} is leased by PID ${lease.pid}`);
  await unlink(leasePath);
}

function normalizeSpawnReceipt(spawned) {
  if (Number.isInteger(spawned) && spawned > 0) return {pid: spawned, abortSpawn: null};
  if (spawned && Number.isInteger(spawned.pid) && spawned.pid > 0) {
    return {
      pid: spawned.pid,
      abortSpawn: typeof spawned.abortSpawn === 'function' ? spawned.abortSpawn.bind(spawned) : null,
    };
  }
  throw new Error('Lifecycle host spawn did not return a positive PID');
}

async function persistLifecycleState(statePath, state, hostAdapter) {
  if (typeof hostAdapter.beforeStateWrite === 'function') {
    await hostAdapter.beforeStateWrite(statePath, structuredClone(state));
  }
  await writeJsonAtomic(statePath, state);
}

function spawnServiceFacts(state, validated, controlPipe, pid, info = null) {
  return {
    pid, creation: info?.creation ?? null, executable: process.execPath,
    launcher: state.launcher, patch: validated.patch, release: state.activeRelease, runtime: state.runtime,
    home: state.home, workspace: state.workspace, host: state.host, port: state.port,
    controlPipe, lease: pathsFor(state.home).serviceLease,
    startedAt: new Date().toISOString(), phase: 'starting',
    identityStatus: info ? 'verified' : 'unidentified', cleanupStatus: null,
  };
}

async function removeMatchingSpawnLease(leasePath, expected) {
  if (!await exists(leasePath)) return;
  const lease = await readJson(leasePath, {});
  if (Number(lease.pid) !== expected.pid || lease.controlPipe !== expected.controlPipe) {
    throw new Error(
      `Spawn cleanup refused to remove a lease owned by ${lease.pid ?? 'unknown'} / ${lease.controlPipe ?? 'unknown'}`,
    );
  }
  await unlink(leasePath);
}

async function confirmSpawnReleased(expected, hostAdapter, leasePath) {
  const current = await hostAdapter.processInfo(expected.pid);
  if (verifyIdentity(current, expected)) {
    throw new Error(`Spawned lifecycle host ${expected.pid} is still running after cleanup`);
  }
  const remainingOwners = await hostAdapter.listeningOwners(expected.port);
  if (remainingOwners.some(owner => owner.pid === expected.pid)) {
    throw new Error(`PID ${expected.pid} still owns port ${expected.port} after cleanup`);
  }
  await removeMatchingSpawnLease(leasePath, expected);
}

async function abortSpawnAndConfirm(spawnReceipt, expected, hostAdapter, leasePath) {
  if (!spawnReceipt.abortSpawn) {
    throw new Error('Spawn adapter did not provide a child-bound abort receipt');
  }
  await spawnReceipt.abortSpawn();
  await confirmSpawnReleased(expected, hostAdapter, leasePath);
}

async function throwWithDegradedSpawn({
  state, statePath, service, hostAdapter, errors, message, identityStatus,
}) {
  service.phase = 'degraded';
  service.identityStatus = identityStatus;
  service.cleanupStatus = 'failed';
  state.service = service;
  state.updatedAt = new Date().toISOString();
  const combined = [...errors];
  try {
    await persistLifecycleState(statePath, state, hostAdapter);
  } catch (persistenceError) {
    combined.push(persistenceError);
    message += '; degraded lifecycle facts could not be persisted';
  }
  throw new AggregateError(combined, message);
}

async function startUnlocked(state, statePath, hostAdapter, {timeoutMilliseconds = 30000} = {}) {
  if (state.service) {
    const info = await hostAdapter.processInfo(state.service.pid);
    const owners = await hostAdapter.listeningOwners(state.port);
    if (verifyIdentity(info, state.service) && owners.some(owner => owner.pid === state.service.pid)) {
      throw new Error(`Gateway is already running for Home ${state.home} (PID ${state.service.pid})`);
    }
    if (info) throw new Error(`Recorded PID ${state.service.pid} is live but ownership or listener is degraded for Home ${state.home}; inspect status and use explicit recovery; no process was stopped`);
    if (owners.length) throw new Error(`Port ${state.port} is already owned by PID ${owners.map(owner => owner.pid).join(', ')}; the recorded service has exited`);
    // Under the existing lock, recheck dead PID, port and lease. Never stop a
    // live/reused PID or replay stale tasks during this exited-only recovery.
    await stopUnlocked(state, statePath, hostAdapter, {allowExited:true, requireExited:true});
  }
  await removeStaleLease(state, hostAdapter);
  const owners = await hostAdapter.listeningOwners(state.port);
  if (owners.length) throw new Error(`Port ${state.port} is already owned by PID ${owners.map(owner => owner.pid).join(', ')}`);
  const validated = await validateRelease({...state, release: state.activeRelease});
  const paths = pathsFor(state.home);
  const controlPipe = `\\\\.\\pipe\\llm-gateway-${randomUUID()}`;
  const spawnReceipt = normalizeSpawnReceipt(hostAdapter.spawnService({
    launcher: state.launcher, patch: validated.patch, home: state.home, workspace: state.workspace,
    host: state.host, port: state.port, permissionMode: state.permissionMode,
    controlPipe, lease: paths.serviceLease, stdout: paths.stdout, stderr: paths.stderr,
  }));
  const {pid} = spawnReceipt;
  let info, inspectionError = null;
  try {
    for (let attempt = 0; attempt < 100 && !info; attempt++) {
      info = await hostAdapter.processInfo(pid);
      if (!info) await sleep(20);
    }
  } catch (error) {
    inspectionError = new Error(`Could not inspect spawned service process ${pid}: ${error.message}`);
    inspectionError.cause = error;
  }

  const service = spawnServiceFacts(state, validated, controlPipe, pid, info);
  if (inspectionError || !verifyIdentity(info, service)) {
    const identityStatus = info ? 'mismatched' : 'unidentified';
    const identityError = inspectionError ?? new Error(info
      ? `Spawned service process ${pid} did not match its requested lifecycle identity`
      : `Could not identify spawned service process ${pid}`);
    try {
      await abortSpawnAndConfirm(spawnReceipt, service, hostAdapter, paths.serviceLease);
    } catch (cleanupError) {
      await throwWithDegradedSpawn({
        state, statePath, service, hostAdapter, errors: [identityError, cleanupError],
        message: `Spawned process ${pid} could not be identified or cleaned up safely`,
        identityStatus,
      });
    }
    throw identityError;
  }

  state.service = service;
  state.updatedAt = new Date().toISOString();
  let statePersisted = false;
  try {
    await persistLifecycleState(statePath, state, hostAdapter);
    statePersisted = true;
    await waitForService(service, hostAdapter, timeoutMilliseconds);
    service.phase = 'running';
    state.updatedAt = new Date().toISOString();
    await persistLifecycleState(statePath, state, hostAdapter);
    await endDrain(state.home);
    return {
      status: 'running', home: state.home, release: state.activeRelease, runtime: state.runtime,
      pid, host: state.host, port: state.port,
    };
  } catch (startupError) {
    let current, inspectionFailure = null;
    try { current = await hostAdapter.processInfo(pid); }
    catch (error) { inspectionFailure = error; }
    let cleanupFailure = null;
    let identityStatus = 'verified';
    if (inspectionFailure || !statePersisted) {
      if (inspectionFailure) identityStatus = 'unidentified';
      try {
        await abortSpawnAndConfirm(spawnReceipt, service, hostAdapter, paths.serviceLease);
      } catch (error) {
        cleanupFailure = inspectionFailure
          ? new AggregateError([inspectionFailure, error], 'Inspection and child-bound cleanup failed')
          : error;
      }
    } else if (verifyIdentity(current, service)) {
      try {
        await hostAdapter.gracefulStop(service);
        await waitForExit(pid, hostAdapter);
        await confirmSpawnReleased(service, hostAdapter, paths.serviceLease);
      } catch (gracefulError) {
        try {
          await abortSpawnAndConfirm(spawnReceipt, service, hostAdapter, paths.serviceLease);
        } catch (abortError) {
          cleanupFailure = new AggregateError([gracefulError, abortError],
            `Graceful and child-bound cleanup both failed for PID ${pid}`);
        }
      }
    } else if (current) {
      identityStatus = 'mismatched';
      try {
        await abortSpawnAndConfirm(spawnReceipt, service, hostAdapter, paths.serviceLease);
      } catch (error) {
        cleanupFailure = error;
      }
    } else {
      try {
        await confirmSpawnReleased(service, hostAdapter, paths.serviceLease);
      } catch (error) {
        cleanupFailure = error;
      }
    }

    if (cleanupFailure) {
      const cleanupErrors = cleanupFailure instanceof AggregateError
        ? cleanupFailure.errors : [cleanupFailure];
      await throwWithDegradedSpawn({
        state, statePath, service, hostAdapter, errors: [startupError, ...cleanupErrors],
        message: `Startup failed and managed process ${pid} could not be stopped safely`,
        identityStatus,
      });
    }

    state.service = null;
    state.updatedAt = new Date().toISOString();
    if (statePersisted) {
      try {
        await persistLifecycleState(statePath, state, hostAdapter);
      } catch (stateError) {
        throw new AggregateError([startupError, stateError],
          `Startup failed; process ${pid} was stopped but lifecycle state could not be cleared`);
      }
    }
    throw startupError;
  }
}

async function stopUnlocked(state, statePath, hostAdapter, {allowExited = false, requireExited = false} = {}) {
  const service = state.service;
  if (!service) return {status: 'stopped', alreadyStopped: true, home: state.home};
  if (service.cleanupStatus === 'failed' && service.identityStatus !== 'verified') {
    throw new Error(
      `Recovery refused for unverified spawn PID ${service.pid}: verify and terminate the recorded spawn before clearing lifecycle state`,
    );
  }
  const info = await hostAdapter.processInfo(service.pid);
  if (info && requireExited) {
    throw new Error(`Recovery refused: recorded PID ${service.pid} is live; exited-only recovery cannot stop it`);
  }
  if (!info && allowExited) {
    // Start/recovery may reconcile a confirmed exited process, never a live/reused PID.
    const owners = await hostAdapter.listeningOwners(state.port);
    if (owners.length) throw new Error('Recovery refused: recorded service port has a live owner');
    await removeStaleLease(state, hostAdapter);
    state.service = null;
    state.updatedAt = new Date().toISOString();
    await writeJsonAtomic(statePath, state);
    return {status: 'stopped', home: state.home, pid: service.pid, alreadyExited: true};
  }
  if (!verifyIdentity(info, service)) {
    throw new Error(`Lifecycle ownership is lost for recorded PID ${service.pid}; refusing to stop or clear state`);
  }
  const owners = await hostAdapter.listeningOwners(state.port);
  const other = owners.filter(owner => owner.pid !== service.pid);
  if (other.length) throw new Error(`Refusing to stop PID ${service.pid}: port ${state.port} is owned by another process ${other.map(owner => owner.pid).join(', ')}`);
  try {
    await hostAdapter.gracefulStop(service);
    await waitForExit(service.pid, hostAdapter);
  } catch (error) {
    service.phase = 'degraded';
    state.updatedAt = new Date().toISOString();
    await writeJsonAtomic(statePath, state);
    throw error;
  }
  const remaining = await hostAdapter.listeningOwners(state.port);
  if (remaining.length) throw new Error(`Port ${state.port} is still held after managed service ${service.pid} exited`);
  // DSH may exit before the host's finally runs. Only remove this exact spawn's
  // lease after its identity-checked process and listener have both exited.
  await removeMatchingSpawnLease(pathsFor(state.home).serviceLease, service);
  state.service = null;
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(statePath, state);
  return {status: 'stopped', home: state.home, pid: service.pid, port: state.port, graceful: true};
}

async function loadState(home) {
  const canonical = await normalizeDirectory('Home', home);
  const statePath = pathsFor(canonical).state;
  const state = await readJson(statePath, null);
  if (!state) throw new Error(`Lifecycle is not initialized for Home ${canonical}`);
  if (comparable(resolve(state.home)) !== comparable(canonical)) throw new Error(`Lifecycle state belongs to another Home: ${state.home}`);
  if (state.service) {
    state.service.home ??= state.home;
    state.service.workspace ??= state.workspace;
  }
  return {state, statePath};
}

export async function initializeLifecycle(options, {hostAdapter = windowsHost} = {}) {
  if (process.platform !== 'win32' && hostAdapter === windowsHost) throw new Error('Managed lifecycle currently supports Windows only');
  const home = await normalizeDirectory('Home', options.home, {create: true});
  const workspace = await normalizeDirectory('Workspace', options.workspace, {create: true});
  const runtime = await normalizeDirectory('Runtime', options.runtime ?? defaultRuntime);
  const release = await normalizeDirectory('Release', options.release);
  assertSeparated([['Home', home], ['Workspace', workspace], ['Runtime', runtime], ['Release', release]]);
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535');
  const host = options.host ?? '127.0.0.1';
  if (host !== '127.0.0.1') throw new Error('Lifecycle requires the explicit loopback host 127.0.0.1');
  const permissionMode = options.permissionMode ?? 'workspace-write';
  const {launcher, versions} = await inspectRuntime(runtime);
  const candidate = await validateRelease({home, workspace, release, launcher, permissionMode, runtime});
  return withLock(home, hostAdapter, async () => {
    const paths = pathsFor(home);
    if (await exists(paths.state)) throw new Error(`Lifecycle is already initialized for Home ${home}`);
    const state = {
      home, workspace, runtime, launcher, activeRelease: candidate.release,
      host, port, permissionMode, runtimeVersions: versions, service: null,
      initializedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(paths.state, state);
    return {status: 'initialized', home, workspace, release: candidate.release, runtime, host, port, permissionMode, runtimeVersions: versions};
  });
}

export async function startLifecycle(home, {hostAdapter = windowsHost, timeoutMilliseconds} = {}) {
  const loaded = await loadState(home);
  return withLock(loaded.state.home, hostAdapter, async () => {
    const fresh = (await loadState(loaded.state.home)).state;
    return startUnlocked(fresh, loaded.statePath, hostAdapter, {timeoutMilliseconds});
  });
}

export async function stopLifecycle(home, {hostAdapter = windowsHost} = {}) {
  const loaded = await loadState(home);
  return withLock(loaded.state.home, hostAdapter, async () => {
    const state = (await loadState(loaded.state.home)).state;
    await beginDrain(state.home, 'stop');
    let stopAttempted = false;
    try {
      await sleep(250);
      await assertNoActiveTasks(state.home, 'Stop');
      await sleep(250);
      await assertNoActiveTasks(state.home, 'Stop');
      stopAttempted = true;
      return await stopUnlocked(state, loaded.statePath, hostAdapter);
    } catch (error) {
      if (!stopAttempted) await endDrain(state.home);
      throw error;
    }
  });
}

export async function lifecycleStatus(home, {hostAdapter = windowsHost} = {}) {
  const {state} = await loadState(home);
  if (!state.service) return {status: 'stopped', home: state.home, release: state.activeRelease, runtime: state.runtime, host: state.host, port: state.port};
  const info = await hostAdapter.processInfo(state.service.pid);
  const owners = await hostAdapter.listeningOwners(state.port);
  const identity = verifyIdentity(info, state.service);
  const ownsPort = owners.some(owner => owner.pid === state.service.pid);
  const otherPortOwners = owners.filter(owner => owner.pid !== state.service.pid).map(owner => owner.pid);
  return {
    status: identity && ownsPort && otherPortOwners.length === 0 && state.service.phase === 'running'
      ? 'running' : 'degraded',
    home: state.home, release: state.activeRelease, runtime: state.runtime, host: state.host, port: state.port,
    pid: state.service.pid, phase: state.service.phase, identity, ownsPort, otherPortOwners,
    identityStatus: state.service.identityStatus ?? null,
    cleanupStatus: state.service.cleanupStatus ?? null,
  };
}

export async function recoverLifecycle(home, {hostAdapter = windowsHost, timeoutMilliseconds} = {}) {
  const loaded = await loadState(home);
  return withLock(loaded.state.home, hostAdapter, async () => {
    const state = (await loadState(loaded.state.home)).state;
    if (!state.service) return startUnlocked(state, loaded.statePath, hostAdapter, {timeoutMilliseconds});
    await beginDrain(state.home, 'recover');
    let stopAttempted = false;
    try {
      const serviceExited = !await hostAdapter.processInfo(state.service.pid);
      if (!serviceExited) {
        await sleep(250);
        await assertNoActiveTasks(state.home, 'Recovery');
        await sleep(250);
        await assertNoActiveTasks(state.home, 'Recovery');
      }
      stopAttempted = true;
      // A crash leaves active ledger rows for startup to mark unknown, not replay.
      // Skipping the live-service drain checks permits ONLY exited reconciliation:
      // stopUnlocked rechecks the PID and still enforces port/lease/spawn ownership.
      await stopUnlocked(state, loaded.statePath, hostAdapter, {allowExited: true, requireExited: serviceExited});
      return startUnlocked(state, loaded.statePath, hostAdapter, {timeoutMilliseconds});
    } catch (error) {
      // Before a stop is attempted, removing drain returns the unchanged service to normal operation.
      // Once stop begins, failure is ambiguous (and may retain a degraded live process), so fail
      // closed until a later successful start/recover removes the marker.
      if (!stopAttempted) await endDrain(state.home);
      throw error;
    }
  });
}

export async function upgradeLifecycle(home, candidateRelease, {
  runtime: candidateRuntimeInput, hostAdapter = windowsHost, timeoutMilliseconds,
} = {}) {
  const loaded = await loadState(home);
  return withLock(loaded.state.home, hostAdapter, async () => {
    const state = (await loadState(loaded.state.home)).state;
    const candidateRuntime = await normalizeDirectory('Runtime', candidateRuntimeInput ?? state.runtime);
    const candidateRuntimeInfo = await inspectRuntime(candidateRuntime);
    const candidate = await validateRelease({
      ...state, runtime: candidateRuntime, launcher: candidateRuntimeInfo.launcher, release: candidateRelease,
    });
    if (comparable(candidate.release) === comparable(state.activeRelease)
        && comparable(candidateRuntime) === comparable(state.runtime)) {
      throw new Error('Candidate release and runtime are already active');
    }
    const previous = {
      activeRelease: state.activeRelease, runtime: state.runtime, launcher: state.launcher,
      runtimeVersions: state.runtimeVersions, service: state.service ? structuredClone(state.service) : null,
    };
    const wasRunning = !!state.service;
    await beginDrain(state.home, 'upgrade');
    let stopAttempted = false;
    try {
      await sleep(250);
      await assertNoActiveTasks(state.home, 'Upgrade');
      await sleep(250);
      await assertNoActiveTasks(state.home, 'Upgrade');
      if (wasRunning) {
        stopAttempted = true;
        await stopUnlocked(state, loaded.statePath, hostAdapter);
      }
      state.activeRelease = candidate.release;
      state.runtime = candidateRuntime;
      state.launcher = candidateRuntimeInfo.launcher;
      state.runtimeVersions = candidateRuntimeInfo.versions;
      state.updatedAt = new Date().toISOString();
      await writeJsonAtomic(loaded.statePath, state);
      if (wasRunning) await startUnlocked(state, loaded.statePath, hostAdapter, {timeoutMilliseconds});
      else await endDrain(state.home);
      return {
        status: 'upgraded', home: state.home, previousRelease: previous.activeRelease,
        previousRuntime: previous.runtime, release: candidate.release, runtime: candidateRuntime, running: wasRunning,
      };
    } catch (upgradeError) {
      // A failed candidate may still be alive. Preserve its durable ownership
      // facts; rollback must never erase them and start a second process.
      if (state.service?.cleanupStatus === 'failed'
          && state.service.controlPipe !== previous.service?.controlPipe) {
        throw new AggregateError([upgradeError],
          `Upgrade failed; candidate cleanup is unresolved for Home ${state.home}; rollback was not started`);
      }
      state.activeRelease = previous.activeRelease;
      state.runtime = previous.runtime;
      state.launcher = previous.launcher;
      state.runtimeVersions = previous.runtimeVersions;
      const previousInfo = previous.service ? await hostAdapter.processInfo(previous.service.pid) : null;
      const previousStillRunning = previous.service && verifyIdentity(previousInfo, previous.service);
      if (previousStillRunning && stopAttempted) previous.service.phase = 'degraded';
      state.service = previousStillRunning ? previous.service : null;
      state.updatedAt = new Date().toISOString();
      await writeJsonAtomic(loaded.statePath, state);
      if (!wasRunning || previousStillRunning) {
        if (!stopAttempted) await endDrain(state.home);
        throw upgradeError;
      }
      try {
        await startUnlocked(state, loaded.statePath, hostAdapter, {timeoutMilliseconds});
      } catch (recoveryError) {
        throw new AggregateError([upgradeError, recoveryError],
          `Upgrade failed and previous release could not be restored for Home ${state.home}`);
      }
      const error = new Error(`Upgrade failed; previous runtime, release and configuration were restored: ${upgradeError.message}`);
      error.cause = upgradeError;
      throw error;
    }
  });
}

function parseArgs(argv) {
  const command = argv[0];
  if (!['init', 'start', 'status', 'stop', 'recover', 'upgrade'].includes(command)) {
    throw new Error('Usage: lifecycle.mjs <init|start|status|stop|recover|upgrade> --home <path> [options]');
  }
  const options = {command};
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    const key = {
      '--home': 'home', '--workspace': 'workspace', '--runtime': 'runtime', '--release': 'release',
      '--host': 'host', '--port': 'port', '--permission-mode': 'permissionMode',
    }[arg];
    if (!key) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`Missing value for ${arg}`);
    options[key] = value;
  }
  if (!options.home) throw new Error('Missing required --home');
  if (command === 'init') for (const key of ['workspace', 'release', 'port']) if (!options[key]) throw new Error(`Missing required --${key}`);
  if (command === 'upgrade' && !options.release) throw new Error('Missing required --release');
  return options;
}

if (isDirectRun) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = options.command === 'init' ? await initializeLifecycle(options)
      : options.command === 'start' ? await startLifecycle(options.home)
      : options.command === 'status' ? await lifecycleStatus(options.home)
      : options.command === 'stop' ? await stopLifecycle(options.home)
      : options.command === 'recover' ? await recoverLifecycle(options.home)
      : await upgradeLifecycle(options.home, options.release, {runtime: options.runtime});
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Lifecycle failed: ${error.message}`);
    if (error instanceof AggregateError) for (const nested of error.errors) console.error(`- ${nested.message}`);
    process.exitCode = 1;
  }
}
