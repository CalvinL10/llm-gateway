import assert from 'node:assert/strict';
import {mkdir, mkdtemp, realpath, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectRuntime} from '../../ops/runtime-paths.mjs';

// Pure file fixtures need no installation; module fixtures must stay below runtime.
export async function createTestScratch(prefix, {parent = tmpdir()} = {}) {
  assert.match(prefix, /^[a-zA-Z0-9][a-zA-Z0-9-]*-$/);
  await mkdir(resolve(parent), {recursive: true});
  const root = await realpath(resolve(parent));
  const path = await mkdtemp(resolve(root, prefix));
  return {path, async remove() {
    const target = await realpath(path).catch(error => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (target === null) return;
    const within = relative(root, target);
    assert.ok(!isAbsolute(within) && within.startsWith(prefix) && !/[\\/]/.test(within),
      'Refusing to remove a fixture outside its absolute scratch parent');
    assert.equal(target, path, 'Refusing to remove a redirected fixture');
    await rm(path, {recursive: true, force: true});
  }};
}

export async function createRuntimeFixture(prefix) {
  // No environment or cwd fallback to a developer's historical installation.
  const {runtime} = await inspectRuntime(fileURLToPath(new URL('../../runtime/', import.meta.url)));
  const parent = process.env.DSH_GATEWAY_TEST_SCRATCH;
  const scratch = await createTestScratch(prefix, {parent:parent || runtime});
  if (parent) await symlink(resolve(runtime, 'node_modules'), resolve(scratch.path, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  return {runtime, ...scratch};
}
