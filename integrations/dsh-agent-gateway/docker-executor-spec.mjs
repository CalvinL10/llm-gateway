import {isAbsolute, posix, win32} from 'node:path';

export const DEFAULT_DOCKER_IMAGE = 'llm-gateway-pwsh:node24-pwsh7.5';
export const DEFAULT_DOCKER_BROWSER_IMAGE = 'llm-gateway-pwsh:node24-pwsh7.5-firefox140';

export function dockerProfileFromEnv(env = process.env) {
  const profile = env.DSH_GATEWAY_DOCKER_PROFILE || 'standard';
  if (!['standard', 'browser'].includes(profile)) throw new Error('Unsupported Docker resource profile');
  return profile;
}

const DOCKER_LABEL = 'llm-gateway.executor=docker';
const CONTAINER_PWSH = 'pwsh';
const COMMAND_FLAGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'];

export function dockerExecutorEnabled(env = process.env) {
  return env.DSH_GATEWAY_DOCKER_EXECUTOR === '1';
}

export function dockerImageFromEnv(env = process.env) {
  const image = env.DSH_GATEWAY_DOCKER_IMAGE || (dockerProfileFromEnv(env) === 'browser' ? DEFAULT_DOCKER_BROWSER_IMAGE : DEFAULT_DOCKER_IMAGE);
  if (typeof image !== 'string' || !image.trim() || /[\x00-\x1f\s]/.test(image))
    throw new Error('Docker executor image must be a non-empty image reference without whitespace');
  return image;
}

function validateWorkspaceRoot(workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot) ||
      /[\x00-\x1f,]/.test(workspaceRoot))
    throw new Error('Docker executor requires an absolute workspace path without control characters or commas');
  return workspaceRoot.replaceAll('\\', '/');
}

function validatePwshArgv(argv) {
  if (!Array.isArray(argv) || argv.length !== 6 ||
      argv.slice(1, 5).some((value, index) => value !== COMMAND_FLAGS[index]) ||
      typeof argv[5] !== 'string')
    throw new Error('Docker executor received an unexpected PowerShell argv shape');
}

/** Translate only paths inside the authorized bind; never use container cwd as host cwd. */
export function dockerWorkingDirectory(workspaceRoot, workdir = '.') {
  const root = validateWorkspaceRoot(workspaceRoot);
  if (typeof workdir !== 'string' || /[\x00-\x1f]/.test(workdir))
    throw new Error('Invalid Docker working directory');
  const path = workdir.replaceAll('\\', '/');
  let target;
  if (path === '/workspace' || path.startsWith('/workspace/')) target = posix.normalize(path);
  else {
    const paths = /^[a-z]:\//i.test(root) ? win32 : posix;
    const relative = paths.relative(root, paths.resolve(root, path));
    if (relative === '..' || relative.startsWith('..' + paths.sep) || paths.isAbsolute(relative))
      throw new Error('Docker working directory must stay inside the workspace');
    target = posix.resolve('/workspace', relative.replaceAll('\\', '/'));
  }
  if (target !== '/workspace' && !target.startsWith('/workspace/'))
    throw new Error('Docker working directory must stay inside the workspace');
  return target;
}

/** Build the exact argv passed to the host Docker CLI, without a host shell. */
export function buildDockerArgv({argv, workspaceRoot, workdir, mode, profile = 'standard', image = profile === 'browser' ? DEFAULT_DOCKER_BROWSER_IMAGE : DEFAULT_DOCKER_IMAGE, dockerPath = 'docker'}) {
  dockerProfileFromEnv({DSH_GATEWAY_DOCKER_PROFILE: profile});
  validatePwshArgv(argv);
  const source = validateWorkspaceRoot(workspaceRoot);
  if (!['read-only', 'workspace-write'].includes(mode))
    throw new Error(`Docker executor does not support sandbox mode: ${mode}`);
  if (typeof dockerPath !== 'string' || !dockerPath.trim() || /[\x00-\x1f]/.test(dockerPath))
    throw new Error('Docker executor requires a valid docker executable');
  const args = [
    dockerPath, 'run', '--rm', '--pull=never', '--network=none', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    // Full browser + host reloads need finite larger PID/memory budgets.
    // Isolation flags stay identical; the ordinary shell profile is unchanged.
    `--pids-limit=${profile === 'browser' ? 256 : 128}`, `--memory=${profile === 'browser' ? '1g' : '512m'}`, '--cpus=1',
    '--label', DOCKER_LABEL,
    '--mount', `type=bind,source=${source},target=/workspace${mode === 'read-only' ? ',readonly' : ''}`,
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev',
  ];
  args.push(
    '--workdir', dockerWorkingDirectory(workspaceRoot, workdir),
    '--env', 'NO_COLOR=1', '--env', 'PAGER=cat', '--env', 'GIT_PAGER=cat',
    '--env', 'HOME=/tmp', '--env', 'XDG_CACHE_HOME=/tmp/.cache', '--env', 'TMPDIR=/tmp',
    '--env', 'DSH_GATEWAY_RUNTIME=/opt/gateway',
    image, CONTAINER_PWSH, ...argv.slice(1),
  );
  return args;
}

/** Keep Docker CLI discovery possible without forwarding credentials or host settings. */
export function safeDockerCliEnv(env = process.env) {
  const path = env.PATH ?? env.Path;
  return {
    ...(path ? {PATH: path, Path: path} : {}),
    ...(env.SystemRoot ? {SystemRoot: env.SystemRoot} : {}),
    ...(env.ComSpec ? {ComSpec: env.ComSpec} : {}),
    ...(env.TEMP ? {TEMP: env.TEMP} : {}),
    ...(env.TMP ? {TMP: env.TMP} : {}),
  };
}

export const dockerDenialSignatures = Object.freeze([
  'read-only file system', 'permission denied', 'operation not permitted', 'access is denied',
]);

export const dockerRunnerFailureRules = Object.freeze([{
  allowedExitCodes: Object.freeze([125]),
  fatalSignatures: Object.freeze([
    'unable to find image', 'pull access denied', 'cannot connect to the docker daemon',
    'error during connect', 'invalid reference format', 'unknown flag',
  ]),
}]);
