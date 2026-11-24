import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const script = new URL('../../ops/maintenance.mjs', import.meta.url);
const scriptPath = fileURLToPath(script);

for (const flag of ['--help', '-h']) {
  test(`${flag} displays standalone help and exits successfully`, async () => {
    const {stdout, stderr} = await execFileAsync(process.execPath, [scriptPath, flag], {encoding:'utf8'});

    assert.equal(stderr, '');
    for (const command of ['inspect', 'export', 'backup', 'restore', 'delete-plan', 'delete'])
      assert.match(stdout, new RegExp(`^  ${command.replace('-', '\\-')}\\s`, 'm'));
    for (const option of ['--home <path>', '--output <path>', '--backup <path>', '--plan <path>', '--confirm-home <path>'])
      assert.ok(stdout.includes(option), `help should show ${option}`);
    assert.match(stdout, /backup and every mutation command \(restore and delete\).*require[\s\S]*stopped/i);
    assert.match(stdout, /Back up Home data before running restore or delete\./);
    assert.match(stdout, /credentials and configuration are excluded from data backups\./i);
  });
}

test('importing maintenance does not execute the CLI', async () => {
  const {stdout, stderr} = await execFileAsync(process.execPath, [
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(script.href)})`,
  ], {encoding:'utf8'});

  assert.equal(stdout, '');
  assert.equal(stderr, '');
});
