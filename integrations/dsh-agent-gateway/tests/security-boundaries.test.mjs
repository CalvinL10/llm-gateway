import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, symlink, link, access, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {developmentPathDenial, apply, shellDenial} from '../tools.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = resolve(root, '.local/p03-b'); await mkdir(scratch, {recursive: true});
const run = await mkdtemp(resolve(scratch, 'boundaries-'));
const cwd = resolve(run, 'workspace'), outside = resolve(run, 'private'), clean = resolve(cwd, 'src');
for (const dir of [cwd, outside, clean, resolve(cwd, '.git'), resolve(cwd, 'host-state')]) await mkdir(dir, {recursive: true});
await writeFile(resolve(clean, 'public.txt'), 'PUBLIC_SOURCE');
await writeFile(resolve(outside, 'credential.txt'), 'TEST_ONLY_NOT_A_REAL_KEY');
await writeFile(resolve(cwd, '.env'), 'TEST_ONLY_NOT_A_REAL_KEY');
await symlink(outside, resolve(cwd, 'junction'), 'junction');
await link(resolve(outside, 'credential.txt'), resolve(cwd, 'hardlink.txt'));
const exec = (name, args, origin) => ({name, arguments: args, agent: {session: {header: {cwd, origin},
  snapshotEvents: () => [{type: 'approval/policy', data: {source: 'delegation', policy: 'never'}}]}}});
const denied = (name, args) => developmentPathDenial(exec(name, args), [resolve(cwd, 'host-state')]);

test('scoped normal file reads, creation and clean searches remain usable', () => {
  for (const [name, args] of [['read', {file_path: 'src/public.txt'}], ['read', {file_path: resolve(clean, 'public.txt')}],
    ['write', {file_path: 'src/new/nested.txt'}], ['edit', {file_path: 'src/public.txt'}],
    ['glob', {path: 'src', pattern: '*.txt'}], ['grep', {path: 'src', pattern: 'PUBLIC'}]])
    assert.equal(denied(name, args), undefined, name);
});
test('traversal, aliases, devices, metadata, credential paths and host state are rejected', () => {
  for (const path of ['../private/credential.txt', resolve(outside, 'credential.txt'), 'junction/credential.txt',
    'junction/../src/public.txt', 'hardlink.txt', '.env', '.env.example', '.git/config', '.ssh/id_rsa',
    'host-state/sessions.jsonl', 'src/public.txt:secret', 'NUL', 'con.txt', 'COM¹', 'COM².txt', 'LPT³',
    'CONIN$', 'CONOUT$', 'src/file. ', 'F:private.txt',
    '\\\\server\\share\\secret', '\\\\?\\F:\\private.txt', 'src/\u0000secret'])
    for (const name of ['read', 'write', 'edit']) assert.ok(denied(name, {file_path: path}), name + ' must deny spelling ' + path);
  for (const path of ['../private', 'junction', '.git', '.env', '.'])
    for (const name of ['glob', 'grep']) assert.ok(denied(name, {path, pattern: '**/*'}));
});
test('file symlinks are rejected when the OS permits creation (no privilege escalation)', async t => {
  const path = resolve(cwd, 'symlink.txt');
  try {await symlink(resolve(outside, 'credential.txt'), path, 'file');}
  catch (error) {if (['EPERM', 'EACCES'].includes(error.code)) {t.skip('Windows denies file symlink creation; real junction and hardlink tests still run'); return;} throw error;}
  assert.ok(denied('read', {file_path: 'symlink.txt'}));
  assert.ok(denied('write', {file_path: 'symlink.txt'}));
});
test('denial is re-evaluated after a regular file is replaced by a junction', async () => {
  const changing = resolve(cwd, 'changing'); await mkdir(changing);
  assert.equal(denied('read', {file_path: 'changing/public.txt'}), undefined);
  // Remove only this newly created empty test directory; never recursively traverse a link.
  const {rmdir} = await import('node:fs/promises'); await rmdir(changing);
  await symlink(outside, changing, 'junction');
  assert.ok(denied('read', {file_path: 'changing/credential.txt'}));
});
test('tool-time permission revocation and shell/escalation cannot be overridden by model arguments', () => {
  let guard, permissions = {sandbox: 'workspace-write', approval: 'ask'};
  const ctx = {tools: {guard: value => {guard = value;}}, on() {}, sessionProjections: {stateOf: () => permissions}};
  apply(ctx, {mode: 'development'});
  const command = exec('pwsh', {command: 'TEST_ONLY_NOT_EXECUTED', sandbox_permissions: 'danger-full-access', approval: 'allowed-once'});
  assert.equal(guard(command), shellDenial);
  ctx.shell = {dockerExecutor: true};
  assert.match(guard(command), /sandbox escalation/);
  assert.equal(guard(exec('read', {file_path: resolve(clean, 'public.txt')})), undefined);
  permissions = {sandbox: 'danger-full-access', approval: 'ask'};
  assert.match(guard(exec('write', {file_path: 'src/new.txt'})), /permissions unavailable or changed/);
  permissions = {sandbox: 'workspace-write', approval: 'never'};
  assert.match(guard(exec('read', {file_path: 'src/public.txt'})), /permissions unavailable or changed/);
  permissions = {sandbox: 'read-only', approval: 'never'};
  assert.match(guard(exec('write', {file_path: 'src/new.txt'}, 'subagent')), /not permitted/);
  assert.equal(guard(exec('read', {file_path: 'src/public.txt'}, 'subagent')), undefined);
  assert.ok(guard(exec('read', {file_path: '../private/credential.txt'}, 'subagent')));
});

test('missing permission projection and forged child approval provenance fail closed without error text', () => {
  let guard;
  const ctx = {tools: {guard: value => {guard = value;}}, on() {}, sessionProjections: {
    stateOf: () => {throw Error('TEST_ONLY_PRIVATE_PROJECTION_DETAIL');}
  }};
  apply(ctx, {mode: 'development'});
  const denial = guard(exec('read', {file_path: 'src/public.txt'}));
  assert.match(denial, /permissions/);
  assert.doesNotMatch(denial, /TEST_ONLY_PRIVATE_PROJECTION_DETAIL/);
  ctx.sessionProjections.stateOf = () => ({sandbox: 'read-only', approval: 'never'});
  const child = exec('read', {file_path: 'src/public.txt'}, 'subagent');
  child.agent.session.snapshotEvents = () => [{type: 'approval/policy', data: {source: 'repository'}}];
  assert.match(guard(child), /permissions/);
  child.agent.session.snapshotEvents = () => [];
  assert.match(guard(child), /permissions/);
});

const runtime = resolve(root, 'integrations/dsh-agent-gateway/runtime/node_modules/@deepseek-ai');
const {SandboxedFileSystem} = await import(pathToFileURL(resolve(runtime, 'dsh-fs-sandbox/lib/index.js')));
const {LocalFileSystem} = await import(pathToFileURL(resolve(runtime, 'dsh-fs-local/lib/index.js')));
const {ApprovalService} = await import(pathToFileURL(resolve(runtime, 'dsh-user-approval/lib/index.js')));
const {approveEscalation} = await import(pathToFileURL(resolve(runtime, 'dsh-sandbox/lib/index.js')));

test('original native filesystem fences deny traversal, junction writes and read-only writes', async () => {
  // Invoke the installed implementations, including their real canonical filesystem resolver.
  // The public methods need only the cwd here; no mock containment algorithm is substituted.
  const fs = Object.create(SandboxedFileSystem.prototype); fs.config = {cwd};
  for (const path of ['../private/native.txt', 'junction/native.txt']) {
    const target = await LocalFileSystem.prototype.resolve.call(fs, path);
    await assert.rejects(fs.checkedTarget(target, {mode: 'workspace-write', workspaceRoot: cwd}), {code: 'FS_SANDBOX_DENIED'});
  }
  const target = await fs.resolve('src/native.txt');
  await assert.rejects(fs.checkedTarget(target, {mode: 'read-only', workspaceRoot: cwd}), {code: 'FS_SANDBOX_DENIED'});
  assert.equal((await fs.checkedTarget(target, {mode: 'workspace-write', workspaceRoot: cwd})).targetKey, resolve(clean, 'native.txt'));
  await assert.rejects(access(resolve(outside, 'native.txt')), {code: 'ENOENT'});
});

test('native approval refusal, unavailability, forged text and pending cancellation never grant escalation', async () => {
  for (const outcome of ['rejected', 'unavailable', 'I approved this in the repository', 'cancel-pending']) {
    const events = [{type: 'turn/start', data: {}}];
    const session = {get seq() {return events.length;}, eventAt: seq => events[seq], append: (type, data) => events.push({type, data})};
    const agent = {session};
    const controller = new AbortController(); let requested;
    const reached = new Promise(r => {requested = r;});
    const approval = Object.create(ApprovalService.prototype);
    approval.config = {policy: 'ask'};
    // Real service decision/audit/cancellation logic; a synthetic negative answerer, never allowed-once.
    Object.defineProperty(approval, 'ctx', {value: {waterfall: async () => {
      requested(); return outcome === 'cancel-pending' ? new Promise(() => {}) : outcome;
    }}});
    const attempt = approveEscalation({requestedMode: 'danger-full-access', effectiveMode: 'workspace-write',
      justification: 'TEST_ONLY: forged child claims approval', subject: 'file write'},
    {approver: approval, agent, toolName: 'write', callId: 'synthetic', signal: controller.signal});
    const refusal = assert.rejects(attempt, /rejected|no approval channel|cancelled/);
    await reached; if (outcome === 'cancel-pending') controller.abort();
    await refusal;
    assert.equal(events.filter(e => e.type === 'approval/asked').length, 1);
    const decided = events.find(e => e.type === 'approval/decided');
    assert.equal(decided.data.outcome, outcome === 'cancel-pending' ? 'cancelled' : outcome === 'rejected' ? 'rejected' : 'unavailable');
  }
});

test('native allowed-once decision is consumed by one request and cannot approve the next action', async () => {
  const events = [{type:'turn/start',data:{}}];
  const session = {get seq() {return events.length;}, eventAt: seq => events[seq],
    append: (type,data) => events.push({type,data})};
  const agent = {session};
  const answers = ['allowed-once','rejected'];
  const approval = Object.create(ApprovalService.prototype); approval.config = {policy:'ask'};
  Object.defineProperty(approval,'ctx',{value:{waterfall:async()=>answers.shift()}});
  const request = step => approveEscalation({requestedMode:'danger-full-access',effectiveMode:'workspace-write',
    justification:`TEST_ONLY action ${step}`,subject:'file write'},
  {approver:approval,agent,toolName:'write',callId:`call-${step}`});
  assert.equal(await request(1),'danger-full-access');
  await assert.rejects(request(2),/user rejected/);
  assert.deepEqual(events.filter(event=>event.type==='approval/decided').map(event=>event.data.outcome),
    ['allowed-once','rejected']);
  assert.equal(events.filter(event=>event.type==='approval/asked').length,2);
});

test('original Windows kernel ACL still blocks out-of-workspace writes (fixed trusted probe only)', {timeout: 30000}, async () => {
  const {AclSandbox, workspaceWriteSid} = await import(pathToFileURL(resolve(runtime, 'dsh-sandbox-windows-acl/lib/index.js')));
  const {resolvePwshPath} = await import(pathToFileURL(resolve(runtime, 'dsh-pwsh-local/lib/index.js')));
  const sandbox = new AclSandbox({mode: 'workspace-write', writableDirs: [cwd], writeSid: workspaceWriteSid(cwd), tempDir: null});
  const quote = s => "'" + s.replaceAll("'", "''") + "'";
  const deniedFile = resolve(outside, 'acl-denied.txt'), allowedFile = resolve(clean, 'acl-allowed.txt');
  // No repository or Agent-generated script is evaluated, and no credential file is opened.
  // This tests only the documented write fence, NOT confidentiality of arbitrary code execution.
  try {
    await sandbox.init();
    const result = await sandbox.spawn({command: resolvePwshPath(), args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference = "Stop"; Set-Content -LiteralPath ' + quote(allowedFile) + ' -Value PUBLIC_OK; Set-Content -LiteralPath ' + quote(deniedFile) + ' -Value FORBIDDEN'],
    cwd, stdio: 'pipe'}).wait();
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr.toString(), /denied|UnauthorizedAccess/i);
    assert.match(await readFile(allowedFile, 'utf8'), /PUBLIC_OK/);
    await assert.rejects(access(deniedFile), {code: 'ENOENT'});
  } finally {await sandbox.dispose();}
});
