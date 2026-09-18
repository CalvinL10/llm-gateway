import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';

const source = dirname(fileURLToPath(import.meta.url)), root = resolve(source, '../..');
const runtime = resolve(root, '.local/dsh-task02');
const bin = resolve(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js');

// Ordinary integration test against the real installed Web/controller/preset/tool stack.
// Every model response is scripted; no subscription Home or credentials are used.
async function startHost(t, {presetTransform = value => value} = {}) {
  const run = await mkdtemp(resolve(runtime, 'development-test-'));
  const home = resolve(run, 'home'), cwd = resolve(run, 'workspace');
  const presetDir = resolve(home, '.agent-presets/gateway-agent');
  await mkdir(presetDir, {recursive: true}); await mkdir(cwd);
  await writeFile(resolve(cwd, 'seed.txt'), 'BEFORE\nKEEP_THIS_LINE\n');
  await writeFile(resolve(cwd, 'unread.txt'), 'UNREAD_ORIGINAL\n');
  await writeFile(resolve(cwd, 'shell-seed.txt'), 'SHELL_BEFORE\n');
  for (const file of ['package.json', 'index.js', 'ledger.js','report.js','panel.js', 'tools.js', 'development-fixture.js'])
    await copyFile(resolve(source, file), resolve(run, file));
  await copyFile(resolve(source, 'preset/development-preset.yml'), resolve(presetDir, 'preset.yml'));
  const preset = presetTransform(await readFile(resolve(source, 'preset/development-agent.cordis.yml'), 'utf8'));
  await writeFile(resolve(presetDir, 'agent.cordis.yml'), preset.replace(
    "'@llm-gateway/dsh-agent-gateway/tools'", JSON.stringify(resolve(run, 'tools.js').replaceAll('\\', '/'))));
  const env = {...process.env, DSH_HOME: home, DSH_PERMISSION_MODE: 'workspace-write'};
  execFileSync(process.execPath, [bin, 'web', '--dump-config'], {cwd, env, stdio: 'pipe'});
  const route = {provider: 'fixture-development', model: 'scripted'};
  const patchPath = resolve(run, 'test.patch.json');
  await writeFile(patchPath, JSON.stringify([
    {id: 'session-title-llm', disabled: true}, {id: 'llm-retry', disabled: true},
    {id: 'subagent-model-selection-settings', config: {enabled: true, allowedModels: [route]}},
    {insert: [
      {id: 'development-fixture', name: resolve(run, 'development-fixture.js').replaceAll('\\', '/')},
      {id: 'gateway-agent-tasks', name: resolve(run, 'index.js').replaceAll('\\', '/'),
        config: {cwd, policy: {root: route, allowedRoutes: [route], toolSet: 'development', maxCalls: 8}}}
    ]}
  ], null, 2));
  const child = spawn(process.execPath, [bin, 'web', '--patch', patchPath, '--no-open', '--host', '127.0.0.1', '--port', '0'],
    {cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill(); await exited;
  });
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
  const origin = new URL(url).origin;
  const login = await fetch(url, {redirect: 'manual'}); assert.equal(login.status, 303);
  const headers = {Cookie: login.headers.getSetCookie().map(s => s.split(';')[0]).join('; '),
    Origin: origin, 'Content-Type': 'application/json'};
  const endpoint = '/api/gateway-agent-tasks';
  async function api(path = endpoint, value) {
    const response = await fetch(origin + path, {headers,
      ...(value === undefined ? {} : {method: 'POST', body: JSON.stringify(value)})});
    assert.equal(response.status, 200); return response.json();
  }
  async function done(id) {
    for (let i = 0; i < 400; i++) {
      const task = await api(endpoint + '?id=' + id);
      if (!['running', 'cancel-requested'].includes(task.status)) return task;
      await new Promise(r => setTimeout(r, 50));
    }
    throw Error('Development fixture task did not settle');
  }
  return {cwd, api, done, origin, endpoint, headers};
}

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

test('development preset on the native host (zero real models)', {timeout: 120000}, async t => {
  const {cwd, api, done, origin, endpoint, headers} = await startHost(t);
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
    toolResult('outside-write', true, /sandbox: file access denied under workspace-write mode/);
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
  await t.test('native pwsh and re-read then edit retain workspace-write confinement', async () => {
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
    assert.ok(shell); assert.equal(shell.isError, false, JSON.stringify(shell));
    assert.match(JSON.stringify(shell.content), /PWSH_READY/);
    assert.equal(result.report.commandOperations[0].outcome, 'succeeded');
    assert.equal(result.report.commandOperations[0].exitCode, 0);
    assert.equal(result.report.validation, 'not-established');
    for (const id of ['shell-read', 'shell-reread', 'shell-edit']) {
      const block = results.find(r => r.toolCallId === id);
      assert.ok(block, id); assert.equal(block.isError, false, JSON.stringify(block));
    }
    assert.equal(await readFile(resolve(cwd, 'shell-seed.txt'), 'utf8'), 'SHELL_AFTER\n');
  });
  await t.test('cross-workspace write approval chain: unapproved, rejected, and single-use semantics', async () => {
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
    toolResult('approval-no-escalation', true, /sandbox: file access denied under workspace-write mode/);
    toolResult('approval-unapproved', true, /sandbox escalation to "danger-full-access" requires approval, but no approval channel is available/);
    toolResult('approval-rejected', true, /the user rejected escalating this operation to "danger-full-access"/);
    toolResult('approval-allowed-once', false, /Created file/);
    toolResult('approval-second-attempt', true, /sandbox: file access denied under workspace-write mode/);

    for (const file of ['../outside-no-escalation.txt', '../outside-unapproved.txt', '../outside-rejected.txt', '../outside-second-attempt.txt']) {
      await assert.rejects(readFile(resolve(cwd, file)), {code: 'ENOENT'});
    }
    assert.equal(await readFile(resolve(cwd, '../outside-allowed-once.txt'), 'utf8'), 'ALLOWED_ONCE_WRITTEN\n');

    assert.ok(observed.syntheticApprovals.length >= 3);
    for (const record of observed.syntheticApprovals) {
      assert.equal(record.synthetic, true);
    }
    const outcomes = observed.syntheticApprovals.map(a => a.outcome);
    assert.ok(outcomes.includes('unavailable'));
    assert.ok(outcomes.includes('rejected'));
    assert.ok(outcomes.includes('allowed-once'));

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
      assert.equal(result.report.confirmedFileChanges.length, scenario === 'edit' ? 1 : 0);
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
  });
  await t.test('command nonzero is failed even when tool transport and model finish normally', async () => {
    const task = await api(endpoint, {requestId: randomUUID(), goal: 'command failure report'});
    const result = await done(task.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.report.commandOperations[0].outcome, 'failed');
    assert.equal(result.report.commandOperations[0].exitCode, 7);
    assert.equal(result.report.failedOperations[0].errorCode, 'COMMAND_EXIT_NONZERO');
    assert.equal(result.report.businessOutcome, 'unverified');
  });
});

test('ensureGrantableWorkspace verifies and establishes Windows ACL standing grant idempotently', async () => {
  const { ensureGrantableWorkspace } = await import('./deploy-subscription.mjs');
  const tempWorkspace = resolve(runtime, 'test-acl-grantable-' + randomUUID());
  try {
    await ensureGrantableWorkspace(tempWorkspace);
    // Idempotent re-run on already grantable workspace succeeds without error
    await ensureGrantableWorkspace(tempWorkspace);
  } finally {
    const { rmSync, existsSync } = await import('node:fs');
    if (existsSync(tempWorkspace)) rmSync(tempWorkspace, { recursive: true, force: true });
  }
});
