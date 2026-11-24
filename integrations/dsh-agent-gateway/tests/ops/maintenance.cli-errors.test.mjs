import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const maintenanceCli = fileURLToPath(new URL('../../ops/maintenance.mjs', import.meta.url));

function nonexistentPaths() {
  const id = randomUUID();
  return {
    home: resolve(tmpdir(), `dsh-maintenance-home-does-not-exist-${id}`),
    output: resolve(tmpdir(), `dsh-maintenance-backup-must-not-exist-${id}`),
  };
}

function runFailure(args, expectedError, paths) {
  assert.equal(existsSync(paths.home), false, 'test Home must not exist before invocation');
  assert.equal(existsSync(paths.output), false, 'test backup output must not exist before invocation');

  const result = spawnSync(process.execPath, [maintenanceCli, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });

  assert.equal(result.error, undefined, 'maintenance CLI subprocess should start');
  assert.notEqual(result.status, 0, `expected a nonzero exit status; stdout: ${result.stdout}`);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), {error: expectedError});
  assert.equal(existsSync(paths.home), false, 'argument failure must not create Home');
  assert.equal(existsSync(paths.output), false, 'argument failure must not create backup output');
}

test('unknown command exits nonzero with a meaningful JSON error', () => {
  const paths = nonexistentPaths();
  runFailure(
    ['not-a-maintenance-command', '--home', paths.home, '--output', paths.output],
    'Command must be one of: inspect, export, backup, restore, delete-plan, delete',
    paths,
  );
});

test('inspect without --home exits nonzero with a meaningful JSON error', () => {
  const paths = nonexistentPaths();
  runFailure(['inspect'], 'Missing required option --home', paths);
});

test('backup without --output validates arguments before touching nonexistent Home', () => {
  const paths = nonexistentPaths();
  runFailure(['backup', '--home', paths.home], 'Missing required option --output', paths);
});

test('restore without --backup exits nonzero without touching nonexistent Home', () => {
  const paths = nonexistentPaths();
  runFailure(['restore', '--home', paths.home], 'Missing required option --backup', paths);
});
