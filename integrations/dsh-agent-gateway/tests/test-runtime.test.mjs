import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {copyFile, mkdir, readFile, realpath, rename, rmdir, symlink, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, resolve} from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRuntimeFixture, createTestScratch} from './fixtures/test-runtime.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const execFileAsync = promisify(execFile);

test('scratch explicitly creates a missing parent and keeps concurrent fixtures isolated', async t => {
  const outer = await createTestScratch('portable-parent-');
  t.after(outer.remove);
  const parent = resolve(outer.path, 'missing', 'parent');
  const first = await createTestScratch('scratch-', {parent});
  const second = await createTestScratch('scratch-', {parent});
  assert.ok(isAbsolute(first.path));
  assert.equal(dirname(first.path), await realpath(parent));
  assert.notEqual(first.path, second.path);
  await writeFile(resolve(second.path, 'sentinel'), 'keep sibling');
  await first.remove();
  await first.remove();
  await assert.rejects(realpath(first.path), {code: 'ENOENT'});
  assert.equal(await readFile(resolve(second.path, 'sentinel'), 'utf8'), 'keep sibling');
  await second.remove();
});

test('scratch rejects path prefixes that could escape the nominated parent', async () => {
  for (const prefix of ['', '../outside-', '..\\outside-', '/absolute-', 'C:\\outside-', 'nested/path-', 'no-trailing-dash'])
    await assert.rejects(createTestScratch(prefix), {code: 'ERR_ASSERTION'});
});

test('cleanup refuses a redirected junction even to a same-prefix sibling', async t => {
  const outer = await createTestScratch('portable-redirect-');
  t.after(outer.remove);
  const fixture = await createTestScratch('scratch-', {parent: outer.path});
  const outside = await createTestScratch('scratch-', {parent: outer.path});
  await writeFile(resolve(outside.path, 'sentinel'), 'do not delete redirected data');
  const saved = resolve(outer.path, 'saved-fixture');
  await rename(fixture.path, saved);
  await symlink(outside.path, fixture.path, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await assert.rejects(fixture.remove(), /Refusing to remove a redirected fixture/);
    assert.equal(await readFile(resolve(outside.path, 'sentinel'), 'utf8'), 'do not delete redirected data');
  } finally {
    // Remove only the link, never recurse through its target.
    if (process.platform === 'win32') await rmdir(fixture.path);
    else await (await import('node:fs/promises')).unlink(fixture.path);
    await rename(saved, fixture.path);
  }
  await fixture.remove();
  await outside.remove();
});

test('module fixtures resolve actual ESM dependencies inside the committed runtime', async t => {
  const fixture = await createRuntimeFixture('portable-module-');
  t.after(fixture.remove);
  assert.equal(fixture.runtime, await realpath(resolve(source, 'runtime')));
  assert.equal(dirname(fixture.path), fixture.runtime);
  const probe = resolve(fixture.path, 'probe.mjs');
  await writeFile(probe, "import {z} from 'zod';\nexport const value=z.string().parse('loaded');\nexport const dependency=import.meta.resolve('zod');\n");
  const result = await import(pathToFileURL(probe));
  assert.equal(result.value, 'loaded');
  const runtimeModules = pathToFileURL(resolve(fixture.runtime, 'node_modules') + '/').href;
  assert.ok(result.dependency.startsWith(runtimeModules), result.dependency);
});

test('missing and incomplete runtime installations fail instead of using historical dependencies', async t => {
  const outer = await createTestScratch('portable-missing-');
  t.after(outer.remove);
  await mkdir(resolve(outer.path, 'tests/fixtures'), {recursive: true});
  await mkdir(resolve(outer.path, 'ops'), {recursive: true});
  await copyFile(resolve(source, 'tests/fixtures/test-runtime.mjs'), resolve(outer.path, 'tests/fixtures/test-runtime.mjs'));
  await copyFile(resolve(source, 'ops/runtime-paths.mjs'), resolve(outer.path, 'ops/runtime-paths.mjs'));
  const helper = await import(pathToFileURL(resolve(outer.path, 'tests/fixtures/test-runtime.mjs')));
  await assert.rejects(helper.createRuntimeFixture('module-'), /runtime does not exist.*npm ci/);
  const incomplete = await createTestScratch('incomplete-', {parent: resolve(outer.path, 'runtime')});
  await incomplete.remove();
  await assert.rejects(helper.createRuntimeFixture('module-'), /runtime is incomplete.*Missing/s);
});

test('runtime resolution ignores a foreign cwd and runtime environment override', async t => {
  const foreign = await createTestScratch('portable-cwd-');
  t.after(foreign.remove);
  const helperUrl = pathToFileURL(resolve(source, 'tests/fixtures/test-runtime.mjs')).href;
  const script = 'const {createRuntimeFixture}=await import(' + JSON.stringify(helperUrl) + ');' +
    "const fixture=await createRuntimeFixture('portable-child-');" +
    'try {console.log(JSON.stringify({runtime:fixture.runtime,path:fixture.path}));} finally {await fixture.remove();}';
  const {stdout} = await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: foreign.path, env: {...process.env, DSH_GATEWAY_RUNTIME: resolve(foreign.path, 'not-installed')},
    windowsHide: true,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.runtime, await realpath(resolve(source, 'runtime')));
  assert.equal(dirname(result.path), result.runtime);
  await assert.rejects(realpath(result.path), {code: 'ENOENT'});
});
