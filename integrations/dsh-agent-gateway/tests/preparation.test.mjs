import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { developmentRootTools } from '../tools.js';
import { publicTask } from '../report.js';
import { createRuntimeFixture } from './fixtures/test-runtime.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {path: run, remove} = await createRuntimeFixture('preparation-test-');
test.after(remove);
for (const file of ['package.json', 'index.js', 'ledger.js','report.js','panel.js', 'tools.js'])
  await copyFile(resolve(source, file), resolve(run, file));
const {apply} = await import(pathToFileURL(resolve(run, 'index.js')));
const route = {provider: 'fixture-development', model: 'scripted'};
// Synthetic sensitive text must never appear in the public record or storage.
const privateError = 'token=TEST_ONLY_PRIVATE_VALUE; cookie=TEST_ONLY_COOKIE; private file content';

for (const failure of ['create', 'resolve-agent', 'check-safety', 'check-tools', 'rename', 'select-model', 'prompt', 'wait-idle', 'evidence', null]) {
  test('execution stage is safe and durable: ' + (failure ?? 'success'), {timeout: 5000}, async () => {
    const records = new Map(); let schema, handler, dispose, finish, observeEvent;
    let schemaReads = 0, idleCalls = 0, promptCalls = 0;
    const terminal = new Promise(r => {finish = r;});
    const fault = stage => {if (failure === stage) throw new Error(privateError);};
    const sessionEvents = [
      {seq: 1, type: 'assistant/message', data: {turn: 1, message: {content: [{type: 'text', text: 'before prompt'}]}}},
      {seq: 2, type: 'turn/end', data: {turn: 1, reason: {kind: 'completed'}}}
    ];
    const agent = {session: {header: {}, snapshotEvents: () => sessionEvents}, cancel() {},
      async whenIdle() {if (++idleCalls === 1) fault('wait-idle');}};
    const ctx = {
      webServer: {host: '127.0.0.1'},
      storageDomain: {async open(config) {
        schema = config.tables.tasks.valueSchema;
        return {close: async () => {}, table: () => ({
          get: id => records.get(id), entries: () => records.entries(),
          async put(id, value) {
            if (failure === 'evidence' && value.toolOperations?.length) throw new Error(privateError);
            const record = schema.parse(value); records.set(id, record);
            if (!['queued', 'running', 'cancel-requested'].includes(record.status)) finish(record);
          }
        })};
      }},
      on(event, listener) {
        if (event === 'dispose') dispose = listener;
        if (event === 'session/event') observeEvent = listener;
      },
      sessions: {get() {return agent.session;}},
      connection: {fetch: {register(spec) {handler = spec.fetch;}}},
      agentPresets: {serviceFor: () => ({schemas() {
        if (++schemaReads === 2) fault('check-tools');
        return developmentRootTools.map(name => ({name}));
      }})},
      sessionProjections: {stateOf() {fault('check-safety'); return {sandbox: 'workspace-write', approval: 'ask'};}},
      sessionController: {
        async create(request) {fault('create'); return request;},
        async resolveAgent() {return failure === 'resolve-agent' ? {error: new Error(privateError)} : {agent};},
        async rename() {fault('rename');},
        async selectModel() {fault('select-model'); return {selected: route};},
        async prompt(request) {
          promptCalls++; fault('prompt');
          sessionEvents.push(
            {seq: 3, type: 'assistant/message', data: {turn: 2, message: {content: [{type: 'text', text: 'OK'}]}}},
            {seq: 4, type: 'turn/end', data: {turn: 2, reason: {kind: 'completed'}}});
          if (failure === 'evidence') observeEvent({...agent.session, id: request.sessionId},
            {seq: 5, type: 'tool/call', data: {name: 'edit'}});
        }
      }
    };
    await apply(ctx, {cwd: run, policy: {root: route, allowedRoutes: [route], toolSet: 'development', maxCalls: 8}});
    try {
      const id = randomUUID();
      const response = await handler(new Request('http://127.0.0.1/api/gateway-agent-tasks', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({requestId: id, goal: 'fixture'})
      }));
      assert.equal(response.status, 200);
      const result = await terminal;
      assert.equal(result.failureStage, failure === 'evidence' ? 'finalize' : failure);
      const uncertain = ['prompt', 'wait-idle', 'evidence'].includes(failure);
      assert.equal(result.status, failure === null ? 'completed' : uncertain ? 'unknown' : 'failed');
      assert.equal(result.failureCode, failure === null ? null : failure === 'evidence' ? 'EVIDENCE_STORAGE_FAILED'
        : uncertain ? 'EXECUTION_UNCONFIRMED' : 'PREPARATION_FAILED');
      assert.equal(promptCalls, failure === null || uncertain ? 1 : 0);
      assert.deepEqual(result.calls, []); assert.deepEqual(result.denials, []);
      const publicRecord = await handler(new Request('http://127.0.0.1/api/gateway-agent-tasks?id=' + id));
      assert.deepEqual(await publicRecord.json(), publicTask(result));
      const auditResponse = await handler(new Request(
        'http://127.0.0.1/api/gateway-agent-tasks?id=' + id + '&view=audit'));
      assert.equal(auditResponse.status, 200);
      const audit = await auditResponse.json();
      assert.equal(audit.format, 'gateway-agent-audit-v1');
      assert.equal(audit.tasks[0].id, id);
      assert.deepEqual(audit.tasks[0].calls, []);
      assert.equal(audit.tasks[0].goal, undefined);
      assert.ok(!JSON.stringify([...records.values()]).includes('TEST_ONLY_'));
    } finally {await dispose();}
  });
}
