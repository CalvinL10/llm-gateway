import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {runtimeArgument, inspectRuntime, createRuntimeScratch} from '../ops/runtime-paths.mjs';

test('read-only runtime uses an independent temporary scratch directory', async t => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'gateway-scratch-test-'));
  t.after(() => rm(temporaryRoot, {recursive: true, force: true}));
  const runtime = resolve(temporaryRoot, 'immutable-runtime');
  const calls = [];
  const run = await createRuntimeScratch(runtime, {temporaryRoot, createTemp: async prefix => {
    calls.push(prefix);
    if (calls.length === 1) throw Object.assign(new Error('read-only'), {code: 'EROFS'});
    return mkdtemp(prefix);
  }});
  assert.deepEqual(calls, [resolve(runtime, 'delegation-test-'), resolve(temporaryRoot, 'gateway-delegation-test-')]);
  await writeFile(resolve(run, 'fixture.txt'), 'temporary Home');
});

test('writable runtime stays beside dependencies and permission failures never fall back', async () => {
  const runtime = resolve('runtime');
  const prefixes = [];
  assert.equal(await createRuntimeScratch(runtime, {createTemp: async prefix => {
    prefixes.push(prefix); return prefix + 'unique';
  }}), resolve(runtime, 'delegation-test-unique'));
  assert.equal(prefixes.length, 1);
  for (const code of ['EACCES', 'EPERM', 'ENOENT']) {
    let calls = 0;
    const failure = Object.assign(new Error(code), {code});
    await assert.rejects(createRuntimeScratch(runtime, {createTemp: async () => { calls++; throw failure; }}), error => error === failure);
    assert.equal(calls, 1);
  }
});

test('runtime argument is explicit and preserves unrelated smoke arguments', () => {
  const parsed = runtimeArgument(['--http', '--runtime', 'relative runtime'], 'fallback');
  assert.equal(parsed.runtime, resolve('relative runtime'));
  assert.deepEqual(parsed.args, ['--http']);
  assert.throws(() => runtimeArgument(['--runtime'], 'fallback'), /Missing value/);
});

test('runtime inspection reports the exact missing launcher and packages', async t => {
  const runtime = await mkdtemp(resolve(tmpdir(), 'gateway-runtime-missing-'));
  t.after(() => rm(runtime, {recursive: true, force: true}));
  await assert.rejects(inspectRuntime(runtime), error => {
    assert.match(error.message, /@deepseek-ai\/dsh launcher/);
    assert.match(error.message, /@deepseek-ai\/dsh-llm-pi-ai/);
    assert.match(error.message, /npm ci from the committed runtime lock/);
    return true;
  });
});

test('runtime inspection accepts a complete manifest layout and reads versions', async t => {
  const runtime = await mkdtemp(resolve(tmpdir(), 'gateway-runtime-complete-'));
  t.after(() => rm(runtime, {recursive: true, force: true}));
  const packages = {
    '@deepseek-ai/cordis-plugin-group': '1.0.2',
    '@deepseek-ai/dsh': '0.1.5-rc.1',
    '@deepseek-ai/dsh-llm': '0.1.5-rc.2',
    '@deepseek-ai/dsh-llm-pi-ai': '0.1.5-rc.2',
    zod: '4.6.5',
  };
  for (const [name, version] of Object.entries(packages)) {
    const dir = resolve(runtime, 'node_modules', ...name.split('/'));
    await mkdir(dir, {recursive: true});
    await writeFile(resolve(dir, 'package.json'), JSON.stringify({name, version}));
  }
  await mkdir(resolve(runtime, 'node_modules/@deepseek-ai/dsh/lib'), {recursive: true});
  await writeFile(resolve(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '');
  const result = await inspectRuntime(runtime);
  assert.deepEqual(result.versions, packages);
  assert.equal(result.launcher, resolve(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'));
});
