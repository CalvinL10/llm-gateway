import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { toolEvent, commandResult, finalAssistantText, publicTask } from './report.js';

import { z } from 'zod';

import { LlmError } from '@deepseek-ai/dsh-llm';

import { TaskLedger, PolicyError, taskOwner } from './ledger.js';

import { toolsFor, assertExecutionSafety } from './tools.js';



export const name = 'llm-gateway-agent-tasks';

export const inject = ['sessionController', 'sessions', 'agents', 'agentPresets', 'tools',

  'sessionProjections', 'storageDomain', 'connection', 'webServer', 'llm'];



const route = z.object({provider: z.string().min(1).max(200), model: z.string().min(1).max(200)}).strict();

const selection = route.extend({reasoningEffort:z.string().min(1).max(100).optional()});

const policySchema = z.object({root: selection, allowedRoutes: z.array(selection).min(1),

  allowedChildRoutes: z.array(selection).optional(), toolSet: z.enum(['delegation','development']).default('delegation'), maxCalls: z.number().int().min(1).max(100)}).strict();

const inputSchema = z.object({requestId: z.uuid(), goal: z.string().min(1).max(24000).refine(s => !!s.trim())}).strict();

const facts = {sessionId: z.string(), parentSessionId: z.string().nullable(), provider: z.string(), model: z.string(),

  reasoningEffort:z.string().nullable().optional(), purpose: z.string().nullable()};

const record = z.object({id: z.uuid(), sessionId: z.string(), goal: z.string(), policy: policySchema,

  status: z.enum(['running','cancel-requested','completed','failed','limited','stopped','unknown']),

  createdAt: z.string(), endedAt: z.string().nullable(), artifact: z.string().nullable(), failureCode:z.string().nullable().optional(),

  failureStage: z.enum(['create','resolve-agent','check-safety','check-tools','rename','select-model','prompt','wait-idle','finalize']).nullable().optional(),
  toolOperations: z.array(z.object({sessionId: z.string(), seq: z.number().int(), name: z.string(),
    outcome: z.enum(['pending','succeeded','failed','unknown']), resultSeq: z.number().int().optional(),
    errorCode: z.string().optional(), exitCode: z.number().int().nullable().optional()})).optional(),

  calls: z.array(z.object({...facts, id: z.uuid(), admittedAt: z.string(), endedAt: z.string().nullable(),

    outcome: z.string(), usage: z.record(z.string(), z.unknown()).nullable()})),

  denials: z.array(z.object({...facts, code: z.string(), at: z.string()}))});



export async function apply(ctx, config) {

  const {cwd, policy} = z.object({cwd: z.string().min(1), policy: policySchema}).strict().parse(config);

  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Agent gateway requires loopback deployment');

  if (!policy.allowedRoutes.some(r => r.provider === policy.root.provider && r.model === policy.root.model))

    throw new Error('Root route must be explicitly authorized');

  const domain = await ctx.storageDomain.open({name:'gateway_agent_tasks', version:1, tables:{tasks:{valueSchema:record}}});

  const ledger = new TaskLedger(domain.table('tasks'));

  await ledger.recover();

  const roots = new Map(ledger.list().map(t => [t.sessionId, t.id]));

  const live = new Map(), jobs = new Set();

  let closing = false;
  const evidenceFailures = new Set();
  const saveTool = (id, operation) => {
    // Session/tool observers are synchronous notifications. Queue durable writes
    // in the existing ledger and drain before finalization; never throw raw errors.
    ledger.recordTool(id, operation).catch(() => evidenceFailures.add(id));
  };
  ctx.on('session/event', (session, event) => {
    if (!['tool/call', 'tool/result'].includes(event.type)) return;
    const id = taskOwner(session.id, sid => ctx.sessions.get(sid)?.header, roots);
    if (!id) return;
    const operation = toolEvent(session.id, event, session.snapshotEvents());
    if (operation) saveTool(id, operation);
  });
  ctx.on('tools/result', (exec, result) => {
    if (exec.name !== 'pwsh' || result.isError || !exec.agent || exec.parent) return;
    const session = exec.agent.session;
    const id = taskOwner(session.id, sid => ctx.sessions.get(sid)?.header, roots);
    if (!id) return;
    const call = session.snapshotEvents().findLast(e => e.type === 'tool/call' && e.data.callId === exec.callId && e.data.name === 'pwsh');
    if (call) saveTool(id, {sessionId: session.id, seq: call.seq, name: 'pwsh', ...commandResult(result.value)});
  });
  const panel = await readFile(new URL('./panel.js', import.meta.url), 'utf8');
  ctx.on('webserver/index-inject', rows => rows.push({kind: 'script', placement: 'body', text: panel}));



  // Dedicated profile only. Unowned/auxiliary calls are not silently exempted.

  ctx.on('llm/stream', async function* (options, next) {

    const id = taskOwner(options.sessionId, sid => ctx.sessions.get(sid)?.header, roots);

    if (!id) throw new LlmError('No authorized gateway task owns this request', 'TASK_NOT_AUTHORIZED');

    const agent = ctx.agents.get(options.sessionId);

    if (!agent) throw new LlmError('Request has no live owning Agent', 'TASK_NOT_AUTHORIZED');

    assertExecutionSafety(ctx, agent, ledger.get(id)?.policy);

    if ((options.tools ?? []).some(t => !toolsFor(ledger.get(id)?.policy?.toolSet, agent.session.header?.origin).includes(t.name)))

      throw new LlmError('Unexpected tool schema at dispatch', 'TOOLS_NOT_AUTHORIZED');

    options.signal.throwIfAborted();

    let admission;

    try {

      admission = await ledger.admit(id, {sessionId: options.sessionId, parentSessionId: agent.session.header.parentSession ?? null,

        provider: options.provider, model: options.model, reasoningEffort:options.reasoningEffort ?? null, purpose: options.purpose ?? null});

    } catch (error) {

      throw new LlmError('Task admission refused; inspect the task ledger', error instanceof PolicyError ? error.code : 'ADMISSION_STORAGE_FAILED');

    }

    let outcome = 'unknown', usage = null;

    try {

      options.signal.throwIfAborted();

      for await (const chunk of next()) {

        if (chunk.type === 'usage') usage = structuredClone(chunk.usage);

        if (chunk.type === 'finish') outcome = chunk.reason.kind;

        yield chunk;

      }

    } catch (error) { outcome = options.signal.aborted ? 'aborted' : 'error'; throw error; }

    finally { await ledger.finishCall(id, admission.id, outcome, usage); }

  });



  async function execute(task) {

    let agent, prompted = false, stage = 'create';

    const controller = new AbortController();

    const running = {controller, agent:null};

    live.set(task.id, running);

    try {

      const created = await ctx.sessionController.create({sessionId: task.sessionId, cwd, agentPreset:'gateway-agent'});

      if (created.sessionId !== task.sessionId || created.agentPreset !== 'gateway-agent') throw new PolicyError('PRESET_UNAVAILABLE');

      stage = 'resolve-agent';

      const resolved = await ctx.sessionController.resolveAgent(task.sessionId);

      if (resolved.error) throw resolved.error;

      agent = resolved.agent; running.agent = agent;

      stage = 'check-safety';

      assertExecutionSafety(ctx, agent, task.policy);

      stage = 'check-tools';

      const schemas = (ctx.agentPresets.serviceFor(agent,'tools') ?? ctx.tools).schemas(agent);

      if (!toolsFor(task.policy.toolSet, agent.session.header?.origin).every(name => schemas.some(t => t.name === name))) throw new PolicyError('REQUIRED_TOOLS_UNAVAILABLE');

      stage = 'rename';

      await ctx.sessionController.rename({sessionId:task.sessionId, title:'目标任务 · 按需委派'});

      stage = 'select-model';

      const selected = (await ctx.sessionController.selectModel({sessionId:task.sessionId, ...task.policy.root})).selected;

      if (selected.provider !== task.policy.root.provider || selected.model !== task.policy.root.model) throw new Error('Selection changed');

      if (task.policy.root.reasoningEffort && selected.reasoningEffort !== task.policy.root.reasoningEffort) throw new Error('Reasoning selection changed');

      if (closing || ledger.get(task.id).status !== 'running') { await ledger.finish(task.id,'stopped',null); return; }

      stage = 'prompt';

      prompted = true;

      await ctx.sessionController.prompt({requestId:randomUUID(), sessionId:task.sessionId, mode:'queue',

        content:[{type:'text',text:task.goal}]}, controller.signal);

      if (closing || ledger.get(task.id).status !== 'running') agent.cancel({kind:'user'}, {keepInbox:false});

      // Only native foreground spawn is exposed: the root waits for child results/disposal.

      stage = 'wait-idle';

      await agent.whenIdle();

      stage = 'finalize';

      const events = agent.session.snapshotEvents(), reason = events.findLast(e => e.type === 'turn/end')?.data.reason?.kind;

      await ledger.tail;
      if (evidenceFailures.has(task.id)) {
        await ledger.finish(task.id, 'unknown', null, 'EVIDENCE_STORAGE_FAILED', 'finalize');
      } else await ledger.finish(task.id, reason === 'completed' ? 'completed' : reason === 'aborted' ? 'stopped' : reason ? 'failed' : 'unknown', finalAssistantText(events));

    } catch (error) {

      if (agent) { agent.cancel({kind:'user'}, {keepInbox:false}); await agent.whenIdle(); }

      // Persist only a locally assigned stage, never an exception message/stack or remote payload.
      await ledger.finish(task.id, prompted ? 'unknown' : 'failed', null,

        error instanceof PolicyError ? error.code : prompted ? 'EXECUTION_UNCONFIRMED' : 'PREPARATION_FAILED', stage);

    } finally { live.delete(task.id); }

  }

  async function cancel(id) {

    await ledger.cancel(id);

    const running = live.get(id);

    running?.controller.abort();

    running?.agent?.cancel({kind:'user'}, {keepInbox:false});

  }

  ctx.on('dispose', async () => {

    closing = true;

    for (const task of ledger.list()) if (task.status === 'running') await cancel(task.id);

    await Promise.allSettled(jobs); await domain.close();

  });

  ctx.connection.fetch.register({path:'/api/gateway-agent-tasks', methods:['GET','POST'], requestBody:'buffered', async fetch(request) {

    try {

      const query = new URL(request.url).searchParams, id = query.get('id');

      let result;

      if (request.method === 'GET') {

        result = id ? publicTask(ledger.get(id)) : {policy, tasks:ledger.list().map(publicTask)};

        if (result === null) throw new PolicyError('TASK_NOT_FOUND');

      } else {

        if (closing) throw new PolicyError('GATEWAY_CLOSING');

        if (!request.headers.get('content-type')?.startsWith('application/json')) throw new PolicyError('JSON_REQUIRED');

        const text = await request.text();

        if (text.length > 160000) throw new PolicyError('INPUT_TOO_LARGE');

        let value;

        try { value = JSON.parse(text); } catch { throw new PolicyError('INVALID_JSON'); }

        if (query.get('action') === 'cancel' && id) {

          z.object({}).strict().parse(value); await cancel(id); result = publicTask(ledger.get(id));

        } else {

          if (id || query.has('action')) throw new PolicyError('UNSUPPORTED_ACTION');

          const input = inputSchema.parse(value); input.requestId = input.requestId.toLowerCase();

          const created = await ledger.create(input, policy); result = publicTask(created.task);

          if (created.created) {

            roots.set(result.sessionId, result.id);

            const job = execute(result); jobs.add(job);

            job.finally(() => jobs.delete(job)).catch(() => {});

          }

        }

      }

      return Response.json(result, {headers:{'Cache-Control':'no-store'}});

    } catch (error) {
      const invalidInput = error instanceof z.ZodError || error?.name === 'ZodError';
      return Response.json({error:error instanceof PolicyError ? error.code : invalidInput ? 'INVALID_INPUT' : 'GATEWAY_ERROR'},
        {status:error instanceof PolicyError || invalidInput ? 400 : 500, headers:{'Cache-Control':'no-store'}});
    }

  }});

}
