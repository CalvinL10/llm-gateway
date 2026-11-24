import assert from 'node:assert/strict';
import {access, mkdir, readFile, readdir, symlink, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import test from 'node:test';
import {TaskLedger} from '../../ledger.js';
import {createTestScratch} from '../fixtures/test-runtime.mjs';
import {
  MaintenanceMutationError, applyDeletePlan, backupData, createDeletePlan, exportAudit,
  inspectMaintenance, maintenanceIo, restoreData,
} from '../../ops/maintenance.mjs';

const at = '2026-09-21T12:00:00.000Z';

async function pathExists(path) {
  try { await access(path); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

const hostAdapter = {
  async processInfo(pid) {
    return pid === process.pid
      ? {pid, creation:'maintenance-test-controller', executable:process.execPath, commandLine:process.argv.join(' ')}
      : null;
  },
  async listeningOwners() { return []; },
};

function task(id, status, {secret = '', admitted = false} = {}) {
  const attemptStatus = status;
  const active = ['queued', 'running', 'cancel-requested'].includes(status);
  const call = admitted ? {
    id:`call-${id}`, attemptId:id, sessionId:`session-${id}`, parentSessionId:null,
    provider:'fixture', model:'planner', reasoningEffort:null, purpose:null,
    measurementKind:'llm-stream-admission', admittedAt:at, adapterBoundaryPreparedAt:at,
    firstResponseAt:null, endedAt:null, outcome:'admitted', usage:null, usageStatus:'missing',
    httpAttempts:{observability:'bounded', count:0, basis:'next-invocation-not-prepared'},
  } : null;
  return {
    id, sessionId:`session-${id}`, workspaceId:'synthetic-workspace', goal:`goal-${secret}`,
    policy:{maxCalls:3, allowedRoutes:[{provider:'fixture', model:'planner'}]},
    status, createdAt:at, endedAt:active ? null : at,
    calls:call ? [call] : [], denials:[], artifact:secret ? {summary:`artifact-${secret}`} : null,
    toolOperations:[], approvalOperations:[], failureCode:null, failureStage:null,
    attempts:[{
      id, kind:'initial', instruction:`instruction-${secret}`, additionalCalls:0,
      budgetBefore:3, budgetAfter:3, callStart:0, callEnd:active ? null : (call ? 1 : 0),
      status:attemptStatus, queuedAt:at, startedAt:status === 'queued' ? null : at,
      endedAt:active ? null : at, artifact:null, failureCode:null, failureStage:null,
    }],
  };
}

async function createSyntheticHome(t) {
  const {path: base, remove} = await createTestScratch('p11-maintenance-');
  t.after(remove);
  const home = resolve(base, 'home');
  await mkdir(resolve(home, '.gateway-lifecycle'), {recursive:true});
  await mkdir(resolve(home, 'storages'), {recursive:true});
  await mkdir(resolve(home, 'sessions', 'nested'), {recursive:true});
  const state = {
    home, workspace:resolve(base, 'workspace'), runtime:resolve(base, 'runtime'),
    launcher:resolve(base, 'runtime', 'launcher.js'), activeRelease:resolve(base, 'release'),
    host:'127.0.0.1', port:39111, permissionMode:'workspace-write', runtimeVersions:{},
    service:null, initializedAt:at, updatedAt:at,
  };
  await writeFile(resolve(home, '.gateway-lifecycle', 'service.json'), JSON.stringify(state, null, 2) + '\n');
  return {base, home, statePath:resolve(home, '.gateway-lifecycle', 'service.json')};
}

async function writeManagedFixture(home, {secret = 'PRIVATE-SENTINEL'} = {}) {
  const tasks = {
    queued:task('queued', 'queued', {secret}),
    running:task('running', 'running', {secret, admitted:true}),
    cancel:task('cancel', 'cancel-requested', {secret, admitted:true}),
    completed:task('completed', 'completed', {secret}),
  };
  const ledgerPath = resolve(home, 'storages', 'gateway_agent_tasks.json');
  const sessionPath = resolve(home, 'sessions', 'nested', 'transcript.jsonl');
  const credentialPath = resolve(home, 'credentials.json');
  const configPath = resolve(home, 'config.local.json');
  await writeFile(ledgerPath, JSON.stringify({tables:{tasks}}, null, 2) + '\n');
  await writeFile(sessionPath, `{"message":"session-${secret}"}\n`);
  await writeFile(credentialPath, `{"token":"credential-${secret}"}\n`);
  await writeFile(configPath, '{"preserve":true}\n');
  return {tasks, ledgerPath, sessionPath, credentialPath, configPath};
}

function memoryTable(values) {
  const records = new Map(Object.entries(values).map(([id, value]) => [id, structuredClone(value)]));
  return {
    records,
    get:id => records.get(id),
    entries:() => records.entries(),
    async put(id, value) { records.set(id, structuredClone(value)); },
  };
}

async function readBytes(path) { return Buffer.from(await readFile(path)); }

function normalized(path) { return path.replaceAll('\\', '/'); }

test('stopped-state backup and restore preserve exact managed bytes without replaying interrupted tasks', async t => {
  const {base, home, statePath} = await createSyntheticHome(t);
  const fixture = await writeManagedFixture(home);
  const originalLedger = await readBytes(fixture.ledgerPath);
  const originalSession = await readBytes(fixture.sessionPath);
  const originalCredential = await readBytes(fixture.credentialPath);
  const backup = resolve(base, 'backup');

  const backedUp = await backupData(home, backup, {hostAdapter});
  assert.equal(backedUp.fileCount, 2);
  assert.equal(await pathExists(resolve(backup, 'manifest.json')), true);

  await writeFile(fixture.ledgerPath, '{"tables":{"tasks":{}}}\n');
  await writeFile(fixture.sessionPath, '{"message":"mutated"}\n');
  await writeFile(fixture.credentialPath, '{"token":"must-stay-mutated"}\n');
  const credentialBeforeRestore = await readBytes(fixture.credentialPath);

  const restored = await restoreData(home, backup, {hostAdapter});
  assert.equal(restored.lifecycle, 'stopped');
  assert.equal(restored.automaticReplay, false);
  assert.deepEqual(restored.interruptedTasks, [
    {id:'queued', status:'queued'},
    {id:'running', status:'running'},
    {id:'cancel', status:'cancel-requested'},
  ]);
  assert.deepEqual(await readBytes(fixture.ledgerPath), originalLedger);
  assert.deepEqual(await readBytes(fixture.sessionPath), originalSession);
  assert.deepEqual(await readBytes(fixture.credentialPath), credentialBeforeRestore,
    'credentials outside the managed scope must not be copied from the backup');
  assert.notDeepEqual(await readBytes(fixture.credentialPath), originalCredential);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).service, null,
    'restore must not start or rewrite lifecycle ownership');

  const restoredTasks = JSON.parse(await readFile(fixture.ledgerPath, 'utf8')).tables.tasks;
  const table = memoryTable(restoredTasks);
  const beforeCalls = [...table.records.values()].reduce((sum, value) => sum + value.calls.length, 0);
  await new TaskLedger(table).recover();
  assert.deepEqual(['queued','running','cancel'].map(id => table.records.get(id).status),
    ['unknown','unknown','unknown']);
  assert.equal(table.records.get('completed').status, 'completed');
  assert.equal([...table.records.values()].reduce((sum, value) => sum + value.calls.length, 0), beforeCalls,
    'recovery changes uncertainty facts but never adds or replays a model call');
  assert.equal(table.records.get('running').calls[0].outcome, 'unknown');
  assert.equal(table.records.get('cancel').calls[0].outcome, 'unknown');

  const inspection = await inspectMaintenance(home, {hostAdapter});
  assert.equal(inspection.lifecycle, 'stopped');
  assert.match(inspection.recoveryRule, /never replayed automatically/);
});

test('audit export is user-executable and excludes task, artifact, transcript, and credential content', async t => {
  const {base, home} = await createSyntheticHome(t);
  const sentinel = 'P11-A-SECRET-DO-NOT-EXPORT';
  await writeManagedFixture(home, {secret:sentinel});
  const output = resolve(base, 'audit-export.json');

  const result = await exportAudit(home, output, {hostAdapter});
  assert.equal(result.taskCount, 4);
  const raw = await readFile(output, 'utf8');
  assert.equal(raw.includes(sentinel), false);
  assert.equal(raw.includes(`goal-${sentinel}`), false);
  assert.equal(raw.includes(`instruction-${sentinel}`), false);
  assert.equal(raw.includes(`artifact-${sentinel}`), false);
  assert.equal(raw.includes(`session-${sentinel}`), false);
  assert.equal(raw.includes(`credential-${sentinel}`), false);
  const value = JSON.parse(raw);
  assert.equal(value.format, 'gateway-agent-audit-v1');
  assert.deepEqual(value.tasks.map(item => item.id), ['queued','running','cancel','completed']);
  assert.equal(value.tasks.find(item => item.id === 'running').calls.length, 1);
  assert.equal(value.tasks.find(item => item.id === 'running').status, 'running');
});

test('two-phase deletion exposes exact scope, refuses stale or mismatched approval, and preserves out-of-scope data', async t => {
  const {base, home, statePath} = await createSyntheticHome(t);
  const fixture = await writeManagedFixture(home);
  const wrongHome = resolve(base, 'wrong-home');
  await mkdir(wrongHome);
  const planPath = resolve(base, 'delete-plan.json');
  const planned = await createDeletePlan(home, planPath, {hostAdapter});
  const plannedPaths = planned.entries.map(entry => entry.path);
  assert.deepEqual(plannedPaths, [
    'sessions', 'sessions/nested', 'sessions/nested/transcript.jsonl',
    'storages/gateway_agent_tasks.json',
  ]);
  assert.equal(planned.entries.find(entry => entry.path === 'storages/gateway_agent_tasks.json').bytes,
    (await readBytes(fixture.ledgerPath)).byteLength);
  assert.equal(plannedPaths.some(path => path.includes('.gateway-lifecycle')), false);
  assert.equal(plannedPaths.some(path => path.includes('credential')), false);
  await assert.rejects(applyDeletePlan(planPath, wrongHome, {hostAdapter}), /does not exactly match/);

  await writeFile(fixture.sessionPath, '{"message":"scope changed after review"}\n');
  await assert.rejects(applyDeletePlan(planPath, home, {hostAdapter}), /scope changed after planning/);
  assert.equal(await pathExists(fixture.ledgerPath), true);
  assert.equal(await pathExists(fixture.sessionPath), true);

  const refreshedPlan = resolve(base, 'delete-plan-refreshed.json');
  await createDeletePlan(home, refreshedPlan, {hostAdapter});
  const deleted = await applyDeletePlan(refreshedPlan, home, {hostAdapter});
  assert.equal(deleted.fileCount, 2);
  assert.equal(await pathExists(fixture.ledgerPath), false);
  assert.equal(await pathExists(resolve(home, 'sessions')), false);
  assert.equal(await pathExists(statePath), true);
  assert.equal(await pathExists(fixture.credentialPath), true);
  assert.equal(await pathExists(fixture.configPath), true);
});

test('backup disk-full failure leaves the source intact and removes staging output', async t => {
  const {base, home} = await createSyntheticHome(t);
  const fixture = await writeManagedFixture(home);
  const sourceBefore = await readBytes(fixture.ledgerPath);
  const output = resolve(base, 'disk-full-backup');
  const io = {...maintenanceIo, async copyFile() {
    const error = new Error('synthetic disk full');
    error.code = 'ENOSPC';
    throw error;
  }};

  await assert.rejects(backupData(home, output, {hostAdapter, io}), error => error?.code === 'ENOSPC');
  assert.equal(await pathExists(output), false);
  assert.deepEqual(await readBytes(fixture.ledgerPath), sourceBefore);
  const leftovers = (await readdir(base)).filter(name => name.startsWith('.disk-full-backup.staging-'));
  assert.deepEqual(leftovers, []);
});

test('read-only restore failure rolls the original pre-restore data back intact', async t => {
  const {base, home} = await createSyntheticHome(t);
  const fixture = await writeManagedFixture(home);
  const backup = resolve(base, 'restore-source');
  await backupData(home, backup, {hostAdapter});
  await writeFile(fixture.ledgerPath, '{"tables":{"tasks":{"local":{"id":"local"}}}}\n');
  await writeFile(fixture.sessionPath, '{"message":"local pre-restore data"}\n');
  const ledgerBefore = await readBytes(fixture.ledgerPath);
  const sessionBefore = await readBytes(fixture.sessionPath);
  let failed = false;
  const io = {...maintenanceIo, async rename(from, to) {
    if (!failed && normalized(from).includes('/.gateway-restore-stage-')
        && normalized(to).endsWith('/storages/gateway_agent_tasks.json')) {
      failed = true;
      const error = new Error('synthetic read-only destination');
      error.code = 'EROFS';
      throw error;
    }
    return maintenanceIo.rename(from, to);
  }};

  await assert.rejects(restoreData(home, backup, {hostAdapter, io}), error => {
    assert.equal(error instanceof MaintenanceMutationError, true);
    assert.equal(error.message, 'Restore failed; original data was restored');
    assert.equal(error.details.originalDataRestored, true);
    assert.equal(error.cause?.code, 'EROFS');
    return true;
  });
  assert.equal(failed, true);
  assert.deepEqual(await readBytes(fixture.ledgerPath), ledgerBefore);
  assert.deepEqual(await readBytes(fixture.sessionPath), sessionBefore);
  assert.deepEqual((await readdir(base)).filter(name => name.startsWith('.gateway-restore-')), []);
});

test('read-only delete move failure reports zero side effects and restores exact data', async t => {
  const {base, home} = await createSyntheticHome(t);
  const fixture = await writeManagedFixture(home);
  const plan = resolve(base, 'read-only-delete.json');
  await createDeletePlan(home, plan, {hostAdapter});
  const ledgerBefore = await readBytes(fixture.ledgerPath);
  const sessionBefore = await readBytes(fixture.sessionPath);
  let failed = false;
  const io = {...maintenanceIo, async rename(from, to) {
    if (!failed && normalized(from).startsWith(`${normalized(home)}/`)
        && normalized(to).includes('/.gateway-maintenance-delete-')) {
      failed = true;
      const error = new Error('synthetic read-only filesystem');
      error.code = 'EROFS';
      throw error;
    }
    return maintenanceIo.rename(from, to);
  }};

  await assert.rejects(applyDeletePlan(plan, home, {hostAdapter, io}), error => {
    assert.equal(error instanceof MaintenanceMutationError, true);
    assert.equal(error.message, 'Delete failed; original data was restored');
    assert.deepEqual(error.details.movedRoots, []);
    assert.deepEqual(error.details.rollbackErrors, []);
    assert.equal(error.cause?.code, 'EROFS');
    return true;
  });
  assert.equal(failed, true);
  assert.deepEqual(await readBytes(fixture.ledgerPath), ledgerBefore);
  assert.deepEqual(await readBytes(fixture.sessionPath), sessionBefore);
});

test('backup, restore, export, and deletion refuse degraded lifecycle ownership', async t => {
  const {base, home, statePath} = await createSyntheticHome(t);
  await writeManagedFixture(home);
  const backup = resolve(base, 'stopped-backup');
  const plan = resolve(base, 'stopped-delete-plan.json');
  await backupData(home, backup, {hostAdapter});
  await createDeletePlan(home, plan, {hostAdapter});

  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.service = {
    pid:424242, creation:'missing-process', executable:process.execPath,
    launcher:state.launcher, patch:resolve(base, 'release', 'subscription.patch.json'),
    phase:'running', host:state.host, port:state.port,
  };
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
  assert.equal((await inspectMaintenance(home, {hostAdapter})).lifecycle, 'degraded');

  await assert.rejects(backupData(home, resolve(base, 'refused-backup'), {hostAdapter}), /current status is degraded/);
  await assert.rejects(exportAudit(home, resolve(base, 'refused-export.json'), {hostAdapter}), /current status is degraded/);
  await assert.rejects(restoreData(home, backup, {hostAdapter}), /current status is degraded/);
  await assert.rejects(applyDeletePlan(plan, home, {hostAdapter}), /current status is degraded/);
});

test('delete rollback failure retains the only surviving data in its reported quarantine', async t => {
  const {base, home} = await createSyntheticHome(t);
  const fixture = await writeManagedFixture(home);
  const before = await readBytes(fixture.ledgerPath);
  const plan = resolve(base, 'compound-delete.json');
  await createDeletePlan(home, plan, {hostAdapter});
  const io = {...maintenanceIo, async rename(from, to) {
    if (from === resolve(home, 'sessions') || normalized(from).includes('/.gateway-maintenance-delete-'))
      throw Object.assign(new Error('synthetic move/rollback refusal'), {code:'EROFS'});
    return maintenanceIo.rename(from, to);
  }};
  let details;
  await assert.rejects(applyDeletePlan(plan, home, {hostAdapter, io}), error => {
    assert.match(error.message, /rollback was incomplete/);
    details = error.details;
    return true;
  });
  assert.equal(typeof details.quarantine, 'string');
  assert.deepEqual(await readBytes(resolve(details.quarantine, 'storages/gateway_agent_tasks.json')), before);
  assert.equal(await pathExists(fixture.ledgerPath), false);
  assert.equal(await pathExists(fixture.sessionPath), true);
});

test('post-restore cleanup failure never rolls back after deleting original backup bytes', async t => {
  const {base, home} = await createSyntheticHome(t);
  const fixture = await writeManagedFixture(home);
  const expected = await readBytes(fixture.ledgerPath);
  const backup = resolve(base, 'cleanup-source');
  await backupData(home, backup, {hostAdapter});
  await writeFile(fixture.ledgerPath, '{"tables":{"tasks":{}}}');
  const io = {...maintenanceIo, async rm(path, options) {
    if (normalized(path).includes('/.gateway-restore-rollback-')) {
      await maintenanceIo.rm(resolve(path, 'storages'), {recursive:true, force:true});
      throw Object.assign(new Error('synthetic partial cleanup refusal'), {code:'EROFS'});
    }
    return maintenanceIo.rm(path, options);
  }};
  await assert.rejects(restoreData(home, backup, {hostAdapter, io}), error => {
    assert.match(error.message, /restored.*cleanup/i);
    assert.equal(error.details.activeDataRestored, true);
    assert.equal(typeof error.details.rollback, 'string');
    return true;
  });
  assert.deepEqual(await readBytes(fixture.ledgerPath), expected);
  assert.equal(await pathExists(fixture.sessionPath), true);
});

test('failed backup cleanup reports sensitive staging bytes instead of hiding them', async t => {
  const {base, home} = await createSyntheticHome(t);
  await writeManagedFixture(home);
  const io = {...maintenanceIo, async copyFile(from, to) {
    await maintenanceIo.copyFile(from, to);
    throw Object.assign(new Error('synthetic disk full after copy'), {code:'ENOSPC'});
  }, async rm() { throw Object.assign(new Error('synthetic cleanup refusal'), {code:'EROFS'}); }};
  let staging;
  await assert.rejects(backupData(home, resolve(base, 'partial-backup'), {hostAdapter, io}), error => {
    assert.ok(error instanceof MaintenanceMutationError);
    assert.equal(error.cause.code, 'ENOSPC');
    staging = error.details.staging;
    return true;
  });
  assert.equal(await pathExists(resolve(staging, 'data/sessions/nested/transcript.jsonl')), true);
});

test('maintenance refuses a junction in a managed ancestor without touching its external data', async t => {
  const {base, home} = await createSyntheticHome(t);
  const fixture = await writeManagedFixture(home);
  const backup = resolve(base, 'safe-backup');
  await backupData(home, backup, {hostAdapter});
  const outside = resolve(base, 'outside-storage');
  await maintenanceIo.rename(resolve(home, 'storages'), outside);
  await symlink(outside, resolve(home, 'storages'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = await readBytes(resolve(outside, 'gateway_agent_tasks.json'));
  await assert.rejects(exportAudit(home, resolve(base, 'refused-export.json'), {hostAdapter}), /symbolic link/);
  await assert.rejects(backupData(home, resolve(base, 'refused-backup'), {hostAdapter}), /symbolic link/);
  await assert.rejects(createDeletePlan(home, resolve(base, 'refused-plan.json'), {hostAdapter}), /symbolic link/);
  await assert.rejects(restoreData(home, backup, {hostAdapter}), /symbolic link/);
  assert.deepEqual(await readBytes(resolve(outside, 'gateway_agent_tasks.json')), before);
  assert.equal(await pathExists(fixture.sessionPath), true);
});
