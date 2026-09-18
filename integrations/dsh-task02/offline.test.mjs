import assert from 'node:assert/strict';
import test from 'node:test';
import { apply as textOnly } from '../dsh-text-only/index.js';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('../../', import.meta.url));
const runtime = resolve(root, '.local/dsh-task02');
const requireRuntime = createRequire(resolve(runtime, 'package.json'));
const load = async name => import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/' + name)));
const { Context } = await load('cordis');
const { LlmAdapter } = await load('dsh-llm');
const tick = () => new Promise(resolve => setImmediate(resolve));

// Ordinary offline tests, not a production profile or a new acceptance gate.
// No subscription adapter, credential store, web server, or persistence is loaded.
async function kernel(adapter, titleConfig, modelTitleEnabled = titleLlm.disabled !== true) {
  const ctx = new Context();
  for (const [name, config] of [
    ['dsh-session', {}], ['dsh-session-projection', {}], ['dsh-llm', {}],
    ['dsh-system-prompt', {includeHarnessIdentity:false, includeRuntimeContext:false}],
    ['dsh-tools', {}], ['dsh-agent', {}],
    ['dsh-session-title', titleConfig], ['dsh-agent-loop', {agents:[]}],
  ]) await ctx.plugin((await load(name)).default, config);
  ctx.llm.registerAdapter(['task02-local-stub'], adapter);
  if (modelTitleEnabled) await ctx.plugin((await load('dsh-session-title-first-prompt-llm')), titleLlm.config);
  const handle = await ctx.agents.create({
    sessionId:'task02-offline',
    agentOptions:{provider:'task02-local-stub', model:'local-only'},
    setup(agentCtx) { textOnly(agentCtx); },
  });
  return {ctx, handle};
}
function composed() {
  const text = execFileSync(process.execPath, [resolve(runtime,'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web', '--dump-config'], {
    cwd:resolve(root,'.local/dsh-task02-workspace'),
    env:{...process.env, DSH_HOME:resolve(root,'.local/dsh-task02-home'), DSH_PERMISSION_MODE:'read-only'},
    encoding:'utf8',
  });
  return requireRuntime('yaml').parse(text, {customTags:[{tag:'tag:yaml.org,2002:js', resolve: value => value}]});
}
const rows = composed();
const title = rows.find(row => row.id === 'session-title');
const titleLlm = rows.find(row => row.id === 'session-title-llm');

test('effective web profile disables model titles and retains local service', () => {
  assert.equal(titleLlm.disabled, true);
  assert.notEqual(title.disabled, true);
  assert.equal(title.name, '@deepseek-ai/dsh-session-title');
  assert.equal(readFileSync(resolve(root,'integrations/dsh-task02/web.cordis.patch.yml'),'utf8'),
    readFileSync(resolve(root,'.local/dsh-task02-home/profiles/web/cordis.patch.yml'),'utf8'));
  const activeTitles = rows.filter(row => /session-title.*llm/.test(row.name ?? '') && row.disabled !== true);
  assert.deepEqual(activeTitles, []);
});

class LocalAdapter extends LlmAdapter {
  calls = [];
  async *stream(options) {
    this.calls.push(options);
    yield {type:'block-start', index:0, blockType:'text'};
    yield {type:'text-delta', index:0, text:'Local stub response'};
    yield {type:'block-end', index:0, block:{type:'text',text:'Local stub response'}};
    yield {type:'finish', reason:{kind:'stop'}};
  }
}
test('real title service: first prompt, later prompt, refresh, rename, reread have no auxiliary call', {timeout:10000}, async () => {
  const adapter = new LocalAdapter();
  const {ctx, handle} = await kernel(adapter, title.config);
  try {
    const agent = handle.agent;
    agent.followup({content:[{type:'text',text:'TASK02 local deterministic title example extra'}],source:{kind:'user'}});
    await agent.whenIdle(); await tick();
    assert.equal(adapter.calls.length, 1);
    assert.equal(ctx.sessionTitle.get(agent.session).source.kind, 'fallback');
    assert.equal(ctx.sessionTitle.get(agent.session).title, 'TASK02 local deterministic title example');
    agent.followup({content:[{type:'text',text:'second local prompt'}],source:{kind:'user'}});
    await agent.whenIdle(); await tick();
    await ctx.sessionTitle.refresh(agent.session);
    ctx.sessionTitle.rename(agent.session, 'Manual local title');
    assert.equal(ctx.sessionTitle.get(agent.session).title, 'Manual local title');
    await ctx.sessionTitle.refresh(agent.session); await tick();
    assert.equal(ctx.sessionTitle.get(agent.session).source.kind, 'fallback');
    assert.equal(adapter.calls.length, 2);
    assert.equal(adapter.calls.filter(call => call.purpose === 'session-title').length, 0);
    assert.ok(adapter.calls.every(call => (call.tools ?? []).length === 0));
    assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'session/title-llm-request').length, 0);
    console.log('title evidence:', JSON.stringify({mainStubCalls:2, auxiliaryCalls:0, title:ctx.sessionTitle.get(agent.session).title}));
  } finally { await handle.dispose(); await ctx.fiber.dispose(); }
});

for (const {cooperative, keepInbox} of [{cooperative:true, keepInbox:false}, {cooperative:false, keepInbox:false}, {cooperative:false, keepInbox:true}]) {
  test(`DSH cancellation: ${cooperative ? 'cooperative' : 'delayed non-cooperative'} local stream, keepInbox=${keepInbox}`, {timeout:10000}, async () => {
    const entered = Promise.withResolvers();
    const released = Promise.withResolvers();
    let signal;
    let cleaned = false;
    class WaitingAdapter extends LlmAdapter {
      calls = 0;
      async *stream(options) {
        this.calls++;
        signal = options.signal;
        try {
          yield {type:'block-start', index:0, blockType:'text'};
          yield {type:'text-delta', index:0, text:'local partial text'};
          // The loop has consumed the prefix before this gate opens.
          entered.resolve();
          if (cooperative) {
            await new Promise(resolve => {
              if (signal.aborted) resolve();
              else signal.addEventListener('abort', resolve, {once:true});
            });
          } else await released.promise;
          signal.throwIfAborted();
        } finally { cleaned = true; }
      }
    }
    const adapter = new WaitingAdapter();
    const {ctx, handle} = await kernel(adapter, title.config);
    try {
      const agent = handle.agent;
      agent.followup({content:[{type:'text',text:'offline cancellation'}],source:{kind:'user'}});
      await entered.promise;
      agent.followup({content:[{type:'text',text:'queued must not run'}],source:{kind:'user'}});
      agent.cancel({kind:'user'}, {keepInbox});
      assert.equal(signal.aborted, true);
      let idle = false;
      const quiescent = agent.whenIdle().then(() => { idle = true; });
      if (!cooperative) {
        await tick();
        assert.equal(cleaned, false);
        assert.equal(idle, false);
        assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'turn/end').length, 0);
        released.resolve();
      }
      await quiescent; await tick();
      assert.equal(cleaned, true);
      assert.equal(idle, true);
      assert.equal(adapter.calls, 1);
      assert.equal(agent.inbox.nextTurn.length, keepInbox ? 1 : 0);
      const events = agent.session.snapshotEvents();
      const end = events.find(e => e.type === 'turn/end');
      assert.equal(end.data.reason.kind, 'aborted');
      const partial = events.find(e => e.type === 'assistant/message');
      assert.equal(partial.data.interrupted, true);
      assert.equal(partial.data.message.content[0].text, 'local partial text');
      assert.equal(events.filter(e => e.type === 'session/title-llm-request').length, 0);
      console.log('cancel evidence:', JSON.stringify({cooperative, keepInbox, pending:agent.inbox.nextTurn.length, calls:adapter.calls, signalAborted:signal.aborted, cleaned, idle, end:end.data.reason.kind, retainedPrefix:true}));
    } finally { released.resolve(); await handle.dispose(); await ctx.fiber.dispose(); }
  });
}

test('positive control: enabled upstream title plugin is detected as a separate local call', {timeout:10000}, async () => {
  const adapter = new LocalAdapter();
  const {ctx, handle} = await kernel(adapter, title.config, true);
  try {
    handle.agent.followup({content:[{type:'text',text:'positive control local only'}],source:{kind:'user'}});
    await handle.agent.whenIdle(); await tick();
    assert.equal(adapter.calls.length, 2);
    assert.equal(adapter.calls.filter(call => call.purpose === 'session-title').length, 1);
    assert.equal(handle.agent.session.snapshotEvents().filter(e => e.type === 'session/title-llm-request').length, 1);
    assert.equal(ctx.sessionTitle.get(handle.agent.session).source.kind, 'provider');
    console.log('positive control:', JSON.stringify({mainStubCalls:1, auxiliaryStubCalls:1, realCalls:0}));
  } finally { await handle.dispose(); await ctx.fiber.dispose(); }
});
