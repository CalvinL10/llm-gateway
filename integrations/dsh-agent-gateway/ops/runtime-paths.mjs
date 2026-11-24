import {access, mkdtemp, readFile, realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';

/** Keep fixtures beside host dependencies, but never require a writable container image. */
export async function createRuntimeScratch(runtime, {createTemp = mkdtemp, temporaryRoot = tmpdir()} = {}) {
  try { return await createTemp(resolve(runtime, 'delegation-test-')); }
  catch (error) {
    // Only a read-only filesystem justifies the tmpfs fallback. Permission failures remain errors.
    if (error?.code !== 'EROFS') throw error;
    return createTemp(resolve(temporaryRoot, 'gateway-delegation-test-'));
  }
}

const requiredPackages = [
  '@deepseek-ai/cordis-plugin-group',
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai',
  'zod',
];

export function runtimeArgument(argv, fallback) {
  let runtime = process.env.DSH_GATEWAY_RUNTIME || fallback;
  const rest = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== '--runtime') {
      rest.push(argv[index]);
      continue;
    }
    if (argv[index + 1] === undefined) throw new Error('Missing value for --runtime');
    runtime = argv[++index];
  }
  return {runtime: resolve(runtime), args: rest};
}

export async function inspectRuntime(input) {
  const runtime = await realpath(resolve(input)).catch(error => {
    if (error?.code === 'ENOENT') throw new Error(`DSH runtime does not exist: ${resolve(input)}. Run npm ci from the committed runtime lock first.`);
    throw error;
  });
  const launcher = resolve(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  const manifests = Object.fromEntries(requiredPackages.map(name => [name,
    resolve(runtime, 'node_modules', ...name.split('/'), 'package.json')]));
  const missing = [];
  for (const [name, path] of [['@deepseek-ai/dsh launcher', launcher], ...Object.entries(manifests)]) {
    try { await access(path, constants.R_OK); } catch { missing.push(`${name}: ${path}`); }
  }
  if (missing.length) throw new Error(`DSH runtime is incomplete. Missing:\n${missing.join('\n')}\nReinstall with npm ci from the committed runtime lock.`);
  const versions = {};
  for (const [name, path] of Object.entries(manifests)) {
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    versions[name] = manifest.version;
  }
  return {runtime, launcher, manifests, versions};
}
