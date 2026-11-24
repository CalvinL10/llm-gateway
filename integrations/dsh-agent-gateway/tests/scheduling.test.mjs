import assert from 'node:assert/strict';
import test from 'node:test';
import {copyFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRuntimeFixture} from './fixtures/test-runtime.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {path: moduleRoot, remove} = await createRuntimeFixture('scheduling-test-');
test.after(remove);
for (const file of ['package.json','index.js','ledger.js','report.js','tools.js'])
  await copyFile(resolve(source, file), resolve(moduleRoot, file));
const {resolveScheduling} = await import(pathToFileURL(resolve(moduleRoot, 'index.js')));

const root = {provider:'codex-chatgpt', model:'gpt-5.6-sol', reasoningEffort:'medium'};
const child = {provider:'antigravity', model:'gemini-3.8-flash', reasoningEffort:'high'};
const base = {root, allowedRoutes:[root], allowedChildRoutes:[], toolSet:'development', delegationEnabled:false, maxCalls:8};
const catalog = {roots:[root], children:[child], singlePreset:'gateway-agent', delegationPreset:'gateway-agent-delegation'};

test('resolves a durable single-model task selection inside the server catalog', () => {
  const policy = resolveScheduling({root, mode:'single', children:[]}, catalog, base, 12);
  assert.equal(policy.agentPreset, 'gateway-agent');
  assert.equal(policy.delegationEnabled, false);
  assert.equal(policy.maxCalls, 12);
  assert.deepEqual(policy.scheduling.children, []);
});

test('resolves an autonomous delegation selection and preserves the child allowlist', () => {
  const policy = resolveScheduling({root, mode:'delegate', children:[child]}, catalog, base, 8);
  assert.equal(policy.agentPreset, 'gateway-agent-delegation');
  assert.equal(policy.delegationEnabled, true);
  assert.deepEqual(policy.allowedChildRoutes, [child]);
});

test('rejects a child route that is not server-authorized', () => {
  assert.throws(() => resolveScheduling({root, mode:'delegate', children:[{provider:'unknown',model:'x'}]}, catalog, base, 8),
    error => error?.code === 'MODEL_NOT_AUTHORIZED');
});

test('rejects delegation without an explicit child selection', () => {
  assert.throws(() => resolveScheduling({root, mode:'delegate', children:[]}, catalog, base, 8),
    error => error?.code === 'INVALID_SCHEDULING');
});
