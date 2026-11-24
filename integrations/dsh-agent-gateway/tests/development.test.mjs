import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, access } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import {inspectRuntime} from '../ops/runtime-paths.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {runtime} = await inspectRuntime(resolve(source, 'runtime'));
const bin = resolve(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js');

async function cleanupDevelopmentRun(stop, run) {
  try { await stop(false); }
  finally { await rm(run, {recursive: true, force: true}); }
}

// Ordinary integration test against the real installed Web/controller/preset/tool stack.
// Every model response is scripted; no subscription Home or credentials are used.
async function startHost(t, {presetTransform = value => value, policyTransform = value => value,
  nativeLifecycle = false, delegation = true, workspace = null} = {}) {
  const run = await mkdtemp(resolve(runtime, 'development-test-'));
  t.after(() => cleanupDevelopmentRun(stop, run));
  const home = resolve(run, 'home'), plugin = resolve(run, 'plugin'), cwd = resolve(run, 'workspace');
  const presetDir = resolve(home, '.agent-presets/gateway-agent');
  await mkdir(presetDir, {recursive: true}); await mkdir(cwd,{recursive:true}); await mkdir(plugin);
  await writeFile(resolve(cwd, 'seed.txt'), 'BEFORE\nKEEP_THIS_LINE\n');
  await writeFile(resolve(cwd, 'unread.txt'), 'UNREAD_ORIGINAL\n');
  await writeFile(resolve(cwd, 'continuation.txt'), 'CONTINUE_BEFORE\n');
  await writeFile(resolve(cwd, 'shell-seed.txt'), 'SHELL_BEFORE\n');
  await writeFile(resolve(cwd, 'diagnosis.txt'), 'Independent cause: stale parser branch.\n');
  await writeFile(resolve(cwd, 'repair.js'), 'export function clamp(value, max) { return max - 1; }\n');
  await writeFile(resolve(cwd, 'repair-test-output.txt'), 'FAIL clamp boundary: expected 10, actual 9.\n');
  for (const file of ['package.json', 'index.js', 'ledger.js','report.js','panel.js', 'tools.js',
    'docker-pwsh-executor.js','docker-executor-spec.mjs'])
    await copyFile(resolve(source, file), resolve(plugin, file));
  await copyFile(resolve(source, 'tests/fixtures/development-fixture.js'), resolve(plugin, 'development-fixture.js'));
  if (nativeLifecycle)
    await copyFile(resolve(source, 'tests/fixtures/native-lifecycle-fixture.mjs'), resolve(plugin, 'native-lifecycle-fixture.mjs'));
  await copyFile(resolve(source, 'tests/fixtures/legacy-preset/development-preset.yml'), resolve(presetDir, 'preset.yml'));
  const route = {provider: 'fixture-development', model: 'scripted'};
  let preset = presetTransform(await readFile(resolve(source, 'tests/fixtures/legacy-preset/development-agent.cordis.yml'), 'utf8'));
  if (!delegation) {
    preset = preset
      .replace(/- id: tool-subagent[\s\S]*?(?=- id: gateway-development-tools)/, '')
      .replace(/(\s*mode: development)\r?\n?$/, '$1\n    delegationEnabled: false\n');
  }
  await writeFile(resolve(presetDir, 'agent.cordis.yml'), preset.replace(
    "'@llm-gateway/dsh-agent-gateway/tools'", JSON.stringify(resolve(plugin, 'tools.js').replaceAll('\\', '/'))));
  const env = {...process.env, DSH_HOME: home, DSH_PERMISSION_MODE: 'workspace-write'};
  execFileSync(process.execPath, [bin, 'web', '--dump-config'], {cwd, env, stdio: 'pipe'});
  const patchPath = resolve(run, 'test.patch.json');
  await writeFile(patchPath, JSON.stringify([
    {id: 'session-title-llm', disabled: true}, {id: 'llm-retry', disabled: true},
    {id: 'subagent-model-selection-settings', config: {enabled: delegation, allowedModels: delegation ? [route] : []}},
    {insert: [
      {id: 'development-fixture', name: resolve(plugin, 'development-fixture.js').replaceAll('\\', '/')},
      {id: 'gateway-agent-tasks', name: resolve(plugin, nativeLifecycle ? 'native-lifecycle-fixture.mjs' : 'index.js').replaceAll('\\', '/'),
        config: {...(workspace ? {workspaces:[{id:workspace.id,label:workspace.label,cwd}]} : {cwd}),
          authorizedTaskMaxCalls:[3, 8], authorizedContinuationCallIncrements:[1, 3],
          policy: policyTransform({root: route, allowedRoutes: [route], toolSet: 'development', maxCalls: 8,
            ...(delegation ? {} : {delegationEnabled:false, allowedChildRoutes:[]})})}}
    ]}
  ], null, 2));
  let child, origin, headers, loginUrl;
  async function launch() {
    child = spawn(process.execPath, [bin, 'web', '--patch', patchPath, '--no-open', '--host', '127.0.0.1', '--port', '0'],
      {cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    // Never print startup URLs, cookie values, or unfiltered host errors.
    child.stderr.on('data', () => {});
    const url = await new Promise((resolveURL, reject) => {
      let stdout = '';
      const timer = setTimeout(() => reject(Error('Local test host startup timed out')), 30000);
      child.once('exit', code => {clearTimeout(timer); reject(Error('Local test host exited: ' + code));});
      child.once('error', error => {clearTimeout(timer); reject(error);});
      child.stdout.on('data', chunk => {
        stdout += chunk;
        const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/);
        if (match) {clearTimeout(timer); resolveURL(match[0]);}
      });
    });
    origin = new URL(url).origin;
    loginUrl = url;
    const login = await fetch(url, {redirect: 'manual'}); assert.equal(login.status, 303);
    headers = {Cookie: login.headers.getSetCookie().map(value => value.split(';')[0]).join('; '),
      Origin: origin, 'Content-Type': 'application/json'};
  }
  async function stop(force = false) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill(force ? 'SIGKILL' : undefined); await exited;
  }
  await launch();
  const endpoint = '/api/gateway-agent-tasks';
  async function api(path = endpoint, value) {
    const response = await fetch(origin + path, {headers,
      ...(value === undefined ? {} : {method: 'POST', body: JSON.stringify(value)})});
    assert.equal(response.status, 200); return response.json();
  }
  async function done(id) {
    for (let i = 0; i < 400; i++) {
      const task = await api(endpoint + '?id=' + id);
      if (!['queued', 'running', 'cancel-requested'].includes(task.status)) return task;
      await new Promise(r => setTimeout(r, 50));
    }
    throw Error('Development fixture task did not settle');
  }
  async function restart() { await stop(true); await launch(); }
  async function rejected(path, value) {
    const response = await fetch(origin + path, {headers, method:'POST', body:JSON.stringify(value)});
    return {status:response.status, body:await response.json()};
  }
  return {cwd, home, api, done, get origin(){return origin;}, endpoint, get headers(){return headers;},
    restart, rejected, stop, loginUrl:()=>loginUrl};
}

test('runtime prompt grounds file tools in the selected workspace without exposing host paths',
  {timeout:60000},async t=>{
    const workspace={id:'t2',label:'looks/like/a/path'};
    const {cwd,api,done,endpoint}=await startHost(t,{workspace});
    const task=await api(endpoint,{requestId:randomUUID(),goal:'direct focused task',workspaceId:workspace.id});
    assert.equal((await done(task.id)).status,'completed');
    const continuationId=randomUUID();
    await api(endpoint+'?id='+task.id+'&action=continue',{continuationId,kind:'continue',
      instruction:'authorized budget continuation',additionalCalls:0});
    assert.equal((await done(task.id)).status,'completed');
    const calls=(await api('/api/development-fixture')).calls.filter(call=>call.sessionId===task.sessionId);
    assert.deepEqual(calls.map(call=>call.rpcId),[task.id,continuationId]);
    for(const call of calls) {
      assert.match(call.currentPrompt,/file tool paths are resolved relative to the selected authorized workspace/i);
      assert.match(call.currentPrompt,/workspaceId "t2"[^\n]*selector only[^\n]*not a filesystem path/i);
      assert.match(call.currentPrompt,/read that file directly with the smallest useful offset and limit/i);
      assert.match(call.currentPrompt,/do not run glob or grep first unless the direct read fails or the path is ambiguous/i);
      assert.match(call.currentPrompt,/specific top-level source or test directory with a restrictive include/i);
      assert.match(call.currentPrompt,/reuse unchanged successful reads and tool results/i);
      assert.match(call.currentPrompt,/preserve security, authorization, budget, failure, test, and recovery facts/i);
      assert.match(call.currentPrompt,/do not recursively search "\."/i);
      assert.equal(call.currentPrompt.includes(cwd),false);
      assert.equal(call.currentPrompt.includes(workspace.label),false);
    }
  });

test('development host cleanup removes its run directory even when shutdown fails', async () => {
  const parent = await mkdtemp(resolve(runtime, 'development-cleanup-test-'));
  const run = resolve(parent, 'run');
  await mkdir(run);
  try {
    await assert.rejects(
      cleanupDevelopmentRun(async () => { throw Error('expected shutdown failure'); }, run),
      /expected shutdown failure/);
    await assert.rejects(access(run), {code: 'ENOENT'});
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('invalid development preset fails at create without a model call or raw error disclosure', {timeout: 60000}, async t => {
  const {api, done, endpoint} = await startHost(t, {presetTransform: value => {
    assert.ok(value.includes('    sampleOverCapGlobResults: false'));
    const broken = value.replace(/  config:\r?\n    sampleOverCapGlobResults: false\r?\n/, '');
    assert.notEqual(broken, value); return broken;
  }});
  const task = await api(endpoint, {requestId: randomUUID(), goal: 'invalid development preset fixture'});
  const result = await done(task.id);
  assert.equal(result.status, 'failed'); assert.equal(result.failureCode, 'PREPARATION_FAILED');
  assert.equal(result.failureStage, 'create');
  assert.deepEqual(result.calls, []); assert.deepEqual(result.denials, []);
  assert.equal((await api('/api/development-fixture')).attempts.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /sampleOverCapGlobResults|node_modules|RemoteError|stack/);
});

for (const arm of ['A','B']) test(`native lifecycle ${arm} receipts prove settlement and keep repair on the original task`,
  {timeout:60000}, async t => {
    const {api,endpoint,origin,headers,rejected} = await startHost(t, {delegation:arm === 'B', nativeLifecycle:true});
    const path = '/api/native-lifecycle-fixture', id = randomUUID(), repairId = randomUUID();
    assert.equal((await fetch(origin+path)).status, 401);
    assert.equal((await fetch(origin+path, {headers:{...headers, Origin:'https://untrusted.example'}})).status, 403);
    assert.equal((await rejected(endpoint, {requestId:id, goal:'unmanaged'})).body.error, 'EXTERNAL_SCHEDULER_REQUIRED');
    const first = await api(path, {requestId:id, goal:arm === 'A' ? 'direct focused task' : 'independent child investigation'});
    const ended = await api(`${path}?attempt=${first.attemptId}`);
    assert.equal(ended.synthetic, true); assert.equal(ended.realModelCalls, 0);
    assert.equal(ended.terminationConfirmed, true); assert.equal(ended.task.status, 'completed');
    const before = await api(`${endpoint}?view=audit&id=${id}`);
    assert.equal(before.tasks.length, 1);
    assert.equal(before.tasks[0].calls.some(call => call.source.sessionRole === 'child'), arm === 'B');
    const repair = await api(`${path}?id=${id}`, {continuationId:repairId, kind:'continue',
      instruction:'authorized budget continuation', additionalCalls:0});
    assert.equal(repair.taskId, id); assert.equal(repair.sessionId, first.sessionId); assert.equal(repair.attemptId, repairId);
    const repaired = await api(`${path}?attempt=${repairId}`);
    assert.equal(repaired.terminationConfirmed, true); assert.equal(repaired.task.status, 'completed');
    const after = await api(`${endpoint}?view=audit&id=${id}`);
    assert.equal(after.tasks.length, 1); assert.equal(repaired.task.report.budget.maxCalls, 8);
    assert.equal(after.tasks[0].calls.length, before.tasks[0].calls.length + 1);
    assert.deepEqual(after.tasks[0].attempts.map(attempt => attempt.id), [id, repairId]);
    assert.equal((await rejected(`${endpoint}?action=continue&id=${id}`, {continuationId:randomUUID(),
      kind:'continue', instruction:'unmanaged'})).body.error, 'EXTERNAL_SCHEDULER_REQUIRED');
  });

test('development preset on the native host (zero real models)', {timeout: 120000}, async t => {
  const {cwd, api, done, origin, endpoint, headers, restart, rejected} = await startHost(t);
  await t.test('authentication, Origin/Host, and input protections still apply', async () => {
    assert.equal((await fetch(origin + endpoint)).status, 401);
    assert.equal((await fetch(origin + endpoint, {headers: {...headers, Origin: 'https://untrusted.example'}})).status, 403);
    const badHost = await new Promise((resolveStatus, reject) => {
      const req = httpRequest(origin + endpoint, {headers: {...headers, Host: 'untrusted.example'}}, res => {
        res.resume(); resolveStatus(res.statusCode);
      }); req.on('error', reject); req.end();
    });
    assert.equal(badHost, 403);
    assert.equal((await fetch(origin + endpoint, {headers, method: 'POST',
      body: JSON.stringify({requestId: randomUUID(), goal: 'fixture', attachments: []})})).status, 400);
    const policyView = await api(endpoint);
    assert.deepEqual(policyView.authorizedTaskMaxCalls, [3, 8]);
    const unauthorizedLimit = await fetch(origin + endpoint, {headers, method:'POST',
      body:JSON.stringify({requestId:randomUUID(), goal:'fixture', maxCalls:4})});
    assert.equal(unauthorizedLimit.status, 400);
    assert.deepEqual(await unauthorizedLimit.json(), {error:'CALL_LIMIT_NOT_AUTHORIZED'});
  });
  await t.test('execution prompt supports direct work, focused child research, and targeted repair', async () => {
    const direct = await api(endpoint, {requestId:randomUUID(), goal:'direct focused task'});
    const directResult = await done(direct.id);
    assert.equal(directResult.status, 'completed'); assert.equal(directResult.calls.length, 1);
    assert.equal(directResult.artifact, 'DIRECT_WITHOUT_DELEGATION');
    let observed = await api('/api/development-fixture');
    const directCalls = observed.calls.filter(call => call.sessionId === direct.sessionId);
    assert.equal(directCalls.length, 1); assert.equal(directCalls.some(call => call.parentSessionId), false);
    assert.deepEqual(directCalls[0].promptContract, {narrowestEvidence:true, exactFileBoundedRead:true,
      noRedundantDiscovery:true, restrictiveSearch:true, repositoryCommandGuard:true, reuseUnchangedEvidence:true, traceableCompaction:true,
      directWhenSmall:true, conditionalReadOnlyDelegation:true, targetedRepair:true, nativeContextReuse:true,
      noBudgetEvasion:true});

    const delegated = await api(endpoint, {requestId:randomUUID(), goal:'independent child investigation'});
    const delegatedResult = await done(delegated.id);
    assert.equal(delegatedResult.status, 'completed'); assert.equal(delegatedResult.calls.length, 4);
    assert.equal(delegatedResult.artifact, 'ROOT_USED_FOCUSED_CHILD');
    observed = await api('/api/development-fixture');
    const childCalls = observed.calls.filter(call => call.parentSessionId === delegated.sessionId);
    assert.equal(childCalls.length, 2); assert.ok(childCalls.every(call => call.permissions.sandbox === 'read-only'));
    assert.ok(childCalls.every(call => call.tools.includes('read') && !call.tools.includes('write')));

    const repair = await api(endpoint, {requestId:randomUUID(), goal:'repair after synthetic test failure'});
    const repairResult = await done(repair.id);
    assert.equal(repairResult.status, 'completed'); assert.equal(repairResult.calls.length, 5);
    assert.equal(repairResult.artifact, 'SYNTHETIC_FAILURE_REPAIRED_AND_SOURCE_VERIFIED');
    assert.equal(await readFile(resolve(cwd, 'repair.js'), 'utf8'),
      'export function clamp(value, max) { return max; }\n');
    assert.deepEqual(repairResult.report.confirmedFileChanges.map(item => item.name), ['edit']);
    const repairOps = repairResult.report.toolOperations.map(item => item.name);
    assert.deepEqual(repairOps, ['read', 'read', 'edit', 'read']);
  });
  await t.test('exact-file work starts with one bounded read and reuses unchanged evidence', async () => {
    const task = await api(endpoint, {requestId:randomUUID(), goal:'exact file bounded read fixture'});
    const initial = await done(task.id);
    assert.equal(initial.status, 'completed'); assert.equal(initial.calls.length, 2);
    assert.equal(initial.artifact, 'EXACT_FILE_EVIDENCE_REUSED');
    const continuationId = randomUUID();
    await api(endpoint + '?id=' + task.id + '&action=continue', {continuationId, kind:'continue',
      instruction:'reuse unchanged exact-file evidence', additionalCalls:0});
    const continued = await done(task.id);
    assert.equal(continued.status, 'completed'); assert.equal(continued.calls.length, 3);
    assert.equal(continued.artifact, 'UNCHANGED_EXACT_FILE_EVIDENCE_REUSED');
    const calls = (await api('/api/development-fixture')).calls.filter(call => call.sessionId === task.sessionId);
    assert.deepEqual(calls.flatMap(call => call.requestedTools), [{id:'exact-bounded-read', name:'read',
      arguments:{file_path:'seed.txt', offset:1, limit:40}}]);
    assert.equal(calls.flatMap(call => call.requestedTools).some(call => ['glob','grep','subagent'].includes(call.name)), false);
    assert.equal(calls.filter(call => call.rpcId === continuationId).length, 1);
  });
  await t.test('native development mount advertises only the authorized root tools', async () => {
    const task = await api(endpoint, {requestId: randomUUID(), goal: 'development mount probe'});
    const result = await done(task.id), observed = await api('/api/development-fixture');
    assert.equal(result.status, 'completed', JSON.stringify({status: result.status, failureCode: result.failureCode, attempts: observed.attempts}));
    assert.equal(result.calls.length, 1); assert.equal(result.artifact, 'DEVELOPMENT_READY');
    assert.equal(result.report.businessOutcome, 'unverified');
    assert.equal(result.report.stopReason, 'TURN_COMPLETED');
    assert.deepEqual(observed.calls[0].tools, ['edit', 'glob', 'grep', 'list_subagent_models', 'pwsh', 'read', 'subagent', 'write']);
    assert.equal(observed.calls[0].cwd, cwd);
    assert.equal(observed.calls[0].permissions.sandbox, 'workspace-write');
    assert.equal(observed.calls[0].permissions.approval, 'ask');
  });
  await t.test('native file operations, workspace fence, observation policy and child read-only delegation', async () => {
    const task = await api(endpoint, {requestId: randomUUID(), goal: 'development file workflow'});
    const result = await done(task.id), observed = await api('/api/development-fixture');
    assert.equal(result.status, 'completed', JSON.stringify({status: result.status, failureCode: result.failureCode}));
    assert.equal(result.artifact, 'DEVELOPMENT_FILES_VERIFIED');
    assert.equal(result.calls.length, 6, JSON.stringify(observed.attempts)); assert.deepEqual(result.denials, []);
    const rootCalls = observed.calls.filter(c => c.sessionId === task.sessionId);
    const children = observed.calls.filter(c => c.parentSessionId === task.sessionId);
    assert.equal(rootCalls.length, 4); assert.equal(children.length, 2);
    assert.equal(new Set(children.map(c => c.sessionId)).size, 1);
    assert.deepEqual(result.calls.map(c => c.sessionId).sort(), [...rootCalls, ...children].map(c => c.sessionId).sort());
    for (const call of rootCalls) {
      assert.equal(call.cwd, cwd);
      assert.equal(call.permissions.sandbox, 'workspace-write'); assert.equal(call.permissions.approval, 'ask');
      assert.deepEqual(call.tools, ['edit', 'glob', 'grep', 'list_subagent_models', 'pwsh', 'read', 'subagent', 'write']);
    }
    for (const call of children) {
      assert.equal(call.cwd, cwd);
      assert.equal(call.permissions.sandbox, 'read-only'); assert.equal(call.permissions.approval, 'never');
      assert.equal(call.approvalSource, 'delegation');
      assert.deepEqual(call.tools, ['glob', 'grep', 'list_subagent_models', 'read', 'subagent']);
    }
    const allResults = [...rootCalls, ...children].flatMap(c => c.results);
    function toolResult(id, isError, expected) {
      const block = allResults.find(r => r.toolCallId === id);
      assert.ok(block, 'Missing native result: ' + id);
      assert.equal(block.isError ?? false, isError, JSON.stringify(block));
      const text = block.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      assert.match(text, expected, id); return text;
    }
    toolResult('root-read', false, /BEFORE/); toolResult('root-glob', false, /seed\.txt/);
    toolResult('root-grep', false, /BEFORE/);
    toolResult('root-edit', false, /updated/); toolResult('root-write', false, /Created file/);
    toolResult('verify-edit', false, /AFTER/); toolResult('verify-write', false, /CREATED_BY_NATIVE_TOOL/);
    toolResult('unread-write', true, /file has not been read/);
    toolResult('outside-write', true, /Gateway path denied/);
    toolResult('child-read', false, /AFTER/); toolResult('child-glob', false, /seed\.txt/);
    toolResult('child-grep', false, /AFTER/); toolResult('child', false, /CHILD_READ_ONLY/);
    for (const id of ['child-write', 'child-edit', 'child-pwsh']) toolResult(id, true, /Gateway tool is not permitted in development mode/);
    assert.equal(await readFile(resolve(cwd, 'seed.txt'), 'utf8'), 'AFTER\nKEEP_THIS_LINE\n');
    assert.equal(await readFile(resolve(cwd, 'created.txt'), 'utf8'), 'CREATED_BY_NATIVE_TOOL\n');
    assert.equal(result.report.confirmedFileChanges.length, 2);
    assert.ok(result.report.failedOperations.some(op => op.sessionId !== task.sessionId));
    assert.equal(await readFile(resolve(cwd, 'unread.txt'), 'utf8'), 'UNREAD_ORIGINAL\n');
    for (const file of ['../outside.txt', 'child-created.txt', 'child-shell.txt'])
      await assert.rejects(readFile(resolve(cwd, file)), {code: 'ENOENT'});
    // Queries and duplicate submissions cannot start another tool loop.
    await api(endpoint, {requestId: task.id, goal: task.goal}); await api(endpoint + '?id=' + task.id);
    assert.equal((await api('/api/development-fixture')).calls.length, observed.calls.length);
  });
  await t.test('unsafe native pwsh is denied while scoped read and edit remain available', async () => {
    const task = await api(endpoint, {requestId: randomUUID(), goal: 'development shell probe'});
    const result = await done(task.id), observed = await api('/api/development-fixture');
    assert.equal(result.status, 'completed'); assert.equal(result.calls.length, 5);
    const calls = observed.calls.filter(c => c.sessionId === task.sessionId);
    for (const call of calls) {
      assert.equal(call.cwd, cwd); assert.equal(call.permissions.sandbox, 'workspace-write');
      assert.equal(call.permissions.approval, 'ask');
    }
    const results = calls.flatMap(c => c.results);
    const shell = results.find(r => r.toolCallId === 'root-pwsh');
    assert.ok(shell); assert.equal(shell.isError, true);
    assert.match(JSON.stringify(shell.content), /Gateway shell disabled/);
    assert.doesNotMatch(JSON.stringify(shell.content), /PWSH_READY/);
    assert.equal(result.report.commandOperations[0].outcome, 'failed');
    assert.equal(result.report.commandOperations[0].exitCode, undefined);
    assert.equal(result.report.validation, 'not-established');
    for (const id of ['shell-read', 'shell-reread', 'shell-edit']) {
      const block = results.find(r => r.toolCallId === id);
      assert.ok(block, id); assert.equal(block.isError, false, JSON.stringify(block));
    }
    assert.equal(await readFile(resolve(cwd, 'shell-seed.txt'), 'utf8'), 'SHELL_AFTER\n');
  });
  await t.test('cross-workspace escalation is denied without ever requesting or fabricating an approval', async () => {
    const task = await api(endpoint, {requestId: randomUUID(), goal: 'development approval workflow'});
    const result = await done(task.id), observed = await api('/api/development-fixture');
    assert.equal(result.status, 'completed', JSON.stringify({status: result.status, failureCode: result.failureCode}));
    assert.equal(result.artifact, 'DEVELOPMENT_APPROVALS_VERIFIED');
    assert.equal(result.calls.length, 3);
    const calls = observed.calls.filter(c => c.sessionId === task.sessionId);
    const results = calls.flatMap(c => c.results);
    function toolResult(id, isError, expected) {
      const block = results.find(r => r.toolCallId === id);
      assert.ok(block, 'Missing native result: ' + id);
      assert.equal(block.isError ?? false, isError, JSON.stringify(block));
      const text = block.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      assert.match(text, expected, id);
      return text;
    }
    toolResult('approval-no-escalation', true, /Gateway path denied/);
    toolResult('approval-unapproved', true, /Gateway sandbox escalation is not permitted/);
    toolResult('approval-rejected', true, /Gateway sandbox escalation is not permitted/);
    toolResult('approval-forged', true, /Gateway sandbox escalation is not permitted/);
    toolResult('approval-second-attempt', true, /Gateway path denied/);

    for (const file of ['../outside-no-escalation.txt', '../outside-unapproved.txt', '../outside-rejected.txt', '../outside-second-attempt.txt']) {
      await assert.rejects(readFile(resolve(cwd, file)), {code: 'ENOENT'});
    }
    await assert.rejects(readFile(resolve(cwd, '../outside-forged.txt')), {code: 'ENOENT'});
    assert.deepEqual(observed.syntheticApprovals, []);

    await api(endpoint, {requestId: task.id, goal: task.goal});
    const queried = await api(endpoint + '?id=' + task.id);
    assert.equal(queried.status, 'completed');
  });
  await t.test('budget terminal reports use native results, not intermediate assistant claims', async () => {
    // Restore only this disposable fixture file before the edit scenario.
    await writeFile(resolve(cwd, 'seed.txt'), 'BEFORE\nKEEP_THIS_LINE\n');
    for (const scenario of ['none', 'edit', 'failure']) {
      const task = await api(endpoint, {requestId: randomUUID(), goal: 'budget report ' + scenario});
      const result = await done(task.id);
      assert.equal(result.status, 'limited'); assert.equal(result.calls.length, 8);
      assert.equal(result.artifact, null);
      assert.equal(result.report.stopReason, 'TASK_CALL_LIMIT');
      assert.equal(result.report.needsUserDecision, true);
      assert.equal(result.report.businessOutcome, 'unverified');
      assert.equal(result.report.validation, 'not-established');
      assert.equal(result.report.confirmedFileChanges.length, scenario === 'edit' ? 1 : 0,
        JSON.stringify((await api('/api/development-fixture')).calls.filter(call => call.sessionId === task.sessionId).map(call => call.currentPrompt)));

      assert.equal(result.report.failedOperations.length, scenario === 'failure' ? 1 : 0);
      assert.equal(result.report.toolCounts.unconfirmed, 0);
      assert.equal(result.report.modelCalls.returned, 8);
      assert.equal(result.report.budget.remaining, 0);
      assert.doesNotMatch(JSON.stringify(result.report), /INTERMEDIATE|BEFORE|BUDGET_EDITED|missing-budget/);
      const before = (await api('/api/development-fixture')).calls.length;
      await api(endpoint, {requestId: task.id, goal: task.goal}); await api(endpoint + '?id=' + task.id);
      assert.equal((await api('/api/development-fixture')).calls.length, before);
    }
    assert.equal(await readFile(resolve(cwd, 'seed.txt'), 'utf8'), 'BUDGET_EDITED\nKEEP_THIS_LINE\n');

    const requestId = randomUUID(), goal = 'budget report custom';
    const custom = await api(endpoint, {requestId, goal, maxCalls:3});
    const limited = await done(custom.id);
    assert.equal(limited.status, 'limited'); assert.equal(limited.calls.length, 3);
    assert.equal(limited.policy.maxCalls, 3); assert.equal(limited.report.budget.maxCalls, 3);
    const callCount = (await api('/api/development-fixture')).calls.length;
    const historical = await api(endpoint, {requestId, goal});
    assert.equal(historical.policy.maxCalls, 3);
    assert.equal((await api('/api/development-fixture')).calls.length, callCount);
    const conflict = await fetch(origin + endpoint, {headers, method:'POST', body:JSON.stringify({requestId, goal, maxCalls:8})});
    assert.equal(conflict.status, 400); assert.deepEqual(await conflict.json(), {error:'REQUEST_ID_CONFLICT'});
  });
  await t.test('same-session continuation preserves interval edits and single-flights duplicate requests', async () => {
    const task = await api(endpoint, {requestId:randomUUID(), goal:'continuation edit fixture'});
    const initial = await done(task.id);
    assert.equal(initial.status, 'completed'); assert.equal(initial.calls.length, 1);
    await writeFile(resolve(cwd, 'continuation.txt'), 'CONTINUE_BEFORE\nUSER_INTERVAL_EDIT\n');
    const continuationId = randomUUID(), payload = {continuationId, kind:'supplement',
      instruction:'preserve interval edit', additionalCalls:0};
    const [first, second] = await Promise.all([
      api(endpoint + '?id=' + task.id + '&action=continue', payload),
      api(endpoint + '?id=' + task.id + '&action=continue', payload)
    ]);
    assert.equal(first.sessionId, task.sessionId); assert.equal(second.sessionId, task.sessionId);
    const result = await done(task.id);
    assert.equal(result.status, 'completed'); assert.equal(result.artifact, 'CONTINUATION_EDIT_PRESERVED_CURRENT_FILE');
    assert.equal(result.calls.length, 4); assert.deepEqual(result.report.attempts.map(value => value.kind), ['initial','supplement']);
    assert.equal(result.report.attempts[1].id, continuationId);
    assert.equal(result.report.attempts[1].callStart, 1); assert.equal(result.report.attempts[1].callEnd, 4);
    assert.equal(await readFile(resolve(cwd, 'continuation.txt'), 'utf8'), 'CONTINUE_AFTER\nUSER_INTERVAL_EDIT\n');
    const observed = (await api('/api/development-fixture')).calls.filter(call => call.sessionId === task.sessionId);
    assert.equal(observed.filter(call => call.rpcId === continuationId).length, 3);
    assert.ok(observed.filter(call => call.rpcId === continuationId).every(call =>
      call.currentPrompt.includes('supplementing the original goal') &&
      call.currentPrompt.includes('use the existing session history and re-read only current files') &&
      call.currentPrompt.includes('do not re-read unchanged files merely to reconstruct context') &&
      call.currentPrompt.includes('preserve every earlier attempt, failure, tool result, and consumed call')));
  });

  await t.test('exhausted budgets require an authorized visible increment without resetting consumption', async () => {
    const task = await api(endpoint, {requestId:randomUUID(), goal:'budget report custom', maxCalls:3});
    const limited = await done(task.id);
    assert.equal(limited.status, 'limited'); assert.equal(limited.calls.length, 3);
    const base = {kind:'continue', instruction:'authorized budget continuation'};
    assert.deepEqual(await rejected(endpoint + '?id=' + task.id + '&action=continue',
      {...base, continuationId:randomUUID(), additionalCalls:0}), {status:400, body:{error:'TASK_CALL_LIMIT'}});
    assert.deepEqual(await rejected(endpoint + '?id=' + task.id + '&action=continue',
      {...base, continuationId:randomUUID(), additionalCalls:2}),
      {status:400, body:{error:'CONTINUATION_CALL_LIMIT_NOT_AUTHORIZED'}});
    const continuationId = randomUUID();
    await api(endpoint + '?id=' + task.id + '&action=continue', {...base, continuationId, additionalCalls:1});
    const result = await done(task.id);
    assert.equal(result.status, 'completed'); assert.equal(result.calls.length, 4);
    assert.equal(result.policy.maxCalls, 4); assert.equal(result.report.budget.initialMaxCalls, 3);
    assert.equal(result.report.budget.addedCalls, 1); assert.equal(result.report.budget.everLimitDenied, true);
    assert.equal(result.report.budget.limitDenied, false);
    assert.deepEqual(result.report.attempts.map(value => [value.callStart,value.callEnd,value.budgetBefore,value.budgetAfter]),
      [[0,3,3,3],[3,4,3,4]]);
  });

  await t.test('lost continuation response and cancellation recovery do not replay or inherit the old turn', async () => {
    const completed = await api(endpoint, {requestId:randomUUID(), goal:'direct focused task'});
    await done(completed.id);
    const continuationId = randomUUID(), payload = {continuationId, kind:'continue',
      instruction:'resume after response loss', additionalCalls:0};
    const discarded = await fetch(origin + endpoint + '?id=' + completed.id + '&action=continue',
      {headers, method:'POST', body:JSON.stringify(payload)});
    assert.equal(discarded.status, 200); // Intentionally do not consume the response body.
    await Promise.all([
      api(endpoint + '?id=' + completed.id + '&action=continue', payload),
      api(endpoint + '?id=' + completed.id + '&action=continue', payload)
    ]);
    const recovered = await done(completed.id);
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.calls.filter(call => call.attemptId === continuationId).length, 1);
    assert.equal(recovered.report.attempts.filter(attempt => attempt.id === continuationId).length, 1);

    const cancelled = await api(endpoint, {requestId:randomUUID(), goal:'cancel continuation fixture'});
    for (let i = 0; i < 100; i++) {
      const observed = await api('/api/development-fixture');
      if (observed.calls.some(call => call.sessionId === cancelled.sessionId)) break;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    await api(endpoint + '?id=' + cancelled.id + '&action=cancel', {});
    const stopped = await done(cancelled.id);
    assert.equal(stopped.status, 'stopped');
    const resumeId = randomUUID();
    await api(endpoint + '?id=' + cancelled.id + '&action=continue', {continuationId:resumeId,
      kind:'continue', instruction:'resume after cancellation', additionalCalls:0});
    const resumed = await done(cancelled.id);
    assert.equal(resumed.status, 'completed'); assert.equal(resumed.artifact, 'CANCELLED_TASK_CONTINUED');
    assert.equal(resumed.sessionId, cancelled.sessionId);
    assert.equal(resumed.report.attempts.at(-2).status, 'stopped');
    assert.equal(resumed.report.attempts.at(-1).id, resumeId);
  });

  await t.test('restart unknown requires read-only reconciliation and restores only gateway-owned narrowing', async () => {
    const first = await api(endpoint, {requestId:randomUUID(), goal:'restart unknown fixture'});
    const second = await api(endpoint, {requestId:randomUUID(), goal:'restart unknown fixture'});
    let firstBeforeRestart, secondBeforeRestart;
    for (let i = 0; i < 200; i++) {
      const observed = await api('/api/development-fixture');
      firstBeforeRestart = await api(endpoint + '?id=' + first.id);
      secondBeforeRestart = await api(endpoint + '?id=' + second.id);
      if (observed.calls.some(call => call.sessionId === first.sessionId) &&
          firstBeforeRestart.status === 'running' && secondBeforeRestart.status === 'queued') break;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    assert.equal(firstBeforeRestart.status, 'running');
    assert.equal(secondBeforeRestart.status, 'queued');
    const observedBeforeRestart = await api('/api/development-fixture');
    assert.ok(observedBeforeRestart.calls.some(call => call.sessionId === first.sessionId));
    assert.ok(!observedBeforeRestart.calls.some(call => call.sessionId === second.sessionId));
    await restart();
    for (const [task, expectedCalls] of [[first, 1], [second, 0]]) {
      const unknown = await api(endpoint + '?id=' + task.id);
      assert.equal(unknown.status, 'unknown'); assert.equal(unknown.calls.length, expectedCalls);
      if (expectedCalls > 0) assert.equal(unknown.calls[0].outcome, 'unknown');
      assert.equal(unknown.report.attempts[0].status, 'unknown');
      const denied = await rejected(endpoint + '?id=' + task.id + '&action=continue', {continuationId:randomUUID(),
        kind:'continue', instruction:'must not replay unknown work', additionalCalls:0});
      assert.deepEqual(denied, {status:400, body:{error:'RECONCILIATION_REQUIRED'}});
    }

    const reconcileFirst = randomUUID();
    await api(endpoint + '?id=' + first.id + '&action=continue', {continuationId:reconcileFirst,
      kind:'reconcile', instruction:'inspect current evidence only', additionalCalls:0});
    const reconciled = await done(first.id);
    const reconcileFixture = await api('/api/development-fixture?sessionId=' + first.sessionId);
    assert.equal(reconciled.status, 'reconciled', JSON.stringify({failureCode:reconciled.failureCode, failureStage:reconciled.failureStage,
      attempts:reconciled.report.attempts, calls:reconcileFixture.calls, adapterAttempts:reconcileFixture.attempts})); assert.equal(reconciled.artifact, 'READ_ONLY_RECONCILIATION_FINISHED');
    const reconciliation = reconciled.report.attempts.at(-1).reconciliationEvidence;
    assert.deepEqual(reconciliation.security, {sandboxBefore:'workspace-write', narrowedByGateway:true,
      narrowingEventSeq:reconciliation.security.narrowingEventSeq});
    assert.ok(Number.isInteger(reconciliation.security.narrowingEventSeq));
    assert.deepEqual(Object.keys(reconciliation.git).sort(), ['available','changedEntries','clean','stagedEntries','unstagedEntries','untrackedEntries']);
    const reconcileCalls = (await api('/api/development-fixture')).calls
      .filter(call => call.sessionId === first.sessionId && call.rpcId === reconcileFirst);
    assert.equal(reconcileCalls.length, 2);
    assert.ok(reconcileCalls.every(call => call.currentPrompt.includes('Gateway workspace tool context:') &&
      call.currentPrompt.includes('file tool paths are resolved relative to the selected authorized workspace')));
    assert.ok(reconcileCalls.every(call => call.permissions.sandbox === 'read-only' && call.permissions.approval === 'ask'));
    assert.ok(reconcileCalls.every(call => JSON.stringify(call.tools) ===
      JSON.stringify(['glob','grep','list_subagent_models','read','subagent'])));
    assert.ok(reconcileCalls.every(call => !call.tools.some(name => ['edit','write','pwsh'].includes(name))));

    const continueId = randomUUID();
    await api(endpoint + '?id=' + first.id + '&action=continue', {continuationId:continueId,
      kind:'continue', instruction:'continue after reconciliation', additionalCalls:0});
    const continued = await done(first.id);
    assert.equal(continued.status, 'completed'); assert.equal(continued.artifact, 'RECONCILED_TASK_CONTINUED');
    const continuationCall = (await api('/api/development-fixture')).calls
      .find(call => call.sessionId === first.sessionId && call.rpcId === continueId);
    assert.equal(continuationCall.permissions.sandbox, 'workspace-write');
    assert.ok(continuationCall.tools.includes('write'));

    const reconcileSecond = randomUUID();
    await api(endpoint + '?id=' + second.id + '&action=continue', {continuationId:reconcileSecond,
      kind:'reconcile', instruction:'inspect current evidence only', additionalCalls:0});
    await done(second.id);
    const changedPolicy = await api('/api/development-fixture', {action:'append-sandbox-mode',
      sessionId:second.sessionId, mode:'read-only'});
    assert.equal(changedPolicy.permissions.sandbox, 'read-only');
    const before = (await api(endpoint + '?id=' + second.id)).calls.length;
    const seedBefore = await readFile(resolve(cwd, 'seed.txt'), 'utf8');
    const readOnlyId = randomUUID();
    await api(endpoint + '?id=' + second.id + '&action=continue', {continuationId:readOnlyId,
      kind:'continue', instruction:'exercise user read-only boundary', additionalCalls:0});
    // P11-B permits read-only roots. Verify real dispatch stays narrow rather
    // than requiring a text-only task to fail or silently accepting a widening.
    const readOnly = await done(second.id);
    assert.equal(readOnly.status, 'completed');
    assert.equal(readOnly.artifact, 'USER_READ_ONLY_BOUNDARY_OBSERVED');
    assert.equal(readOnly.calls.length, before + 3);
    const boundaryCalls = (await api('/api/development-fixture')).calls
      .filter(call => call.sessionId === second.sessionId && call.rpcId === readOnlyId);
    assert.equal(boundaryCalls.length, 3);
    assert.ok(boundaryCalls.every(call => call.permissions.sandbox === 'read-only' && call.permissions.approval === 'ask'));
    const results = boundaryCalls.flatMap(call => call.results);
    for (const name of ['read', 'glob', 'grep', 'write', 'edit', 'pwsh', 'subagent', 'models']) {
      const block = results.find(item => item.toolCallId === 'readonly-boundary-' + name);
      assert.ok(block, 'Missing native read-only result: ' + name);
      const denied = !['read', 'glob', 'grep'].includes(name);
      assert.equal(block.isError ?? false, denied, JSON.stringify(block));
      if (denied) assert.match(JSON.stringify(block), /permissions unavailable or changed/);
    }
    assert.equal(await readFile(resolve(cwd, 'seed.txt'), 'utf8'), seedBefore);
    for (const file of ['readonly-forbidden.txt', 'readonly-shell.txt'])
      await assert.rejects(readFile(resolve(cwd, file)), {code:'ENOENT'});
    assert.equal(boundaryCalls.some(call => call.parentSessionId), false);
    const finalPolicy = await api('/api/development-fixture?sessionId=' + encodeURIComponent(second.sessionId));
    assert.equal(finalPolicy.permissions.sandbox, 'read-only');
    assert.equal(finalPolicy.lastModeSeq, changedPolicy.lastModeSeq, 'the turn must not replace the user sandbox decision');
  });

  await t.test('denied command cannot be reported as an executed nonzero exit or model success', async () => {
    const task = await api(endpoint, {requestId: randomUUID(), goal: 'command failure report'});
    const result = await done(task.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.report.commandOperations[0].outcome, 'failed');
    assert.equal(result.report.commandOperations[0].exitCode, undefined);
    assert.equal(result.report.failedOperations[0].errorCode, 'TOOL_FAILED');
    assert.equal(result.report.businessOutcome, 'unverified');
  });
});
