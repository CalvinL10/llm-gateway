import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../../../..');
const quote = value => "'" + value.replaceAll("'", "''") + "'";

async function check(action, state, expectedCalls, {fails = false, startFails = false} = {}) {
  const scratch = resolve(root, '.local/plugin-portability-check');
  await mkdir(scratch, {recursive: true});
  const home = await mkdtemp(resolve(scratch, 'local-command-test-'));
  try {
    await mkdir(resolve(home, '.gateway-lifecycle'));
    await writeFile(resolve(home, '.gateway-lifecycle/service.json'), '{}');
    const script = `
      $ErrorActionPreference='Stop'; $global:calls=@(); $beforeTemp=$env:TEMP; $beforeTmp=$env:TMP
      function global:node {
        $global:calls += $args[1]; $global:LASTEXITCODE=0
        if ($env:TEMP -ne ${quote(scratch)} -or $env:TMP -ne ${quote(scratch)}) { throw 'Wrong scratch directory' }
        if ($args[0] -ne ${quote(resolve(root, 'integrations/dsh-agent-gateway/ops/lifecycle.mjs'))}) { throw 'Wrong lifecycle' }
        if ($args[2] -ne '--home' -or $args[3] -ne ${quote(home)}) { throw 'Wrong Home arguments' }
        if ($args[1] -eq 'status') { '${JSON.stringify({status: state})}' }
        elseif ($args[1] -eq 'start' -and $${startFails}) { $global:LASTEXITCODE=1 }
        else { '{"status":"ok"}' }
      }
      $caught=$false
      try { & ${quote(resolve(root, 'gateway.ps1'))} ${action} -HomePath ${quote(home)} | Out-Null }
      catch { $caught=$true }
      if ($caught -ne $${fails}) { throw 'Unexpected failure outcome' }
      if (($global:calls -join ',') -ne ${quote(expectedCalls.join(','))}) { throw ('Unexpected calls: '+($global:calls -join ',')) }
      if ($env:TEMP -ne $beforeTemp -or $env:TMP -ne $beforeTmp) { throw 'Caller environment changed' }
      'LOCAL_COMMAND_PASS'
    `;
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      cwd: scratch, encoding: 'utf8', windowsHide: true,
      env: {...process.env, TEMP: scratch, TMP: scratch}, timeout: 15000,
    });
    assert.match(output, /LOCAL_COMMAND_PASS/);
  } finally {
    // The directory is generated immediately above under this repository only.
    assert.ok(home.startsWith(resolve(root, '.local') + '\\'));
    await rm(home, {recursive: true, force: true});
  }
}

const windows = {skip: process.platform !== 'win32'};
test('daily start reuses an already running service without restarting', windows,
  () => check('start', 'running', ['status']));
test('daily start starts a stopped Home exactly once from outside the repository', windows,
  () => check('start', 'stopped', ['status', 'start']));
test('daily start delegates degraded state to the locked exited-only check, not general recover', windows,
  () => check('start', 'degraded', ['status', 'start']));
test('daily start surfaces unsafe ownership without falling back to recover', windows,
  () => check('start', 'degraded', ['status', 'start'], {fails:true, startFails:true}));
test('daily start failure has no recovery fallback and restores caller environment', windows,
  () => check('start', 'stopped', ['status', 'start'], {fails: true, startFails: true}));
test('status, stop and explicit recover delegate only the requested lifecycle operation', windows, async () => {
  for (const action of ['status', 'stop', 'recover']) await check(action, 'running', [action]);
});
