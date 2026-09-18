import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = dirname(fileURLToPath(import.meta.url));
const root = resolve(source, '../..');
const runtime = resolve(root, '.local/dsh-task02');
const bin = resolve(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const patch = resolve(runtime, 'gateway-workflow/web.patch.yml');
const cwd = resolve(root, '.local/dsh-task02-workspace');
const taskHome = resolve(root, '.local/dsh-task02-home');
const receiptPath = resolve(root, '.local/task03-real-attempt-2-receipt.json');
const resultPath = resolve(root, '.local/task03-real-attempt-2-result.json');
const priorFailure = 'e1fb1ed7-1225-4088-a5ab-4b3ddd0f7b60';
const env = {...process.env, DSH_HOME: taskHome, DSH_PERMISSION_MODE: 'read-only'};
const requireRuntime = createRequire(resolve(runtime, 'package.json'));

try {
  await access(receiptPath);
  throw new Error(`Refusing duplicate submission: inspect ${receiptPath}`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

execFileSync(process.execPath, [resolve(source, 'deploy.mjs')], {cwd: root, stdio: 'inherit'});
const rows = requireRuntime('yaml').parse(
  execFileSync(process.execPath, [bin, 'web', '--patch', patch, '--dump-config'], {cwd, env, encoding: 'utf8'}),
  {customTags: [{tag: 'tag:yaml.org,2002:js', resolve: value => value}]},
);
for (const id of ['session-title-llm', 'llm-retry', 'compaction-basic']) {
  if (rows.find(row => row.id === id)?.disabled !== true) throw new Error(`Unexpected active helper: ${id}`);
}

const child = spawn(process.execPath,
  [bin, 'web', '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', '3081'],
  {cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']},
);
let stdout = '';
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk; });
const loginUrl = await new Promise((resolveUrl, reject) => {
  const timeout = setTimeout(() => reject(new Error(`DSH startup timeout: ${stderr}`)), 30_000);
  child.once('exit', code => {
    clearTimeout(timeout);
    reject(new Error(`DSH exited during startup (${code}): ${stderr}`));
  });
  child.stdout.on('data', chunk => {
    stdout += chunk;
    const match = stdout.match(/http:\/\/127\.0\.0\.1:3081\/\?token=[\w-]+/);
    if (match) {
      clearTimeout(timeout);
      resolveUrl(match[0]);
    }
  });
});

try {
  const origin = new URL(loginUrl).origin;
  const login = await fetch(loginUrl, {redirect: 'manual'});
  if (login.status !== 303) throw new Error(`DSH authentication exchange failed (${login.status})`);
  const Cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const headers = {Cookie, Origin: origin, 'Content-Type': 'application/json'};
  const api = async (path, value) => {
    const response = await fetch(origin + path, value === undefined
      ? {headers}
      : {method: 'POST', headers, body: JSON.stringify(value)});
    const data = await response.json();
    if (!response.ok) throw new Error(`${path}: ${JSON.stringify(data)}`);
    return data;
  };

  const existing = await api('/api/gateway-workflows');
  if (existing.length !== 1 || existing[0].id !== priorFailure || existing[0].status !== 'failed') {
    throw new Error('Workflow history changed; inspect it before any new real submission.');
  }
  const input = JSON.parse(await readFile(resolve(source, 'smoke-request.example.json'), 'utf8'));
  const catalog = await api('/api/gateway-workflows?catalog=1');
  for (const role of ['generation', 'review']) {
    const selected = input[role];
    const connection = catalog.connections.find(item => item.id === selected.connectionId);
    const model = catalog.models.groups.find(group => group.id === connection?.provider)
      ?.models.find(item => item.id === selected.model);
    if (!model?.reasoning?.efforts.some(effort => effort.id === selected.reasoningEffort)) {
      throw new Error(`Approved selection is unavailable: ${role}`);
    }
    console.log(`Verified ${role}: ${connection.provider} / ${selected.model} / ${selected.reasoningEffort}`);
  }

  // The user approved this exact two-stage input and route selection on 2026-09-17.
  const created = await api('/api/gateway-workflows', input);
  await writeFile(receiptPath, JSON.stringify({id: created.id, submittedAt: new Date().toISOString()}, null, 2));
  console.log(`Submitted once: ${created.id}`);

  let result = created;
  let lastState = '';
  const deadline = Date.now() + 240_000;
  while (result.status === 'running' && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 1_000));
    result = await api(`/api/gateway-workflows?id=${encodeURIComponent(created.id)}`);
    const state = JSON.stringify({
      status: result.status,
      generation: result.stages.generation.status,
      review: result.stages.review.status,
    });
    if (state !== lastState) {
      console.log(state);
      lastState = state;
    }
  }
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  if (result.status === 'running') throw new Error(`Timed out; inspect ${resultPath} and do not rerun.`);
  console.log(`Final status: ${result.status}`);
  console.log(`Result: ${resultPath}`);
} finally {
  if (child.exitCode === null) {
    const closed = once(child, 'exit');
    child.kill();
    await closed;
  }
}
