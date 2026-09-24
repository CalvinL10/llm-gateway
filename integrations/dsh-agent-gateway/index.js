import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import { toolEvent, approvalEvent, commandResult, finalAssistantText, publicTask, auditExport } from './report.js';

import { z } from 'zod';

import { LlmError } from '@deepseek-ai/dsh-llm';

import { TaskLedger, PolicyError, TaskStorageError, taskOwner, isOrdinaryHostSession } from './ledger.js';

import { toolsFor, modelVisibleToolsFor, assertExecutionSafety, reconciliationTools, enterReconciliation, commandExecutionCapability } from './tools.js';



const execFileAsync = promisify(execFile);

export const name = 'llm-gateway-agent-tasks';

export const inject = ['sessionController', 'sessions', 'agents', 'agentPresets', 'tools',

  'sessionProjections', 'storageDomain', 'workspaceRegistry', 'connection', 'webServer', 'llm', 'shell'];




const route = z.object({provider: z.string().min(1).max(200), model: z.string().min(1).max(200)}).strict();

const selection = route.extend({reasoningEffort:z.string().min(1).max(100).optional()});

const callLimit = z.number().int().min(1).max(100);
const continuationIncrement = z.number().int().min(0).max(100);
const continuationKind = z.enum(['continue','supplement','reconcile']);
const schedulingSchema = z.object({root:selection, mode:z.enum(['single','delegate']),
  children:z.array(selection).max(32)}).strict();
const schedulingConfigSchema = z.object({roots:z.array(selection).min(1).max(32),
  children:z.array(selection).max(32), singlePreset:z.string().min(1),
  delegationPreset:z.string().min(1)}).strict();
const defaultsSchema = z.object({scheduling:schedulingSchema, maxCalls:callLimit}).strict();
const selectionKey = value => JSON.stringify([value.provider,value.model,value.reasoningEffort ?? null]);

export function resolveScheduling(value, catalog, base, maxCalls) {
  const input = schedulingSchema.parse(value);
  const root = catalog.roots.find(item => selectionKey(item) === selectionKey(input.root));
  if (!root) throw new PolicyError('MODEL_NOT_AUTHORIZED');
  if (input.mode === 'single' && input.children.length || input.mode === 'delegate' && !input.children.length)
    throw new PolicyError('INVALID_SCHEDULING');
  const children = input.children.map(child => {
    const found = catalog.children.find(item => selectionKey(item) === selectionKey(child));
    if (!found) throw new PolicyError('MODEL_NOT_AUTHORIZED');
    return found;
  }).sort((a,b) => selectionKey(a).localeCompare(selectionKey(b)));
  if (new Set(children.map(selectionKey)).size !== children.length) throw new PolicyError('INVALID_SCHEDULING');
  return {...base, root, allowedRoutes:[root,...children.filter(item => selectionKey(item) !== selectionKey(root))],
    allowedChildRoutes:children, delegationEnabled:input.mode === 'delegate', maxCalls,
    agentPreset:input.mode === 'single' ? catalog.singlePreset : catalog.delegationPreset,
    scheduling:{root,mode:input.mode,children}};
}

const policySchema = z.object({root: selection, allowedRoutes: z.array(selection).min(1),

  allowedChildRoutes: z.array(selection).optional(), toolSet: z.enum(['delegation','development']).default('delegation'),
  delegationEnabled: z.boolean().optional(), agentPreset:z.string().optional(), scheduling:schedulingSchema.optional(), maxCalls: callLimit}).strict().refine(
    value => value.delegationEnabled !== false || value.toolSet === 'development',
    'Disabling delegation requires development mode');

const workspaceId = z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

const inputSchema = z.object({requestId: z.uuid(), goal: z.string().min(1).max(24000).refine(s => !!s.trim()),
  workspaceId: workspaceId.optional(), maxCalls: callLimit.optional(), scheduling:schedulingSchema.optional()}).strict();
const continuationSchema = z.object({continuationId: z.uuid(), kind: continuationKind,
  instruction: z.string().min(1).max(24000).refine(s => !!s.trim()),
  additionalCalls: continuationIncrement.default(0)}).strict();

const facts = {sessionId: z.string(), parentSessionId: z.string().nullable(), provider: z.string(), model: z.string(),

  reasoningEffort:z.string().nullable().optional(), purpose: z.string().nullable()};

const attemptStatus = z.enum(['queued','running','cancel-requested','completed','reconciled','failed','limited','stopped','unknown']);
const attemptRecord = z.object({id:z.uuid(), kind:z.enum(['initial','continue','supplement','reconcile']),
  instruction:z.string(), additionalCalls:continuationIncrement, budgetBefore:callLimit, budgetAfter:callLimit,
  callStart:z.number().int().min(0), callEnd:z.number().int().min(0).nullable(), status:attemptStatus,
  queuedAt:z.string().optional(), startedAt:z.string().nullable(), endedAt:z.string().nullable(), artifact:z.string().nullable(),
  failureCode:z.string().nullable(), failureStage:z.string().nullable(),
  reconciliationEvidence:z.record(z.string(),z.unknown()).optional()});
const record = z.object({id: z.uuid(), sessionId: z.string(), goal: z.string(), policy: policySchema,
  workspaceId: workspaceId.optional(),
  status: attemptStatus,
  createdAt: z.string(), endedAt: z.string().nullable(), artifact: z.string().nullable(), failureCode:z.string().nullable().optional(),
  failureStage: z.string().nullable().optional(), attempts:z.array(attemptRecord).optional(),
  toolOperations: z.array(z.object({sessionId: z.string(), seq: z.number().int(), name: z.string(), attemptId:z.uuid().optional(),
    outcome: z.enum(['pending','succeeded','failed','unknown']), resultSeq: z.number().int().optional(),
    turn:z.number().int().optional(), step:z.number().int().optional(), startedAt:z.string().optional(), endedAt:z.string().optional(),
    errorCode: z.string().optional(), exitCode: z.number().int().nullable().optional()})).optional(),
  approvalOperations: z.array(z.object({sessionId: z.string(), seq: z.number().int(), name: z.string(), attemptId:z.uuid().optional(),
    outcome: z.enum(['pending','allowed-once','rejected','cancelled','unavailable']),
    askedAt:z.string().optional(), decidedAt:z.string().optional(), decisionSeq: z.number().int().optional()})).optional(),
  calls: z.array(z.object({...facts, id: z.uuid(), attemptId:z.uuid().optional(), admittedAt: z.string(), endedAt: z.string().nullable(),
    measurementKind:z.literal('llm-stream-admission').optional(),
    source:z.enum(['root','child','auxiliary']).optional(), sessionRole:z.enum(['root','child']).optional(),
    auxiliaryPurpose:z.enum(['compaction','session-title','planning','review','custom']).nullable().optional(),
    adapterBoundaryPreparedAt:z.string().nullable().optional(), dispatchStartedAt:z.string().nullable().optional(),
    firstResponseAt:z.string().nullable().optional(),
    httpAttempts:z.object({observability:z.enum(['bounded','unavailable','observed','unknown']),
      count:z.number().int().min(0).nullable(), basis:z.string()}).optional(),
    outcome: z.string(), usage: z.record(z.string(), z.unknown()).nullable(),
    usageStatus:z.enum(['final','partial','missing','unknown']).optional(),
    usageFirstObservedAt:z.string().nullable().optional(), usageObservedAt:z.string().nullable().optional(),
    usageObservationCount:z.number().int().min(0).optional()})),
  denials: z.array(z.object({...facts, attemptId:z.uuid().optional(), code: z.string(), at: z.string()}))});


export async function apply(ctx, config, {streamBoundary, lifecycleBinding, allowHostSessions = false, commandExecution} = {}) {

  // Trusted in-process integration only; never a task/HTTP/config-supplied flag.
  // This seam does not certify a transport's input/output token enforcement.
  if (streamBoundary !== undefined && typeof streamBoundary !== 'function')
    throw new TypeError('A callable native stream boundary is required');
  if (lifecycleBinding !== undefined && (!lifecycleBinding ||
      typeof lifecycleBinding.connect !== 'function' || typeof lifecycleBinding.onOperatorCancel !== 'function'))
    throw new TypeError('A trusted lifecycle connection and operator cancellation callback are required');

  const parsedConfig = z.object({cwd: z.string().min(1).optional(),
    workspaceLabel: z.string().min(1).max(100).optional(),
    workspaces: z.array(z.object({id: workspaceId, label: z.string().min(1).max(100),
      cwd: z.string().min(1)}).strict()).min(1).max(32).optional(),
    lifecycleDrainPath: z.string().min(1).optional(),
    cancellationTimeoutMs: z.number().int().min(10).max(60000).default(5000),
    maxConcurrentTasks: z.number().int().min(1).max(16).default(2),
    authorizedTaskMaxCalls: z.array(callLimit).min(1).max(16).optional(),
    authorizedContinuationCallIncrements: z.array(z.number().int().min(1).max(100)).max(16).optional(),
    scheduling:schedulingConfigSchema.optional(), policy: policySchema}).strict().superRefine((value, issue) => {
      if (value.scheduling && value.policy.toolSet !== 'development')
        issue.addIssue({code:'custom',message:'Task scheduling requires development tools'});
      if (!!value.cwd === !!value.workspaces) issue.addIssue({code:'custom', message:'Configure cwd or workspaces'});
      if (value.workspaceLabel && !value.cwd) issue.addIssue({code:'custom', message:'workspaceLabel requires cwd'});
      if (value.workspaces && new Set(value.workspaces.map(item => item.id)).size !== value.workspaces.length)
        issue.addIssue({code:'custom', message:'Workspace ids must be unique'});
      if (value.authorizedTaskMaxCalls && !value.authorizedTaskMaxCalls.includes(value.policy.maxCalls))
        issue.addIssue({code:'custom', message:'authorizedTaskMaxCalls must include policy.maxCalls'});
      if (value.authorizedTaskMaxCalls && new Set(value.authorizedTaskMaxCalls).size !== value.authorizedTaskMaxCalls.length)
        issue.addIssue({code:'custom', message:'authorizedTaskMaxCalls must be unique'});
      if (value.authorizedContinuationCallIncrements &&
          new Set(value.authorizedContinuationCallIncrements).size !== value.authorizedContinuationCallIncrements.length)
        issue.addIssue({code:'custom', message:'authorizedContinuationCallIncrements must be unique'});
    }).parse(config);
  const {lifecycleDrainPath, cancellationTimeoutMs, maxConcurrentTasks, policy} = parsedConfig;
  const authorizedTaskMaxCalls = parsedConfig.authorizedTaskMaxCalls ?? [policy.maxCalls];
  const authorizedContinuationCallIncrements = parsedConfig.authorizedContinuationCallIncrements ?? [];
  const workspaces = parsedConfig.workspaces ?? [{id:'default',
    label:parsedConfig.workspaceLabel ?? basename(parsedConfig.cwd), cwd:parsedConfig.cwd}];
  const workspaceById = new Map(workspaces.map(item => [item.id, item]));
  const defaultWorkspace = workspaces[0];
  const nativeWorkspaceById = new Map();
  // Cordis enforces the declared runtime injection; direct unit contexts use the no-op account below.
  for (const workspace of workspaces) nativeWorkspaceById.set(workspace.id,
    ctx.workspaceRegistry ? await ctx.workspaceRegistry.create(workspace.cwd, workspace.label) : {attachSession: async () => {}});

  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Agent gateway requires loopback deployment');

  if (!policy.allowedRoutes.some(r => r.provider === policy.root.provider && r.model === policy.root.model))

    throw new Error('Root route must be explicitly authorized');

  const domain = await ctx.storageDomain.open({name:'gateway_agent_tasks', version:1, tables:{tasks:{valueSchema:record}}});

  const ledger = new TaskLedger(domain.table('tasks'));
  const schedulingCatalog = parsedConfig.scheduling;
  const settingsDomain = schedulingCatalog ? await ctx.storageDomain.open({name:'gateway_task_preferences',version:1,
    tables:{preferences:{valueSchema:defaultsSchema}}}) : null;
  const preferences = settingsDomain?.table('preferences');
  const defaultPreferences = () => preferences?.get('default') ?? {scheduling:{root:policy.root,
    mode:policy.delegationEnabled === false ? 'single' : 'delegate',
    children:policy.delegationEnabled === false ? [] : (policy.allowedChildRoutes ?? [])},maxCalls:policy.maxCalls};
  function validatePreferences(value) {
    if (!schedulingCatalog) throw new PolicyError('SCHEDULING_UNAVAILABLE');
    const input = defaultsSchema.parse(value);
    if (!authorizedTaskMaxCalls.includes(input.maxCalls)) throw new PolicyError('CALL_LIMIT_NOT_AUTHORIZED');
    const selected = resolveScheduling(input.scheduling,schedulingCatalog,policy,input.maxCalls);
    return {scheduling:selected.scheduling,maxCalls:selected.maxCalls};
  }

  await ledger.recover();

  const roots = new Map(ledger.list().map(t => [t.sessionId, t.id]));

  const live = new Map(), jobs = new Set();
  if (allowHostSessions) ctx.on('session/created', session => {
    // DSH publishes Session before Agent. Native delegation installs its tools
    // on agent/created, inside create(), so writing after create() is too late.
    // Only our durable root record authorizes this event; ordinary sessions and
    // child inheritance remain entirely host-owned.
    const task = ledger.get(roots.get(session.id));
    if (!task || task.status !== 'running' || !live.has(task.id)) return;
    // Text/delegation tasks may join a workspace-write host; narrow only this
    // task, never change the host's permission defaults or approval policy.
    if (task.policy.toolSet === 'delegation') session.append('sandbox/mode', {mode:'read-only'});
    if (task.policy.delegationEnabled === false) return;
    const routes = task.policy.allowedChildRoutes ?? task.policy.allowedRoutes;
    if (routes.length && !session.snapshotEvents().some(event => event.type === 'subagent/model-selection-policy'))
      session.append('subagent/model-selection-policy', {allowedModels:routes.map(({provider,model}) => ({provider,model}))});
  });
  const pendingQueue = [], pendingByKey = new Map(), workspaceLeases = new Set();
  let activeExecutions = 0, pumpScheduled = false;
  // Actual execution receipts live only in this process. A recovered ledger row
  // is not proof that an earlier process, prompt, agent or tool has terminated.
  const executionReceipts = new Map();

  let closing = false;
  const evidenceFailures = new Set();
  // Capture the attempt before asynchronous writes; an earlier failure must not
  // poison an explicit, independently persisted read-only reconciliation.
  const evidenceKey = (id, attemptId) => `${id}/${attemptId ?? id}`;
  const stopIntents = new Set();
  const observations = new Map();
  const observePersistenceFailure = (id, error, lifecycle) => {
    const task = error instanceof TaskStorageError ? error.attemptedTask : ledger.get(id);
    if (task) observations.set(id, {task, lifecycle});
  };
  const observedTask = id => observations.get(id)?.task ?? ledger.get(id);
  const visibleTask = id => {
    const observation = observations.get(id);
    return publicTask(observedTask(id), observation?.lifecycle);
  };
  const persistFinal = async (id, status, artifact, failureCode = null, failureStage = null, stopConfirmation = null) => {
    // A locally terminal task must not dispatch again even when its terminal write fails.
    stopIntents.add(id);
    // A successful terminal write supersedes any earlier unconfirmed observation.
    // Clear it before awaiting the host table because test/storage callbacks may observe
    // the committed row before this continuation resumes.
    observations.delete(id);
    try {
      await ledger.finish(id, status, artifact, failureCode, failureStage);
    } catch (error) {
      observePersistenceFailure(id, error, {state: 'ended-local', localOutcome: status,
        persistence: 'unconfirmed', stopConfirmation});
    }
  };
  const saveTool = (id, operation) => {
    // Session/tool observers are synchronous notifications. Queue durable writes
    // in the existing ledger and drain before finalization; never throw raw errors.
    const attemptId = ledger.get(id)?.attempts?.at(-1)?.id;
    ledger.recordTool(id, operation).catch(error => {
      evidenceFailures.add(evidenceKey(id, attemptId));
      observePersistenceFailure(id, error, {state: stopIntents.has(id) ? 'canceling' : 'executing',
        localOutcome: null, persistence: 'unconfirmed', stopConfirmation: null});
    });
  };
  ctx.on('session/event', (session, event) => {
    if (!['tool/call', 'tool/result', 'approval/asked', 'approval/decided'].includes(event.type)) return;
    const id = taskOwner(session.id, sid => ctx.sessions.get(sid)?.header, roots);
    if (!id) return;
    const events = session.snapshotEvents();
    const tool = toolEvent(session.id, event, events);
    if (tool) saveTool(id, tool);
    const approval = approvalEvent(session.id, event, events);
    const attemptId = ledger.get(id)?.attempts?.at(-1)?.id;
    if (approval) ledger.recordApproval(id, approval).catch(error => {
      evidenceFailures.add(evidenceKey(id, attemptId));
      observePersistenceFailure(id, error, {state: stopIntents.has(id) ? 'canceling' : 'executing',
        localOutcome: null, persistence: 'unconfirmed', stopConfirmation: null});
    });
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



  const gatewayPresets = new Set(['gateway-agent', 'gateway-agent-delegation',
    'llm-gateway-text', 'llm-gateway-single', 'llm-gateway-delegate',
    'llm-gateway-single-docker', 'llm-gateway-delegate-docker',
    policy.agentPreset, parsedConfig.scheduling?.singlePreset, parsedConfig.scheduling?.delegationPreset].filter(Boolean));
  // Only ./plugin opts into coexistence; the original entry stays strict.
  // Missing ledger rows are not proof of an ordinary session.
  ctx.on('llm/stream', async function* (options, next) {
    const id = taskOwner(options.sessionId, sid => ctx.sessions.get(sid)?.header, roots);
    if (!id && allowHostSessions && isOrdinaryHostSession(options.sessionId,
      sid => ctx.sessions.get(sid), gatewayPresets)) {
      yield* next();
      return;
    }
    if (!id) throw new LlmError('No authorized gateway task owns this request', 'TASK_NOT_AUTHORIZED');
    if (stopIntents.has(id)) throw new LlmError('Task is no longer accepting dispatch', 'TASK_NOT_RUNNING');

    const agent = ctx.agents.get(options.sessionId);
    if (!agent) throw new LlmError('Request has no live owning Agent', 'TASK_NOT_AUTHORIZED');
    const owningTask = ledger.get(id);
    const activeAttempt = owningTask?.attempts?.findLast(value => ['running','cancel-requested'].includes(value.status));
    const reconcile = activeAttempt?.kind === 'reconcile';
    assertExecutionSafety(ctx, agent, owningTask?.policy, {reconcile});
    if ((options.tools ?? []).some(t => !modelVisibleToolsFor(owningTask?.policy?.toolSet,
      agent.session.header?.origin, reconcile, owningTask?.policy?.delegationEnabled).includes(t.name)))
      throw new LlmError('Unexpected tool schema at dispatch', 'TOOLS_NOT_AUTHORIZED');
    options.signal.throwIfAborted();

    let admission, outcome = 'unknown', usage = null, firstResponseAt = null, usageObservedAt = null;
    let finishObserved = false;
    try {
      try {
        admission = await ledger.admit(id, {sessionId: options.sessionId, parentSessionId: agent.session.header.parentSession ?? null,
          provider: options.provider, model: options.model, reasoningEffort:options.reasoningEffort ?? null, purpose: options.purpose ?? null});
      } catch (error) {
        throw new LlmError('Task admission refused; inspect the task ledger',
          error instanceof PolicyError ? error.code : 'ADMISSION_STORAGE_FAILED');
      }

      // Cancellation may race the durable admission write. The receipt remains charged,
      // but no provider dispatch is allowed after process-local stop intent is visible.
      if (stopIntents.has(id)) throw new LlmError('Task stopped before provider dispatch', 'TASK_NOT_RUNNING');
      options.signal.throwIfAborted();
      try {
        await ledger.prepareCallAdapterBoundary(id, admission.id);
      } catch (error) {
        evidenceFailures.add(evidenceKey(id, admission.attemptId));
        observePersistenceFailure(id, error, {state:'executing', localOutcome:null,
          persistence:'unconfirmed', stopConfirmation:null});
        throw new LlmError('Adapter boundary preparation could not be persisted', 'OBSERVATION_STORAGE_FAILED');
      }
      // Cancellation can arrive while the durable boundary write is awaiting storage.
      // Recheck without another await so a visible stop intent never reaches next().
      if (stopIntents.has(id)) throw new LlmError('Task stopped before adapter invocation', 'TASK_NOT_RUNNING');
      options.signal.throwIfAborted();
      const dispatch = () => {
        // An integrated input measurement may await. Preserve the last-moment
        // cancellation check at the actual invocation, not just before it.
        if (stopIntents.has(id)) throw new LlmError('Task stopped before adapter invocation', 'TASK_NOT_RUNNING');
        options.signal.throwIfAborted();
        return next();
      };
      const stream = streamBoundary ? streamBoundary({options, task:owningTask, attempt:activeAttempt,
        admission, agent, workspace:workspaceById.get(owningTask.workspaceId ?? defaultWorkspace.id)}, dispatch) : dispatch();
      for await (const chunk of stream) {
        const receivedAt = new Date().toISOString();
        if (firstResponseAt === null) {
          firstResponseAt = receivedAt;
          try { await ledger.recordFirstResponse(id, admission.id, receivedAt); }
          catch (error) {
            evidenceFailures.add(evidenceKey(id, admission.attemptId));
            observePersistenceFailure(id, error, {state:'executing', localOutcome:null,
              persistence:'unconfirmed', stopConfirmation:null});
          }
        }
        if (chunk.type === 'usage') {
          usage = structuredClone(chunk.usage); usageObservedAt = receivedAt;
          try { await ledger.recordUsage(id, admission.id, usage, receivedAt); }
          catch (error) {
            evidenceFailures.add(evidenceKey(id, admission.attemptId));
            observePersistenceFailure(id, error, {state:'executing', localOutcome:null,
              persistence:'unconfirmed', stopConfirmation:null});
          }
        }
        if (chunk.type === 'finish') { outcome = chunk.reason.kind; finishObserved = true; }
        yield chunk;
      }
    } catch (error) {
      outcome = options.signal.aborted || stopIntents.has(id) ? 'aborted' : 'error';
      throw error;
    } finally {
      if (admission) {
        try {
          await ledger.finishCall(id, admission.id, outcome, usage,
            {firstResponseAt, usageObservedAt, finishObserved});
        } catch (error) {
          evidenceFailures.add(evidenceKey(id, admission.attemptId));
          observePersistenceFailure(id, error, {state: stopIntents.has(id) ? 'canceling' : 'executing',
            localOutcome: null, persistence: 'unconfirmed', stopConfirmation: null});
        }
      }
    }
  });

  function abortable(promise, signal) {
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Task cancelled'));
    return new Promise((resolvePromise, rejectPromise) => {
      const onAbort = () => rejectPromise(signal.reason ?? new Error('Task cancelled'));
      signal.addEventListener('abort', onAbort, {once: true});
      Promise.resolve(promise).then(value => {
        signal.removeEventListener('abort', onAbort);
        resolvePromise(value);
      }, error => {
        signal.removeEventListener('abort', onAbort);
        rejectPromise(error);
      });
    });
  }

  function ownedAgents(root) {
    const agents = new Set(root ? [root] : []);
    let changed = true, lookupFailed = false;
    while (changed) {
      changed = false;
      let candidates;
      try { candidates = [...(ctx.agents?.list?.() ?? [])]; }
      catch { lookupFailed = true; break; }
      for (const owner of [...agents]) for (const candidate of candidates) {
        if (!candidate || agents.has(candidate)) continue;
        try {
          if (ctx.agents.isOwnedBy(candidate.id, owner)) { agents.add(candidate); changed = true; }
        } catch { lookupFailed = true; }
      }
    }
    return {agents, lookupFailed};
  }

  async function settleFor(promises, milliseconds) {
    let timer;
    const timeout = new Promise(resolvePromise => { timer = setTimeout(() => resolvePromise(null), milliseconds); });
    const settled = await Promise.race([Promise.allSettled(promises), timeout]);
    clearTimeout(timer);
    return settled;
  }

  async function settleOwnedTree(root, {stop = false, prompt = null} = {}) {
    if (!root) return {confirmed: true};
    const deadline = Date.now() + cancellationTimeoutMs;
    const seen = new Set(), cancelled = new Set(), idle = new Map();
    let cleanupFailed = false;
    const observe = async bounded => {
      let backgroundObservation;
      while (!bounded || Date.now() < deadline) {
        const discovery = ownedAgents(root);
        if (discovery.lookupFailed) cleanupFailed = true;
        for (const agent of discovery.agents) seen.add(agent);
        for (const agent of seen) {
          if (stop && !cancelled.has(agent)) {
            cancelled.add(agent);
            try { agent.cancel({kind:'user'}, {keepInbox:false}); } catch { cleanupFailed = true; }
          }
          if (!idle.has(agent)) idle.set(agent, Promise.resolve().then(() => agent.whenIdle()));
        }

        // Keep discovering exact ownership even after the caller's bounded wait.
        // A root may still be awaiting a child registered during cancellation.
        const waiting = [...idle.values()];
        const pending = prompt ? [...waiting, prompt] : waiting;
        let settled;
        if (bounded) settled = await settleFor(pending, Math.min(10, deadline - Date.now()));
        else {
          // Attach once per discovered tree, not once per poll to a never-ending
          // native promise. This also bounds retained handlers during a long stop.
          if (!backgroundObservation || backgroundObservation.count !== pending.length) {
            const observation = {count:pending.length, settled:null};
            Promise.allSettled(pending).then(value => { observation.settled = value; });
            backgroundObservation = observation;
          }
          settled = backgroundObservation.settled;
          if (settled === null) await new Promise(resolveWait => {
            const timer = setTimeout(resolveWait, 50);
            timer.unref?.();
          });
        }
        if (settled === null) continue;
        if (settled.slice(0, waiting.length).some(result => result.status === 'rejected')) cleanupFailed = true;
        if (prompt) {
          // An idle observation made before prompt acceptance is stale. Fence the
          // actual promise (not abortable's observation), then cancel and observe
          // the owned tree again. A prompt timeout is unknown, never termination.
          prompt = null; idle.clear(); cancelled.clear(); backgroundObservation = null; continue;
        }
        const finalDiscovery = ownedAgents(root);
        if (finalDiscovery.lookupFailed) cleanupFailed = true;
        const before = seen.size;
        for (const agent of finalDiscovery.agents) seen.add(agent);
        if (seen.size === before) return {confirmed: !cleanupFailed};
      }
      return {confirmed: false};
    };
    const result = await observe(true);
    if (result.confirmed || cleanupFailed) return result;
    // A timeout bounds the caller's wait, not native execution. Continue observing
    // the same owned agents and prompt without keeping the process alive or replaying.
    // Failed idle/ownership evidence remains unconfirmed and retains capacity.
    return {confirmed:false, termination:observe(false)};
  }

  const startStop = running => {
    if (!running?.agent) return null;
    return running.stopPromise ??= settleOwnedTree(running.agent, {stop:true,
      prompt:running.promptPending ? running.promptWork : null});
  };

  const maxSeq = events => events.reduce((value, event) => Math.max(value, event.seq ?? -1), -1);
  const eventsAfter = (events, seq) => events.filter(event => (event.seq ?? -1) > seq);
  const promptObserved = (events, requestId) => events.some(event => event.type === 'user/message' &&
    event.data?.source?.kind === 'user' && event.data.source.rpcId === requestId);
  const workspaceToolContext = workspace => [
    'Gateway workspace tool context:',
    `- The gateway selected the authorized workspace with workspaceId ${JSON.stringify(workspace.id)}. This workspaceId is a selector only, not a filesystem path.`,
    '- All file tool paths are resolved relative to the selected authorized workspace; do not use an absolute host path or prefix a path with the workspaceId.',
    '- If the task names a file, read that file directly with the smallest useful offset and limit; do not run glob or grep first unless the direct read fails or the path is ambiguous. If its location is unknown, search a specific top-level source or test directory with a restrictive include, read only the matching context, and expand only when needed; do not recursively search "." across the mixed workspace root.',
    '- Reuse unchanged successful reads and tool results already present in this attempt or native session history. Re-read only when a relevant file may have changed or the evidence is stale; preserve security, authorization, budget, failure, test, and recovery facts while avoiding full-result repetition or progress-only summaries.'
  ].join('\n');
  const attemptPrompt = (task, attempt, evidence, workspace) => {
    let prompt;
    if (!attempt || attempt.kind === 'initial') prompt = task.goal;
    else if (attempt.kind === 'reconcile') prompt = [
      'This is a read-only reconciliation of an interrupted task whose outcome is unknown.',
      'Do not continue the business change, edit or write files, run commands, reuse an old approval, or replay any prior side effect.',
      'Re-read the relevant current files because the user may have edited them while execution was interrupted.',
      'Use the existing session history and the gateway evidence below to identify what is confirmed, failed, unconfirmed, or conflicting.',
      'Report the current state and the minimum explicit next step. If evidence is insufficient, say so instead of guessing.',
      `Gateway reconciliation evidence: ${JSON.stringify(evidence)}`,
      `User reconciliation note: ${attempt.instruction}`
    ].join('\n\n');
    else prompt = [
      attempt.kind === 'supplement'
        ? 'The user is supplementing the original goal in this same host session; integrate the new goal and preserve every earlier attempt, failure, tool result, and consumed call.'
        : 'Continue the original task in this same host session; preserve every earlier attempt, failure, tool result, and consumed call.',
      'Before changing anything, use the existing session history and re-read only current files that the new instruction directly depends on and that may have changed between turns; do not re-read unchanged files merely to reconstruct context.',
      'Do not assume that an earlier one-shot approval applies to any new action. Request and await a new native approval whenever required.',
      `Original user goal (context, not a new approval): ${task.goal}`,
      `User continuation: ${attempt.instruction}`
    ].join('\n\n');
    return [prompt, workspaceToolContext(workspace)].join('\n\n');
  };
  async function reconciliationEvidence(task, workspace, agent, security) {
    let git;
    try {
      // Avoid optional index writes and repository-configured fsmonitor hooks: reconciliation
      // observes current Git state but must not execute repository code or mutate the index.
      const {stdout} = await execFileAsync('git', ['--no-optional-locks','-c','core.fsmonitor=false',
        '-c','core.untrackedCache=false','status','--porcelain=v1','--untracked-files=all'],
        {cwd:workspace.cwd, windowsHide:true, timeout:10000, maxBuffer:1024 * 1024});
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      git = {available:true, clean:lines.length === 0, changedEntries:lines.length,
        stagedEntries:lines.filter(line => line[0] !== ' ' && line[0] !== '?').length,
        unstagedEntries:lines.filter(line => line[1] !== ' ').length,
        untrackedEntries:lines.filter(line => line.startsWith('??')).length};
    } catch {
      git = {available:false, code:'GIT_STATUS_UNAVAILABLE'};
    }
    const events = agent.session.snapshotEvents();
    return {git, security,
      ledger:{status:task.status, calls:task.calls.length, denials:task.denials.length,
        toolOperations:(task.toolOperations ?? []).length, approvalOperations:(task.approvalOperations ?? []).length},
      session:{lastSeq:maxSeq(events), userMessages:events.filter(event => event.type === 'user/message').length,
        turnEnds:events.filter(event => event.type === 'turn/end').length,
        toolCalls:events.filter(event => event.type === 'tool/call').length,
        toolResults:events.filter(event => event.type === 'tool/result').length}};
  }

  async function execute(task, attempt = task.attempts?.at(-1) ?? {id:task.id, kind:'initial', instruction:task.goal}) {
    let agent, promptAccepted = false, promptMayHaveBeenAccepted = false, stage = attempt.kind === 'initial' ? 'create' : 'resolve-agent';
    let eventBoundary = -1, releaseReconciliation = null, reconciliationSecurity = null, terminationConfirmed = false;
    let termination;
    const controller = new AbortController();
    const running = {controller, agent:null, stopPromise:null, attemptId:attempt.id,
      release() {
        try { releaseReconciliation?.(); } catch {}
        if (live.get(task.id) === running) live.delete(task.id);
      }};
    live.set(task.id, running);

    try {
      const workspace = workspaceById.get(task.workspaceId ?? defaultWorkspace.id);
      if (!workspace) throw new PolicyError('WORKSPACE_NOT_AUTHORIZED');
      const sessionMissing = !ctx.sessions.get(task.sessionId);
      if (attempt.kind === 'initial' || (attempt.kind === 'reconcile' && sessionMissing)) {
        const created = await ctx.sessionController.create({sessionId: task.sessionId,
          cwd:workspace.cwd, agentPreset:task.policy.agentPreset ?? 'gateway-agent'});
        if (created.sessionId !== task.sessionId || created.agentPreset !== (task.policy.agentPreset ?? 'gateway-agent'))
          throw new PolicyError('PRESET_UNAVAILABLE');
        if (!allowHostSessions && task.policy.scheduling?.mode === 'delegate') {
          // Preserve the dedicated entry's existing scheduling behavior.
          ctx.sessions.get(task.sessionId).append('subagent/model-selection-policy',
            {allowedModels:task.policy.allowedChildRoutes.map(({provider,model}) => ({provider,model}))});
        }
      }

      stage = 'attach-workspace';
      await nativeWorkspaceById.get(workspace.id).attachSession(task.sessionId);

      stage = 'resolve-agent';
      const resolved = await ctx.sessionController.resolveAgent(task.sessionId);
      if (resolved.error) throw resolved.error;
      agent = resolved.agent; running.agent = agent;
      if (closing || stopIntents.has(task.id)) throw new Error('Task cancellation requested');

      stage = 'check-safety';
      const reconcile = attempt.kind === 'reconcile';
      const permissions = () => ctx.sessionProjections.stateOf(agent.session, 'permissions');
      if (reconcile) {
        const sandboxBefore = permissions()?.sandbox ?? null;
        let narrowingEventSeq = null;
        if (sandboxBefore !== 'read-only') {
          agent.session.append('sandbox/mode', {mode:'read-only'});
          narrowingEventSeq = agent.session.snapshotEvents().findLast(event =>
            event.type === 'sandbox/mode' && event.data?.mode === 'read-only')?.seq ?? null;
        }
        reconciliationSecurity = {sandboxBefore, narrowedByGateway:narrowingEventSeq !== null, narrowingEventSeq};
        releaseReconciliation = enterReconciliation(agent);
      } else if (task.policy.toolSet === 'development' && permissions()?.sandbox === 'read-only' &&
          task.attempts?.at(-2)?.status === 'reconciled') {
        // Restore only the exact durable narrowing event written by this gateway. A user or
        // host policy change between turns wins and remains fail-closed.
        const expectedSeq = task.attempts.at(-2).reconciliationEvidence?.security?.narrowingEventSeq;
        const lastMode = agent.session.snapshotEvents().findLast(event => event.type === 'sandbox/mode');
        if (Number.isInteger(expectedSeq) && lastMode?.seq === expectedSeq &&
            lastMode.data?.mode === 'read-only') {
          agent.session.append('sandbox/mode', {mode:'workspace-write'});
        }
      }

      assertExecutionSafety(ctx, agent, task.policy, {reconcile});
      stage = 'check-tools';
      const schemas = (ctx.agentPresets.serviceFor(agent,'tools') ?? ctx.tools).schemas(agent);
      if (!toolsFor(task.policy.toolSet, agent.session.header?.origin, reconcile, task.policy.delegationEnabled)
        .every(name => schemas.some(value => value.name === name)))
        throw new PolicyError('REQUIRED_TOOLS_UNAVAILABLE');

      if (attempt.kind === 'initial') {
        stage = 'rename';
        await ctx.sessionController.rename({sessionId:task.sessionId, title:`目标任务 · ${task.id.slice(0, 8)}`});
      }
      stage = 'select-model';
      const selected = (await ctx.sessionController.selectModel({sessionId:task.sessionId, ...task.policy.root})).selected;
      if (selected.provider !== task.policy.root.provider || selected.model !== task.policy.root.model) throw new Error('Selection changed');
      if (task.policy.root.reasoningEffort && selected.reasoningEffort !== task.policy.root.reasoningEffort)
        throw new Error('Reasoning selection changed');
      if (closing || stopIntents.has(task.id) || ledger.get(task.id).status !== 'running')
        throw new Error('Task cancellation requested');

      let evidence = null;
      if (reconcile) {
        stage = 'reconcile-evidence';
        evidence = await reconciliationEvidence(ledger.get(task.id), workspace, agent, reconciliationSecurity);
        await ledger.recordReconciliationEvidence(task.id, attempt.id, evidence);
      }

      stage = 'prompt';
      const beforePrompt = agent.session.snapshotEvents();
      eventBoundary = maxSeq(beforePrompt);
      promptMayHaveBeenAccepted = true;
      const promptWork = ctx.sessionController.prompt({requestId:attempt.id, sessionId:task.sessionId, mode:'queue',
        content:[{type:'text',text:attemptPrompt(task, attempt, evidence, workspace)}]}, controller.signal);
      running.promptPending = true;
      running.promptWork = Promise.resolve(promptWork).finally(() => { running.promptPending = false; });
      await abortable(running.promptWork, controller.signal);
      promptAccepted = true;
      if (closing || stopIntents.has(task.id) || ledger.get(task.id).status !== 'running')
        throw new Error('Task cancellation requested');

      // Native foreground spawn keeps the root busy until owned children settle.
      stage = 'wait-idle';
      await abortable(agent.whenIdle(), controller.signal);
      const endedTree = await settleOwnedTree(agent);
      if (!endedTree.confirmed) throw new PolicyError('EXECUTION_UNCONFIRMED');
      if (closing || stopIntents.has(task.id) || controller.signal.aborted)
        throw new Error('Task cancellation requested');
      terminationConfirmed = true;
      stage = 'finalize';

      const events = agent.session.snapshotEvents();
      const currentEvents = eventsAfter(events, eventBoundary);
      const reason = currentEvents.findLast(event => event.type === 'turn/end')?.data.reason?.kind;
      await ledger.tail;
      if (evidenceFailures.has(evidenceKey(task.id, attempt.id))) {
        await persistFinal(task.id, 'unknown', null, 'EVIDENCE_STORAGE_FAILED', 'finalize', 'unconfirmed');
      } else {
        const status = reason === 'completed' ? 'completed' : reason === 'aborted' ? 'stopped' : reason ? 'failed' : 'unknown';
        await persistFinal(task.id, status, finalAssistantText(currentEvents), null, null,
          status === 'stopped' ? 'confirmed' : status === 'unknown' ? 'unconfirmed' : null);
      }
    } catch (error) {
      const cancellationRequested = closing || stopIntents.has(task.id) || controller.signal.aborted;
      // Close admissions before cleanup. This also protects against a late prompt completion
      // when Session Controller does not accept a caller AbortSignal.
      stopIntents.add(task.id);
      if (!controller.signal.aborted) controller.abort(new Error('Task execution ending'));
      const stop = agent ? await (startStop(running) ?? Promise.resolve({confirmed:false}))
        : {confirmed: !promptMayHaveBeenAccepted};
      terminationConfirmed = stop.confirmed;
      termination = stop.termination;
      const events = agent?.session.snapshotEvents?.() ?? [];
      const currentEvents = eventsAfter(events, eventBoundary);
      const accepted = promptAccepted || promptMayHaveBeenAccepted || promptObserved(events, attempt.id);
      const reason = currentEvents.findLast(event => event.type === 'turn/end')?.data.reason?.kind;
      await ledger.tail;

      let status, failureCode;
      if (evidenceFailures.has(evidenceKey(task.id, attempt.id))) {
        status = 'unknown'; failureCode = 'EVIDENCE_STORAGE_FAILED';
      } else if (cancellationRequested) {
        status = !stop.confirmed ? 'unknown' : reason === 'completed' ? 'completed' : 'stopped';
        failureCode = status === 'unknown' ? 'EXECUTION_UNCONFIRMED' : null;
      } else {
        status = accepted ? 'unknown' : 'failed';
        failureCode = error instanceof PolicyError ? error.code : accepted ? 'EXECUTION_UNCONFIRMED' : 'PREPARATION_FAILED';
      }
      await persistFinal(task.id, status, status === 'completed' ? finalAssistantText(currentEvents) : null,
        failureCode, status === 'completed' ? null : stage,
        status === 'stopped' ? 'confirmed' : status === 'unknown' ? (stop.confirmed ? 'confirmed' : 'unconfirmed') : null);
    }
    return {terminationConfirmed, termination};
  }
  const queueKey = (taskId, attemptId) => `${taskId}/${attemptId}`;
  const serializedWorkspace = task => {
    if (task.policy.toolSet !== 'development') return null;
    const id = task.workspaceId ?? defaultWorkspace.id;
    // Reuse the host's canonical workspace identity: two configured aliases
    // must not acquire separate write leases for the same physical directory.
    return nativeWorkspaceById.get(id)?.id ?? id;
  };
  const removePending = entry => {
    pendingByKey.delete(entry.key);
    const index = pendingQueue.indexOf(entry);
    if (index >= 0) pendingQueue.splice(index, 1);
  };
  const schedulePump = () => {
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      while (!closing && activeExecutions < maxConcurrentTasks) {
        const index = pendingQueue.findIndex(entry => !entry.workspaceId || !workspaceLeases.has(entry.workspaceId));
        if (index < 0) return;
        const entry = pendingQueue.splice(index, 1)[0];
        pendingByKey.delete(entry.key);
        activeExecutions++;
        if (entry.workspaceId) workspaceLeases.add(entry.workspaceId);
        void (async () => {
          let outcome;
          try {
            const started = await ledger.startAttempt(entry.taskId, entry.attemptId);
            if (!started) return outcome = {terminationConfirmed:true};
            if (closing || stopIntents.has(entry.taskId) || ledger.get(entry.taskId)?.status !== 'running') {
              await persistFinal(entry.taskId, 'stopped', null, null, 'queue-dispatch', 'confirmed');
              return outcome = {terminationConfirmed:true};
            }
            return outcome = await execute(started.task, started.attempt);
          } catch (error) {
            stopIntents.add(entry.taskId);
            // An error while reading/finalizing execution evidence is not a
            // pre-launch failure and cannot manufacture native termination.
            const running = live.get(entry.taskId);
            if (running) {
              let stop;
              try { stop = await startStop(running); } catch {}
              outcome = {terminationConfirmed:stop?.confirmed === true, termination:stop?.termination};
              await persistFinal(entry.taskId, 'unknown', null,
                evidenceFailures.has(evidenceKey(entry.taskId, entry.attemptId))
                  ? 'EVIDENCE_STORAGE_FAILED' : 'EXECUTION_UNCONFIRMED',
                'execution-evidence', outcome.terminationConfirmed ? 'confirmed' : 'unconfirmed');
              return outcome;
            }
            if (error instanceof TaskStorageError) {
              observePersistenceFailure(entry.taskId, error, {state:'ended-local', localOutcome:'failed',
                persistence:'unconfirmed', stopConfirmation:'confirmed'});
            } else {
              await persistFinal(entry.taskId, 'failed', null,
                error instanceof PolicyError ? error.code : 'PREPARATION_FAILED', 'queue-dispatch', 'confirmed');
            }
            return outcome = {terminationConfirmed:true};
          } finally {
            const release = () => {
              // Own all release paths here, including exceptions that escaped
              // execute before it could return its native termination evidence.
              const running = live.get(entry.taskId);
              if (running?.attemptId === entry.attemptId) running.release();
              activeExecutions--;
              if (entry.workspaceId) workspaceLeases.delete(entry.workspaceId);
              schedulePump();
            };
            if (outcome?.terminationConfirmed) release();
            else outcome?.termination?.then(result => { if (result.confirmed) release(); }, () => {});
          }
        })().then(entry.resolve, entry.reject);
      }
    });
  };
  const stopQueuedReceipt = (taskId, attemptId, result = {terminationConfirmed:true}) => {
    const entry = pendingByKey.get(queueKey(taskId, attemptId));
    if (!entry) return false;
    removePending(entry);
    entry.resolve(result);
    schedulePump();
    return true;
  };

  async function cancel(id) {
    const task = ledger.get(id);
    if (!task) throw new PolicyError('TASK_NOT_FOUND');
    const running = live.get(id);
    if (!['queued','running','cancel-requested'].includes(task.status) && !running) return;
    const attemptId = task.attempts?.at(-1)?.id;

    // Process-local intent comes first: storage failure must never permit more dispatch.
    stopIntents.add(id);
    if (running) {
      if (!running.controller.signal.aborted) running.controller.abort(new Error('Task cancellation requested'));
      startStop(running);
    }
    if (['queued','running','cancel-requested'].includes(task.status)) {
      try {
        const cancelled = await ledger.cancel(id);
        if (cancelled.previousStatus === 'queued' && attemptId) stopQueuedReceipt(id, attemptId);
        if (!evidenceFailures.has(evidenceKey(id, attemptId)) && observations.get(id)?.lifecycle?.state === 'canceling') observations.delete(id);
      } catch (error) {
        if (task.status === 'queued' && attemptId) stopQueuedReceipt(id, attemptId);
        observePersistenceFailure(id, error, {state: task.status === 'queued' ? 'ended-local' : 'canceling',
          localOutcome: task.status === 'queued' ? 'stopped' : null,
          persistence: 'unconfirmed', stopConfirmation: task.status === 'queued' ? 'confirmed' : 'unconfirmed'});
      }
    }
  }

  function launch(task, attempt) {
    const key = queueKey(task.id, attempt.id);
    const prior = executionReceipts.get(key);
    if (prior) return prior.receipt;
    roots.set(task.sessionId, task.id);
    const state = {terminationConfirmed:null};
    const pending = Promise.withResolvers();
    const entry = {key, taskId:task.id, attemptId:attempt.id,
      workspaceId:serializedWorkspace(task), resolve:pending.resolve, reject:pending.reject};
    pendingQueue.push(entry); pendingByKey.set(key, entry);
    const job = pending.promise;
    jobs.add(job);
    job.finally(() => jobs.delete(job)).catch(() => {});
    schedulePump();
    const done = job.then(result => {
      state.terminationConfirmed = result.terminationConfirmed;
      return Object.freeze({taskId:task.id, sessionId:task.sessionId, attemptId:attempt.id,
        terminationConfirmed:result.terminationConfirmed, task:visibleTask(task.id)});
    }, () => {
      state.terminationConfirmed = false;
      return Object.freeze({taskId:task.id, sessionId:task.sessionId, attemptId:attempt.id,
        terminationConfirmed:false, task:visibleTask(task.id)});
    });
    const receipt = Object.freeze({taskId:task.id, sessionId:task.sessionId, attemptId:attempt.id, done,
      async stop() {
        // An old receipt must never stop a later repair on the same session.
        if (ledger.get(task.id)?.attempts?.at(-1)?.id === attempt.id) await cancel(task.id);
        const ended = await done;
        return {confirmed:ended.terminationConfirmed};
      }});
    executionReceipts.set(key, Object.assign(state, {receipt}));
    return receipt;
  }
  async function assertNotDraining() {
    if (closing) throw new PolicyError('GATEWAY_CLOSING');
    if (lifecycleDrainPath) {
      try { await access(lifecycleDrainPath); throw new PolicyError('GATEWAY_DRAINING'); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
  }

  async function startTask(value) {
    if (closing) throw new PolicyError('GATEWAY_CLOSING');
    const input = inputSchema.parse(value); input.requestId = input.requestId.toLowerCase();
    input.workspaceId ??= defaultWorkspace.id;
    if (!workspaceById.has(input.workspaceId)) throw new PolicyError('WORKSPACE_NOT_AUTHORIZED');
    const prior = ledger.get(input.requestId);
    const priorInitialMaxCalls = prior?.attempts?.[0]?.budgetAfter ?? prior?.policy.maxCalls;
    if (input.maxCalls !== undefined && !authorizedTaskMaxCalls.includes(input.maxCalls) &&
        priorInitialMaxCalls !== input.maxCalls)
      throw new PolicyError('CALL_LIMIT_NOT_AUTHORIZED');
    await assertNotDraining();
    let taskPolicy = input.maxCalls === undefined ? policy : {...policy, maxCalls:input.maxCalls};
    if (schedulingCatalog && !prior) {
      const selected = validatePreferences({scheduling:input.scheduling ?? defaultPreferences().scheduling,
        maxCalls:input.maxCalls ?? defaultPreferences().maxCalls});
      taskPolicy = resolveScheduling(selected.scheduling,schedulingCatalog,policy,selected.maxCalls);
    } else if (input.scheduling) {
      if (prior) {
        const normalize = item => JSON.stringify([selectionKey(item.root),item.mode,item.children.map(selectionKey).sort()]);
        if (!prior.policy.scheduling || normalize(input.scheduling) !== normalize(prior.policy.scheduling))
          throw new PolicyError('REQUEST_ID_CONFLICT');
        taskPolicy = prior.policy;
      } else throw new PolicyError('SCHEDULING_UNAVAILABLE');
    }
    const created = await ledger.create(input, taskPolicy);
    const receipt = created.created ? launch(created.task, created.task.attempts[0])
      : executionReceipts.get(`${created.task.id}/${created.task.attempts?.[0]?.id}`)?.receipt;
    return {task:publicTask(created.task), receipt};
  }

  async function continueTask(id, value) {
    if (closing) throw new PolicyError('GATEWAY_CLOSING');
    const input = continuationSchema.parse(value);
    input.continuationId = input.continuationId.toLowerCase(); input.instruction = input.instruction.trim();
    if (lifecycleBinding && input.additionalCalls !== 0) throw new PolicyError('CONTINUATION_CALL_LIMIT_NOT_AUTHORIZED');
    await assertNotDraining();
    const continued = await ledger.beginContinuation(id, input, authorizedContinuationCallIncrements, task => {
      const previous = executionReceipts.get(`${id}/${task.attempts?.at(-1)?.id}`);
      if ((previous && previous.terminationConfirmed !== true) || (lifecycleBinding && !previous))
        throw new PolicyError('EXECUTION_TERMINATION_UNCONFIRMED');
    });
    let receipt = executionReceipts.get(`${id}/${continued.attempt.id}`)?.receipt;
    if (continued.created) {
      stopIntents.delete(id); observations.delete(id);
      receipt = launch(continued.task, continued.attempt);
    }
    return {task:publicTask(continued.task), receipt};
  }

  // The scheduler receives receipts for the same validated native operations as
  // HTTP, not a second executor. No credentials, auto-approval or replay route.
  const requireReceipt = result => {
    if (!result.receipt) throw new PolicyError('NATIVE_EXECUTION_RECEIPT_UNAVAILABLE');
    return result.receipt;
  };
  const runtime = Object.freeze({
    async start(input) { return requireReceipt(await startTask(input)); },
    async continue(id, input) { return requireReceipt(await continueTask(id, input)); },
  });

  ctx.on('dispose', async () => {
    closing = true;
    const ids = new Set([...live.keys(), ...ledger.list()
      .filter(task => ['queued','running','cancel-requested'].includes(task.status)).map(task => task.id)]);
    await Promise.allSettled([...ids].map(id => cancel(id)));
    await Promise.allSettled([...jobs]);
    await domain.close();
    await settingsDomain?.close();
  });

  ctx.connection.fetch.register({path:'/api/gateway-agent-tasks', methods:['GET','POST'], requestBody:'buffered', async fetch(request) {

    try {

      const query = new URL(request.url).searchParams, id = query.get('id');

      let result;

      if (request.method === 'GET') {

        if (query.get('view') === 'audit') {
          const tasks = id ? [observedTask(id)].filter(Boolean) : ledger.list().map(task => observedTask(task.id));
          result = auditExport(tasks, new Map(tasks.map(task => [task.id, observations.get(task.id)?.lifecycle])));
        } else result = id ? visibleTask(id) : {policy, authorizedTaskMaxCalls, authorizedContinuationCallIncrements,
          scheduling:schedulingCatalog ? {roots:schedulingCatalog.roots,children:schedulingCatalog.children,
            defaults:defaultPreferences()} : null,
          workspaces:workspaces.map(({id, label}) => ({id, label})),
          capabilities:{commandExecution:commandExecution ?? commandExecutionCapability(ctx.shell), validation:'not-established'},
          tasks:ledger.list().map(task => visibleTask(task.id))};

        if (id && (result === null || (query.get('view') === 'audit' && result.tasks.length === 0)))
          throw new PolicyError('TASK_NOT_FOUND');

      } else {

        if (!request.headers.get('content-type')?.startsWith('application/json')) throw new PolicyError('JSON_REQUIRED');

        const text = await request.text();

        if (text.length > 160000) throw new PolicyError('INPUT_TOO_LARGE');

        let value;

        try { value = JSON.parse(text); } catch { throw new PolicyError('INVALID_JSON'); }

        if (query.get('action') === 'preferences' && !id) {
          const selected = validatePreferences(value);
          await preferences.put('default', selected);
          result = selected;
        } else if (query.get('action') === 'cancel' && id) {

          z.object({}).strict().parse(value);
          if (!ledger.get(id)) throw new PolicyError('TASK_NOT_FOUND');
          let notificationError;
          const notified = Promise.resolve().then(() => lifecycleBinding?.onOperatorCancel({taskId:id,
            attemptId:ledger.get(id)?.attempts?.at(-1)?.id})).catch(error => { notificationError = error; });
          // Notify the scheduler, but never let its rejection suppress native cancellation.
          try { await cancel(id); } finally { await notified; }
          if (notificationError) throw notificationError;
          result = visibleTask(id);

        } else if (query.get('action') === 'continue' && id) {

          if (lifecycleBinding) throw new PolicyError('EXTERNAL_SCHEDULER_REQUIRED');
          result = (await continueTask(id, value)).task;

        } else {

          if (id || query.has('action')) throw new PolicyError('UNSUPPORTED_ACTION');
          if (lifecycleBinding) throw new PolicyError('EXTERNAL_SCHEDULER_REQUIRED');
          result = (await startTask(value)).task;

        }

      }

      return Response.json(result, {headers:{'Cache-Control':'no-store'}});

    } catch (error) {
      const invalidInput = error instanceof z.ZodError || error?.name === 'ZodError';
      return Response.json({error:error instanceof PolicyError ? error.code : invalidInput ? 'INVALID_INPUT' : 'GATEWAY_ERROR'},
        {status:error instanceof PolicyError || invalidInput ? 400 : 500, headers:{'Cache-Control':'no-store'}});
    }

  }});

  if (lifecycleBinding) await lifecycleBinding.connect(runtime);

}
