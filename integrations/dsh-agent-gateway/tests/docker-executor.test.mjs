import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDockerArgv, DEFAULT_DOCKER_IMAGE, dockerExecutorEnabled, dockerImageFromEnv,
  safeDockerCliEnv, dockerWorkingDirectory, dockerProfileFromEnv, DEFAULT_DOCKER_BROWSER_IMAGE,
} from '../docker-executor-spec.mjs';

const pwsh = ['C:/Program Files/PowerShell/7/pwsh.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Get-Content note.txt'];

test('Docker executor wraps PowerShell without a host shell and preserves the workspace policy', () => {
  const argv = buildDockerArgv({argv: pwsh, workspaceRoot: 'C:/work/gateway', mode: 'workspace-write'});
  for (const flag of ['--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--pids-limit=128', '--memory=512m', '--cpus=1', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev'])
    assert.ok(argv.includes(flag), flag);
  assert.ok(argv.includes('type=bind,source=C:/work/gateway,target=/workspace'));
  assert.deepEqual(argv.slice(-6), ['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Get-Content note.txt']);
  assert.equal(argv.at(-7), DEFAULT_DOCKER_IMAGE);
  assert.equal(argv.at(-8), 'DSH_GATEWAY_RUNTIME=/opt/gateway');
  assert.equal(argv.includes('C:/Program Files/PowerShell/7/pwsh.exe'), false);
});

test('read-only mode uses a read-only bind while retaining only the temporary runtime mount', () => {
  const argv = buildDockerArgv({argv: pwsh, workspaceRoot: '/srv/gateway', mode: 'read-only'});
  assert.ok(argv.includes('type=bind,source=/srv/gateway,target=/workspace,readonly'));
  assert.ok(argv.includes('--tmpfs'));
  assert.ok(argv.includes('/tmp:rw,noexec,nosuid,nodev'));
});

test('Docker executor rejects ambiguous workspace and PowerShell argv inputs', () => {
  assert.throws(() => buildDockerArgv({argv: pwsh, workspaceRoot: 'C:/unsafe,comma', mode: 'workspace-write'}), /absolute workspace/);
  assert.throws(() => buildDockerArgv({argv: [...pwsh, 'extra'], workspaceRoot: 'C:/work', mode: 'workspace-write'}), /argv shape/);
  assert.throws(() => buildDockerArgv({argv: pwsh, workspaceRoot: 'C:/work', mode: 'danger-full-access'}), /does not support/);
});

test('Docker configuration does not forward host credential variables', () => {
  assert.equal(dockerExecutorEnabled({DSH_GATEWAY_DOCKER_EXECUTOR: '1'}), true);
  assert.equal(dockerExecutorEnabled({DSH_GATEWAY_DOCKER_EXECUTOR: '0'}), false);
  assert.equal(dockerImageFromEnv({DSH_GATEWAY_DOCKER_IMAGE: 'gateway:test'}), 'gateway:test');
  assert.deepEqual(safeDockerCliEnv({PATH: 'C:/Windows/System32', HOME: 'C:/secret', OPENAI_API_KEY: 'secret'}), {
    PATH: 'C:/Windows/System32', Path: 'C:/Windows/System32',
  });
});


test('Docker executor maps an in-workspace host cwd to the container bind', () => {
  assert.equal(dockerWorkingDirectory('C:/work/gateway', 'C:/work/gateway/subdir'), '/workspace/subdir');
  assert.equal(dockerWorkingDirectory('/srv/gateway', '/workspace/subdir'), '/workspace/subdir');
  assert.throws(() => dockerWorkingDirectory('C:/work/gateway', 'C:/other'), /stay inside/);
  const argv = buildDockerArgv({argv: pwsh, workspaceRoot: 'C:/work/gateway', workdir: 'C:/work/gateway/subdir', mode: 'workspace-write'});
  assert.equal(argv[argv.indexOf('--workdir') + 1], '/workspace/subdir');
});


test('Docker cwd rejects escapes and supports container and relative subdirectories', () => {
  for (const path of ['../outside', '/workspace/../../outside', 'D:/other', 'C:/work/gateway-other'])
    assert.throws(() => dockerWorkingDirectory('C:/work/gateway', path), /stay inside/);
  for (const path of ['subdir', '/workspace/subdir', 'C:/work/gateway/subdir'])
    assert.equal(dockerWorkingDirectory('C:/work/gateway', path), '/workspace/subdir');
  assert.equal(dockerWorkingDirectory('C:/work/gateway', '/workspace'), '/workspace');
});

test('browser resource profile is explicit, bounded and preserves every other confinement option', () => {
  const standard = buildDockerArgv({argv: pwsh, workspaceRoot: '/srv/gateway', mode: 'read-only'});
  const browser = buildDockerArgv({argv: pwsh, workspaceRoot: '/srv/gateway', mode: 'read-only', profile: 'browser'});
  assert.deepEqual(browser, standard.map(value => value === '--pids-limit=128' ? '--pids-limit=256'
    : value === '--memory=512m' ? '--memory=1g'
    : value === DEFAULT_DOCKER_IMAGE ? DEFAULT_DOCKER_BROWSER_IMAGE : value));
  assert.equal(dockerProfileFromEnv({}), 'standard');
  assert.equal(dockerProfileFromEnv({DSH_GATEWAY_DOCKER_PROFILE: 'browser'}), 'browser');
  assert.equal(dockerImageFromEnv({DSH_GATEWAY_DOCKER_PROFILE: 'browser'}), DEFAULT_DOCKER_BROWSER_IMAGE);
  assert.throws(() => dockerProfileFromEnv({DSH_GATEWAY_DOCKER_PROFILE: 'unlimited'}), /Unsupported/);
  assert.throws(() => buildDockerArgv({argv: pwsh, workspaceRoot: '/srv/gateway', mode: 'read-only', profile: 'unlimited'}), /Unsupported/);
});
