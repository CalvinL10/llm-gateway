import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {copyFile, mkdir, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {allowedTools} from '../../tools.js';
import {createRuntimeFixture} from '../fixtures/test-runtime.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const route = {provider: 'fixture', model: 'planner'};
const policy = {root: route, allowedRoutes: [route], maxCalls: 2};

function createContext() {
  const records = new Map();
  let handler, dispose, releaseIdle;
  const idle = new Promise(resolvePromise => { releaseIdle = resolvePromise; });
  const session = {header: {}, snapshotEvents: () => [
    {type: 'turn/end', data: {reason: {kind: 'aborted'}}},
  ]};
  const agent = {session, cancel() { releaseIdle(); }, async whenIdle() { await idle; }};
  const ctx = {
    webServer: {host: '127.0.0.1'},
    storageDomain: {async open({tables}) {
      const schema = tables.tasks.valueSchema;
      return {close: async () => {}, table: () => ({
        get: id => records.get(id), entries: () => records.entries(),
        async put(id, value) { records.set(id, schema.parse(structuredClone(value))); },
      })};
    }},
    on(event, listener) { if (event === 'dispose') dispose = listener; },
    sessions: {get: () => session},
    connection: {fetch: {register(spec) { handler = spec.fetch; }}},
    tools: {},
    agentPresets: {serviceFor: () => ({schemas: () => allowedTools.map(name => ({name}))})},
    sessionProjections: {stateOf: () => ({sandbox: 'read-only', approval: 'ask'})},
    sessionController: {
      async create(request) { return request; },
      async resolveAgent() { return {agent}; },
      async rename() {},
      async selectModel() { return {selected: route}; },
      async prompt() {},
    },
  };
  return {ctx, get handler() { return handler; }, get dispose() { return dispose; }, releaseIdle};
}

function post(handler, url, body) {
  return handler(new Request(url, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
  }));
}

test('lifecycle drain rejects only new task creation while reads and cancellation remain available', async t => {
  const {path: base, remove} = await createRuntimeFixture('drain-test-');
  t.after(remove);
  for (const file of ['package.json', 'index.js', 'ledger.js', 'report.js', 'panel.js', 'tools.js'])
    await copyFile(resolve(source, file), resolve(base, file));
  const {apply} = await import(pathToFileURL(resolve(base, 'index.js')).href);
  const drain = resolve(base, '.gateway-lifecycle/drain');
  await mkdir(resolve(drain, '..'), {recursive: true});
  const setup = createContext();
  await apply(setup.ctx, {cwd: base, lifecycleDrainPath: drain, policy});
  const endpoint = 'http://127.0.0.1/api/gateway-agent-tasks';
  const id = randomUUID();
  try {
    const created = await post(setup.handler, endpoint, {requestId: id, goal: 'keep running until cancelled'});
    assert.equal(created.status, 200);
    await writeFile(drain, '{"reason":"test"}\n');

    const rejected = await post(setup.handler, endpoint, {requestId: randomUUID(), goal: 'must not start'});
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), {error: 'GATEWAY_DRAINING'});

    const read = await setup.handler(new Request(`${endpoint}?id=${id}`));
    assert.equal(read.status, 200);
    assert.equal((await read.json()).id, id);

    const cancelled = await post(setup.handler, `${endpoint}?action=cancel&id=${id}`, {});
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).status, 'cancel-requested');
  } finally {
    setup.releaseIdle();
    await setup.dispose();
  }
});
