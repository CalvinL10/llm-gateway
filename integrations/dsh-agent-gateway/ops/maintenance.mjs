import {constants} from 'node:fs';
import {
  access, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile,
} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {basename, dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {auditExport} from '../report.js';
import {lifecycleStatus, windowsHost, withLifecycleOperationLock} from './lifecycle.mjs';

const backupFormat = 'llm-gateway-maintenance-backup-v1';
const deleteFormat = 'llm-gateway-maintenance-delete-plan-v1';
const activeStatuses = new Set(['queued', 'running', 'cancel-requested']);
const directRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
export const maintenanceIo = {access, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile};
const defaultIo = maintenanceIo;
const dataRoots = ['storages/gateway_agent_tasks.json', 'sessions'];

export const maintenanceHelp = `Usage: node maintenance.mjs <command> [options]
       node maintenance.mjs --help | -h

Commands and required options:
  inspect      --home <path>
  export       --home <path> --output <path>
  backup       --home <path> --output <path>
  restore      --home <path> --backup <path>
  delete-plan  --home <path> --output <path>
  delete       --plan <path> --confirm-home <path>

Requirements:
  inspect is read-only and may run in any lifecycle state.
  backup and every mutation command (restore and delete) require the managed
  gateway for the Home to be stopped. export and delete-plan also require the
  stopped state. Back up Home data before running restore or delete.
  backup, restore, and delete outputs/inputs must remain outside Home as
  applicable. Data backups include only task ledger and session data;
  credentials and configuration are excluded from data backups.

Use --help or -h by itself to display this help without inspecting or modifying a Home.`;

export class MaintenanceMutationError extends Error {
  constructor(message, details, options) {
    super(message, options);
    this.name = 'MaintenanceMutationError';
    this.details = structuredClone(details);
  }
}

async function exists(path, io = defaultIo) {
  try { await io.access(path, constants.F_OK); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function safeRelative(value) {
  if (typeof value !== 'string' || !value || isAbsolute(value)) return false;
  const normalized = value.replaceAll('\\', '/');
  return !normalized.split('/').some(part => !part || part === '.' || part === '..');
}

function inside(parent, child) {
  const relation = relative(parent, child);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

async function canonicalHome(home, io = defaultIo) {
  const absolute = resolve(home);
  const canonical = await io.realpath(absolute).catch(error => {
    if (error?.code === 'ENOENT') throw new Error(`Home does not exist: ${absolute}`);
    throw error;
  });
  if (!(await io.stat(canonical)).isDirectory()) throw new Error(`Home is not a directory: ${absolute}`);
  return canonical;
}

async function prepareNewOutput(home, output, io = defaultIo) {
  if (typeof output !== 'string' || !output.trim()) throw new Error('Output must be a non-empty path');
  const absolute = resolve(output);
  await io.mkdir(dirname(absolute), {recursive:true});
  const parent = await io.realpath(dirname(absolute));
  const canonicalOutput = resolve(parent, basename(absolute));
  if (inside(home, canonicalOutput)) throw new Error(`Output must be outside Home: ${canonicalOutput}`);
  if (await exists(canonicalOutput, io)) throw new Error(`Output already exists: ${canonicalOutput}`);
  return canonicalOutput;
}

async function inventoryPath(root, absolute, relativePath, entries, io) {
  const info = await io.lstat(absolute);
  if (info.isSymbolicLink()) throw new Error(`Maintenance scope cannot include a symbolic link: ${relativePath}`);
  if (info.isFile()) {
    entries.push({path:relativePath.replaceAll('\\', '/'), type:'file', bytes:info.size});
    return;
  }
  if (!info.isDirectory()) throw new Error(`Maintenance scope contains an unsupported entry: ${relativePath}`);
  entries.push({path:relativePath.replaceAll('\\', '/'), type:'directory', bytes:0});
  const names = (await io.readdir(absolute)).sort((left, right) => left.localeCompare(right));
  for (const name of names) await inventoryPath(root, resolve(absolute, name), `${relativePath}/${name}`, entries, io);
}

async function assertPlainPath(home, relativePath, io) {
  let current = home;
  for (const part of relativePath.split('/')) {
    current = resolve(current, part);
    let info;
    try { info = await io.lstat(current); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) throw new Error(`Maintenance scope cannot include a symbolic link: ${current}`);
  }
}

export async function inventoryData(home, {io = defaultIo} = {}) {
  const canonical = await canonicalHome(home, io);
  const entries = [];
  for (const root of dataRoots) {
    await assertPlainPath(canonical, root, io);
    const absolute = resolve(canonical, ...root.split('/'));
    if (await exists(absolute, io)) await inventoryPath(canonical, absolute, root, entries, io);
  }
  entries.sort((left, right) => left.path.localeCompare(right.path) || left.type.localeCompare(right.type));
  return {home:canonical, entries, fileCount:entries.filter(entry => entry.type === 'file').length,
    directoryCount:entries.filter(entry => entry.type === 'directory').length,
    totalBytes:entries.reduce((sum, entry) => sum + entry.bytes, 0)};
}

function validateEntries(entries, label) {
  if (!Array.isArray(entries)) throw new Error(`${label} entries must be an array`);
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || !safeRelative(entry.path) || !['file','directory'].includes(entry.type)
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0)
      throw new Error(`${label} contains an invalid entry`);
    if (!dataRoots.some(root => entry.path === root || entry.path.startsWith(root + '/')))
      throw new Error(`${label} entry is outside the maintenance scope: ${entry.path}`);
    if (seen.has(entry.path)) throw new Error(`${label} contains a duplicate entry: ${entry.path}`);
    seen.add(entry.path);
  }
}

function sameEntries(left, right) {
  return JSON.stringify(left.map(({path, type, bytes}) => ({path, type, bytes})))
    === JSON.stringify(right.map(({path, type, bytes}) => ({path, type, bytes})));
}

async function requireStopped(home, hostAdapter) {
  const status = await lifecycleStatus(home, {hostAdapter});
  if (status.status !== 'stopped') {
    const pid = status.pid ? ` (PID ${status.pid})` : '';
    throw new Error(`Maintenance requires the managed gateway for Home ${home} to be stopped; current status is ${status.status}${pid}`);
  }
  return status;
}

async function writeJsonNew(path, value, io) {
  const handle = await io.open(path, 'wx');
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); }
  finally { await handle.close(); }
}

async function writeJsonAtomicNew(path, value, io) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeJsonNew(temporary, value, io);
    await io.rename(temporary, path);
  } catch (error) {
    await io.unlink(temporary).catch(() => {});
    throw error;
  }
}

async function copyInventory(sourceRoot, targetRoot, entries, io) {
  await io.mkdir(targetRoot, {recursive:true});
  for (const entry of entries.filter(value => value.type === 'directory'))
    await io.mkdir(resolve(targetRoot, ...entry.path.split('/')), {recursive:true});
  for (const entry of entries.filter(value => value.type === 'file')) {
    const target = resolve(targetRoot, ...entry.path.split('/'));
    await io.mkdir(dirname(target), {recursive:true});
    await io.copyFile(resolve(sourceRoot, ...entry.path.split('/')), target);
  }
}

async function readLedgerTasks(home, io = defaultIo) {
  await assertPlainPath(home, 'storages/gateway_agent_tasks.json', io);
  const path = resolve(home, 'storages/gateway_agent_tasks.json');
  if (!await exists(path, io)) return [];
  const value = JSON.parse(await io.readFile(path, 'utf8'));
  const table = value?.tables?.tasks;
  if (!table || typeof table !== 'object' || Array.isArray(table))
    throw new Error(`Cannot read gateway task table from ${path}`);
  return Object.values(table);
}

export async function inspectMaintenance(home, {hostAdapter = windowsHost, io = defaultIo} = {}) {
  return withLifecycleOperationLock(home, async ({home:lockedHome}) => {
    const [status, inventory, tasks] = await Promise.all([
      lifecycleStatus(lockedHome, {hostAdapter}), inventoryData(lockedHome, {io}), readLedgerTasks(lockedHome, io),
    ]);
    const activeTasks = tasks.filter(task => activeStatuses.has(task?.status)).map(task => ({id:task.id, status:task.status}));
    return {home:lockedHome, lifecycle:status.status, data:inventory, activeTasks,
      recoveryRule:'Restored queued, running, or cancel-requested tasks become unknown on gateway startup and are never replayed automatically.'};
  }, {hostAdapter});
}

export async function exportAudit(home, output, {hostAdapter = windowsHost, io = defaultIo} = {}) {
  return withLifecycleOperationLock(home, async ({home:lockedHome}) => {
    await requireStopped(lockedHome, hostAdapter);
    const destination = await prepareNewOutput(lockedHome, output, io);
    const tasks = await readLedgerTasks(lockedHome, io);
    const value = {...auditExport(tasks), exportedAt:new Date().toISOString(), sourceHome:lockedHome};
    await writeJsonAtomicNew(destination, value, io);
    return {operation:'export', home:lockedHome, output:destination, taskCount:tasks.length,
      note:'The export contains redacted audit facts, not session transcripts, task instructions, artifacts, or credentials.'};
  }, {hostAdapter});
}

export async function backupData(home, output, {hostAdapter = windowsHost, io = defaultIo} = {}) {
  return withLifecycleOperationLock(home, async ({home:lockedHome}) => {
    await requireStopped(lockedHome, hostAdapter);
    const destination = await prepareNewOutput(lockedHome, output, io);
    const inventory = await inventoryData(lockedHome, {io});
    const staging = resolve(dirname(destination), `.${destination.split(sep).at(-1)}.staging-${randomUUID()}`);
    const manifest = {format:backupFormat, createdAt:new Date().toISOString(), sourceHome:lockedHome,
      entries:inventory.entries, fileCount:inventory.fileCount, directoryCount:inventory.directoryCount,
      totalBytes:inventory.totalBytes};
    try {
      await io.mkdir(staging, {recursive:false});
      await copyInventory(lockedHome, resolve(staging, 'data'), inventory.entries, io);
      await io.writeFile(resolve(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {flag:'wx'});
      await io.rename(staging, destination);
    } catch (error) {
      try { await io.rm(staging, {recursive:true, force:true}); }
      catch (cleanupError) {
        throw new MaintenanceMutationError('Backup failed and sensitive staging data could not be removed', {
          home:lockedHome, staging, cleanupError:cleanupError.message,
        }, {cause:error});
      }
      throw error;
    }
    return {operation:'backup', home:lockedHome, output:destination, fileCount:inventory.fileCount,
      directoryCount:inventory.directoryCount, totalBytes:inventory.totalBytes};
  }, {hostAdapter});
}

async function loadBackup(backup, io) {
  const canonical = await io.realpath(resolve(backup)).catch(error => {
    if (error?.code === 'ENOENT') throw new Error(`Backup does not exist: ${resolve(backup)}`);
    throw error;
  });
  if (!(await io.stat(canonical)).isDirectory()) throw new Error(`Backup is not a directory: ${canonical}`);
  const manifest = JSON.parse(await io.readFile(resolve(canonical, 'manifest.json'), 'utf8'));
  if (manifest?.format !== backupFormat) throw new Error(`Unsupported backup format: ${manifest?.format ?? 'missing'}`);
  validateEntries(manifest.entries, 'Backup manifest');
  const actual = await inventoryData(resolve(canonical, 'data'), {io});
  if (!sameEntries(manifest.entries, actual.entries)) throw new Error('Backup data does not match its manifest');
  return {backup:canonical, manifest, data:resolve(canonical, 'data')};
}

async function rollbackRestore(home, staging, rollback, operations, io) {
  const errors = [];
  for (const operation of [...operations].reverse()) {
    const target = resolve(home, ...operation.path.split('/'));
    const saved = resolve(rollback, ...operation.path.split('/'));
    try {
      if (operation.installed && await exists(target, io)) await io.rm(target, {recursive:true, force:true});
      if (operation.originalMoved && await exists(saved, io)) {
        await io.mkdir(dirname(target), {recursive:true});
        await io.rename(saved, target);
      }
    } catch (error) { errors.push(error); }
  }
  await io.rm(staging, {recursive:true, force:true}).catch(error => errors.push(error));
  if (!errors.length) await io.rm(rollback, {recursive:true, force:true}).catch(error => errors.push(error));
  return errors;
}

export async function restoreData(home, backup, {hostAdapter = windowsHost, io = defaultIo} = {}) {
  return withLifecycleOperationLock(home, async ({home:lockedHome}) => {
    await requireStopped(lockedHome, hostAdapter);
    const loaded = await loadBackup(backup, io);
    if (inside(lockedHome, loaded.backup)) throw new Error('Backup must be outside Home');
    await inventoryData(lockedHome, {io});
    // Validate the restored ledger before replacing any active data.
    const tasks = await readLedgerTasks(loaded.data, io);
    const parent = dirname(lockedHome), staging = resolve(parent, `.gateway-restore-stage-${randomUUID()}`);
    const rollback = resolve(parent, `.gateway-restore-rollback-${randomUUID()}`);
    const operations = [];
    try {
      await io.mkdir(staging, {recursive:false});
      await io.mkdir(rollback, {recursive:false});
      await copyInventory(loaded.data, staging, loaded.manifest.entries, io);
      for (const path of dataRoots) {
        const target = resolve(lockedHome, ...path.split('/'));
        const staged = resolve(staging, ...path.split('/'));
        const saved = resolve(rollback, ...path.split('/'));
        const operation = {path, originalMoved:false, installed:false};
        operations.push(operation);
        if (await exists(target, io)) {
          await io.mkdir(dirname(saved), {recursive:true});
          await io.rename(target, saved);
          operation.originalMoved = true;
        }
        if (await exists(staged, io)) {
          await io.mkdir(dirname(target), {recursive:true});
          await io.rename(staged, target);
          operation.installed = true;
        }
      }
    } catch (error) {
      const rollbackErrors = await rollbackRestore(lockedHome, staging, rollback, operations, io);
      if (rollbackErrors.length) throw new MaintenanceMutationError('Restore failed and rollback was incomplete', {
        home:lockedHome, backup:loaded.backup, rollback, rollbackErrors:rollbackErrors.map(value => value.message),
      }, {cause:error});
      throw new MaintenanceMutationError('Restore failed; original data was restored', {
        home:lockedHome, backup:loaded.backup, originalDataRestored:true,
      }, {cause:error});
    }
    // Installation is committed. Cleanup may have partly erased old bytes, so
    // a cleanup failure must not delete the now-valid restored active data.
    try {
      await io.rm(staging, {recursive:true, force:true});
      await io.rm(rollback, {recursive:true, force:true});
    } catch (error) {
      throw new MaintenanceMutationError('Data restored but sensitive temporary data cleanup failed', {
        home:lockedHome, backup:loaded.backup, staging, rollback, activeDataRestored:true,
        lifecycle:'stopped', automaticReplay:false,
      }, {cause:error});
    }
    const interruptedTasks = tasks.filter(task => activeStatuses.has(task?.status)).map(task => ({id:task.id, status:task.status}));
    return {operation:'restore', home:lockedHome, backup:loaded.backup, lifecycle:'stopped', interruptedTasks,
      automaticReplay:false,
      nextStep:interruptedTasks.length
        ? 'Start the gateway only when ready to reconcile; startup marks interrupted tasks unknown and does not replay them.'
        : 'Start the gateway when ready; restore never starts it automatically.'};
  }, {hostAdapter});
}

export async function createDeletePlan(home, output, {hostAdapter = windowsHost, io = defaultIo} = {}) {
  return withLifecycleOperationLock(home, async ({home:lockedHome}) => {
    await requireStopped(lockedHome, hostAdapter);
    const destination = await prepareNewOutput(lockedHome, output, io);
    const inventory = await inventoryData(lockedHome, {io});
    const plan = {format:deleteFormat, createdAt:new Date().toISOString(), home:lockedHome,
      entries:inventory.entries, fileCount:inventory.fileCount, directoryCount:inventory.directoryCount,
      totalBytes:inventory.totalBytes};
    await writeJsonAtomicNew(destination, plan, io);
    return {operation:'delete-plan', output:destination, ...plan};
  }, {hostAdapter});
}

async function loadDeletePlan(planPath, io) {
  const path = await io.realpath(resolve(planPath)).catch(error => {
    if (error?.code === 'ENOENT') throw new Error(`Delete plan does not exist: ${resolve(planPath)}`);
    throw error;
  });
  const plan = JSON.parse(await io.readFile(path, 'utf8'));
  if (plan?.format !== deleteFormat) throw new Error(`Unsupported delete plan format: ${plan?.format ?? 'missing'}`);
  if (typeof plan.home !== 'string') throw new Error('Delete plan Home is missing');
  validateEntries(plan.entries, 'Delete plan');
  return {path, plan};
}

export async function applyDeletePlan(planPath, confirmHome, {hostAdapter = windowsHost, io = defaultIo} = {}) {
  const loaded = await loadDeletePlan(planPath, io);
  const home = await canonicalHome(loaded.plan.home, io);
  const confirmed = await canonicalHome(confirmHome, io);
  if (comparable(home) !== comparable(confirmed))
    throw new Error(`Delete confirmation does not exactly match plan Home: ${confirmed}`);
  return withLifecycleOperationLock(home, async ({home:lockedHome}) => {
    await requireStopped(lockedHome, hostAdapter);
    const current = await inventoryData(lockedHome, {io});
    if (!sameEntries(loaded.plan.entries, current.entries))
      throw new Error('Delete scope changed after planning; create and review a new delete plan');
    const quarantine = resolve(lockedHome, `.gateway-maintenance-delete-${randomUUID()}`);
    const moved = [];
    try {
      await io.mkdir(quarantine, {recursive:false});
      for (const path of dataRoots) {
        const source = resolve(lockedHome, ...path.split('/'));
        if (!await exists(source, io)) continue;
        const target = resolve(quarantine, ...path.split('/'));
        await io.mkdir(dirname(target), {recursive:true});
        await io.rename(source, target);
        moved.push(path);
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const path of [...moved].reverse()) {
        try {
          const source = resolve(quarantine, ...path.split('/'));
          const target = resolve(lockedHome, ...path.split('/'));
          await io.mkdir(dirname(target), {recursive:true});
          await io.rename(source, target);
        } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
      }
      // If a move back failed, quarantine contains the only surviving original
      // bytes. Preserve it and report its exact path for manual recovery.
      if (!rollbackErrors.length)
        await io.rm(quarantine, {recursive:true, force:true}).catch(rollbackError => rollbackErrors.push(rollbackError.message));
      throw new MaintenanceMutationError(rollbackErrors.length
        ? 'Delete failed and rollback was incomplete' : 'Delete failed; original data was restored', {
        home:lockedHome, quarantine, movedRoots:moved, rollbackErrors,
      }, {cause:error});
    }
    try {
      await io.rm(quarantine, {recursive:true, force:false});
    } catch (error) {
      throw new MaintenanceMutationError('Delete removed the active data paths but could not erase the quarantine', {
        home:lockedHome, quarantine, movedRoots:moved, activePathsRemoved:true,
      }, {cause:error});
    }
    return {operation:'delete', home:lockedHome, deletedEntries:current.entries,
      fileCount:current.fileCount, directoryCount:current.directoryCount, totalBytes:current.totalBytes};
  }, {hostAdapter});
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const name = rest[index];
    if (!name.startsWith('--') || index + 1 >= rest.length || rest[index + 1].startsWith('--'))
      throw new Error(`Expected --name value, received ${name}`);
    options[name.slice(2)] = rest[++index];
  }
  return {command, options};
}

function required(options, name) {
  if (!options[name]) throw new Error(`Missing required option --${name}`);
  return options[name];
}

export async function runMaintenanceCli(argv = process.argv.slice(2)) {
  const {command, options} = parseArguments(argv);
  if (command === 'inspect') return inspectMaintenance(required(options, 'home'));
  if (command === 'export') return exportAudit(required(options, 'home'), required(options, 'output'));
  if (command === 'backup') return backupData(required(options, 'home'), required(options, 'output'));
  if (command === 'restore') return restoreData(required(options, 'home'), required(options, 'backup'));
  if (command === 'delete-plan') return createDeletePlan(required(options, 'home'), required(options, 'output'));
  if (command === 'delete') return applyDeletePlan(required(options, 'plan'), required(options, 'confirm-home'));
  throw new Error('Command must be one of: inspect, export, backup, restore, delete-plan, delete');
}

if (directRun) {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    console.log(maintenanceHelp);
  } else {
    runMaintenanceCli(argv).then(value => console.log(JSON.stringify(value, null, 2))).catch(error => {
      console.error(JSON.stringify({error:error.message, ...(error.details ? {details:error.details} : {})}, null, 2));
      process.exitCode = 1;
    });
  }
}
