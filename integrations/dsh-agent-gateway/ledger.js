import { randomUUID } from 'node:crypto';

export class PolicyError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export class TaskStorageError extends Error {
  constructor(operation, attemptedTask, cause) {
    super('Task storage update failed', {cause});
    this.name = 'TaskStorageError';
    this.code = 'TASK_STORAGE_FAILED';
    this.operation = operation;
    this.attemptedTask = structuredClone(attemptedTask);
  }
}
const active = status => ['queued', 'running', 'cancel-requested'].includes(status);
const now = () => new Date().toISOString();
const attemptsOf = task => task.attempts ?? [];
const currentAttempt = task => attemptsOf(task).findLast(attempt => active(attempt.status));
const sameContinuation = (attempt, input) => attempt.kind === input.kind &&
  attempt.instruction === input.instruction && attempt.additionalCalls === input.additionalCalls;
const tokenFields = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens',
  'cacheWriteTokens', 'reasoningTokens'];
const safePurposes = new Set(['compaction', 'session-title', 'planning', 'review']);

// Keep only provider-neutral numeric counters. Provider payloads, request ids,
// pricing and text do not belong in this task ledger.
export function normalizeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = {};
  for (const key of tokenFields) {
    const count = value[key];
    if (Number.isSafeInteger(count) && count >= 0) usage[key] = count;
  }
  return Object.keys(usage).length ? usage : null;
}

export function normalizePurpose(value) {
  if (value === null || value === undefined || value === '') return null;
  return safePurposes.has(value) ? value : 'custom';
}

const sameUsage = (left, right) => tokenFields.every(key => left?.[key] === right?.[key]);

// One process owns this DSH storage domain. Serialize durable admissions, not model work.
// This counts harness stream admissions, NOT provider HTTP attempts or dollars.
export class TaskLedger {
  constructor(table) { this.table = table; this.tail = Promise.resolve(); }
  exclusive(fn) {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  get(id) { const value = this.table.get(id); return value ? structuredClone(value) : null; }
  list() { return [...this.table.entries()].map(([, value]) => structuredClone(value)); }
  edit(id, operation, fn) {
    return this.exclusive(async () => {
      const task = this.get(id);
      if (!task) throw new PolicyError('TASK_NOT_FOUND');
      const result = fn(task);
      try {
        await this.table.put(id, task);
      } catch (error) {
        throw new TaskStorageError(operation, task, error);
      }
      return result;
    });
  }
  async recover() {
    for (const task of this.list()) if (active(task.status)) await this.edit(task.id, 'recover', t => {
      t.status = 'unknown';
      const attempt = currentAttempt(t);
      if (attempt) {
        attempt.status = 'unknown';
        attempt.failureCode = 'EXECUTION_UNCONFIRMED';
        attempt.failureStage ??= 'recover';
      }
      for (const call of t.calls) if (call.outcome === 'admitted') {
        call.outcome = 'unknown';
        call.usageStatus = call.usage ? 'partial' : 'missing';
      }
    });
  }
  create({requestId, goal, workspaceId = 'default', maxCalls}, policy) {
    return this.exclusive(async () => {
      const prior = this.get(requestId);
      if (prior) {
        const initialMaxCalls = prior.attempts?.[0]?.budgetAfter ?? prior.policy.maxCalls;
        if (prior.goal !== goal || (prior.workspaceId ?? 'default') !== workspaceId ||
          (maxCalls !== undefined && initialMaxCalls !== maxCalls))
          throw new PolicyError('REQUEST_ID_CONFLICT');
        return {task: prior, created: false};
      }
      const createdAt = now();
      const task = {id: requestId, sessionId: `gateway-agent-${requestId}`, goal, workspaceId,
        policy: structuredClone(policy), status: 'queued', createdAt, endedAt: null,
        calls: [], denials: [], artifact: null, toolOperations: [], approvalOperations: [],
        attempts: [{id: requestId, kind: 'initial', instruction: goal, additionalCalls: 0,
          budgetBefore: policy.maxCalls, budgetAfter: policy.maxCalls, callStart: 0, callEnd: null,
          status: 'queued', queuedAt: createdAt, startedAt: null, endedAt: null, artifact: null,
          failureCode: null, failureStage: null}]};
      await this.table.put(task.id, task);
      return {task: structuredClone(task), created: true};
    });
  }
  beginContinuation(id, input, authorizedIncrements = [], assertExecutionEnded) {
    return this.edit(id, 'begin-continuation', task => {
      task.attempts ??= [];
      const prior = task.attempts.find(attempt => attempt.id === input.continuationId);
      if (prior) {
        if (!sameContinuation(prior, input)) throw new PolicyError('CONTINUATION_ID_CONFLICT');
        return {task: structuredClone(task), attempt: structuredClone(prior), created: false};
      }
      if (active(task.status)) throw new PolicyError('TASK_ALREADY_RUNNING');
      // Check the actual latest attempt inside the serialized edit, not against
      // a snapshot taken before another queued finalization or continuation.
      assertExecutionEnded?.(task);
      if (input.kind === 'reconcile' && task.status !== 'unknown') throw new PolicyError('RECONCILE_NOT_REQUIRED');
      if (input.kind !== 'reconcile' && task.status === 'unknown') throw new PolicyError('RECONCILIATION_REQUIRED');
      if (input.additionalCalls > 0 && !authorizedIncrements.includes(input.additionalCalls))
        throw new PolicyError('CONTINUATION_CALL_LIMIT_NOT_AUTHORIZED');
      if (task.calls.length >= task.policy.maxCalls && input.additionalCalls === 0)
        throw new PolicyError('TASK_CALL_LIMIT');
      if (task.policy.maxCalls + input.additionalCalls > 100)
        throw new PolicyError('CALL_LIMIT_EXCEEDS_MAXIMUM');

      const queuedAt = now(), budgetBefore = task.policy.maxCalls;
      task.policy.maxCalls += input.additionalCalls;
      const attempt = {id: input.continuationId, kind: input.kind, instruction: input.instruction,
        additionalCalls: input.additionalCalls, budgetBefore, budgetAfter: task.policy.maxCalls,
        callStart: task.calls.length, callEnd: null, status: 'queued', queuedAt, startedAt: null, endedAt: null,
        artifact: null, failureCode: null, failureStage: null};
      task.attempts.push(attempt);
      task.status = 'queued'; task.endedAt = null; task.artifact = null;
      task.failureCode = null; task.failureStage = null;
      return {task: structuredClone(task), attempt: structuredClone(attempt), created: true};
    });
  }
  startAttempt(id, attemptId) {
    return this.edit(id, 'start-attempt', task => {
      const attempt = attemptsOf(task).find(value => value.id === attemptId);
      if (task.status !== 'queued' || attempt?.status !== 'queued') return null;
      const startedAt = now();
      task.status = 'running';
      attempt.status = 'running';
      attempt.startedAt = startedAt;
      return {task: structuredClone(task), attempt: structuredClone(attempt)};
    });
  }
  recordReconciliationEvidence(id, attemptId, evidence) {
    return this.edit(id, 'record-reconciliation-evidence', task => {
      const attempt = attemptsOf(task).find(value => value.id === attemptId);
      if (!attempt) throw new PolicyError('CONTINUATION_NOT_FOUND');
      attempt.reconciliationEvidence = structuredClone(evidence);
    });
  }
  async admit(id, facts) {
    const result = await this.edit(id, 'admit', task => {
      const attempt = currentAttempt(task);
      const matches = r => r.provider === facts.provider && r.model === facts.model;
      const route = task.policy.allowedRoutes.find(matches);
      const childRoutes = task.policy.allowedChildRoutes;
      const childRoute = facts.sessionId !== task.sessionId && childRoutes ? childRoutes.find(matches) : route;
      const code = task.status !== 'running' || (task.attempts && !attempt) ? 'TASK_NOT_RUNNING'
        : task.policy.delegationEnabled === false && facts.sessionId !== task.sessionId ? 'DELEGATION_DISABLED'
        : !route || !childRoute ? 'ROUTE_NOT_AUTHORIZED'
        : [route, childRoute].some(r => r.reasoningEffort && r.reasoningEffort !== facts.reasoningEffort) ? 'REASONING_NOT_AUTHORIZED'
        : task.calls.length >= task.policy.maxCalls ? 'TASK_CALL_LIMIT' : null;
      if (code) {
        task.denials.push({...facts, purpose:normalizePurpose(facts.purpose),
          ...(attempt ? {attemptId: attempt.id} : {}), code, at: now()});
        return {code};
      }
      const purpose = normalizePurpose(facts.purpose);
      const sessionRole = facts.sessionId === task.sessionId ? 'root' : 'child';
      const auxiliaryPurpose = purpose;
      const storedFacts = {...facts, purpose};
      const call = {...storedFacts, ...(attempt ? {attemptId: attempt.id} : {}), id: randomUUID(),
        measurementKind:'llm-stream-admission', admittedAt: now(),
        source: auxiliaryPurpose ? 'auxiliary' : sessionRole, sessionRole, auxiliaryPurpose,
        adapterBoundaryPreparedAt: null, firstResponseAt: null,
        httpAttempts: {observability:'bounded', count:0, basis:'next-invocation-not-prepared'},
        endedAt: null, outcome: 'admitted', usage: null, usageStatus:'missing',
        usageFirstObservedAt:null, usageObservedAt:null, usageObservationCount:0};
      task.calls.push(call);
      return {call};
    });
    if (result.code) throw new PolicyError(result.code);
    return result.call;
  }
  prepareCallAdapterBoundary(id, callId, at = now()) {
    return this.edit(id, 'prepare-call-adapter-boundary', task => {
      const call = task.calls.find(c => c.id === callId);
      if (!call) throw new PolicyError('CALL_NOT_FOUND');
      if (call.endedAt !== null) return;
      if (call.adapterBoundaryPreparedAt === null || call.adapterBoundaryPreparedAt === undefined)
        call.adapterBoundaryPreparedAt = at;
      // This durable fact is written immediately before next() is invoked. A crash
      // can occur in between, so it is preparation, not proof that adapter code ran.
      // Adapters may make zero, one, or several HTTP attempts internally.
      call.httpAttempts = {observability:'unavailable', count:null, basis:'no-host-transport-event'};
    });
  }
  recordFirstResponse(id, callId, at = now()) {
    return this.edit(id, 'record-first-response', task => {
      const call = task.calls.find(c => c.id === callId);
      if (!call) throw new PolicyError('CALL_NOT_FOUND');
      if (call.endedAt !== null) return;
      call.firstResponseAt ??= at;
    });
  }
  recordUsage(id, callId, usage, at = now()) {
    return this.edit(id, 'record-usage', task => {
      const call = task.calls.find(c => c.id === callId);
      if (!call) throw new PolicyError('CALL_NOT_FOUND');
      if (call.endedAt !== null) return;
      const normalized = normalizeUsage(usage);
      if (!normalized) return;
      if (sameUsage(call.usage, normalized)) return;
      call.usage = normalized;
      call.usageStatus = 'partial';
      call.usageFirstObservedAt ??= at;
      call.usageObservedAt = at;
      call.usageObservationCount = (call.usageObservationCount ?? 0) + 1;
    });
  }
  finishCall(id, callId, outcome, usage, observation = {}) {
    return this.edit(id, 'finish-call', task => {
      const call = task.calls.find(c => c.id === callId);
      if (!call) throw new PolicyError('CALL_NOT_FOUND');
      // Stream cleanup and host replays may report the same terminal event more
      // than once. The first durable terminal observation wins.
      if (call.endedAt !== null) return;
      call.firstResponseAt ??= observation.firstResponseAt ?? null;
      const normalized = normalizeUsage(usage);
      if (normalized && !sameUsage(call.usage, normalized)) {
        call.usage = normalized;
        const observedAt = observation.usageObservedAt ?? observation.firstResponseAt ?? now();
        call.usageFirstObservedAt ??= observedAt;
        call.usageObservedAt = observedAt;
        call.usageObservationCount = (call.usageObservationCount ?? 0) + 1;
      }
      call.outcome = outcome;
      call.usageStatus = call.usage ? (observation.finishObserved === true ? 'final' : 'partial') : 'missing';
      call.endedAt = observation.endedAt ?? now();
      // Admissions are never refunded: a failed/aborted stream may already have cost money.
    });
  }
  cancel(id) { return this.edit(id, 'cancel', task => {
    const previousStatus = task.status;
    if (task.status === 'queued') {
      const endedAt = now(), attempt = currentAttempt(task);
      task.status = 'stopped'; task.endedAt = endedAt;
      task.artifact = null; task.failureCode = null; task.failureStage = null;
      if (attempt) {
        attempt.status = 'stopped'; attempt.endedAt = endedAt;
        attempt.callEnd = task.calls.length; attempt.artifact = null;
        attempt.failureCode = null; attempt.failureStage = null;
      }
    } else if (active(task.status)) {
      task.status = 'cancel-requested';
      const attempt = currentAttempt(task);
      if (attempt) attempt.status = 'cancel-requested';
    }
    return {previousStatus, task: structuredClone(task)};
  }); }
  recordTool(id, operation) {
    return this.edit(id, 'record-tool', task => {
      task.toolOperations ??= [];
      const attempt = currentAttempt(task);
      const value = {...operation, ...(attempt ? {attemptId: attempt.id} : {})};
      const prior = task.toolOperations.find(t => t.sessionId === operation.sessionId && t.seq === operation.seq);
      if (prior) {
        const {attemptId: _attemptId, ...update} = value;
        Object.assign(prior, update);
      }
      else task.toolOperations.push(value);
    });
  }
  recordApproval(id, operation) {
    return this.edit(id, 'record-approval', task => {
      task.approvalOperations ??= [];
      const attempt = currentAttempt(task);
      const value = {...operation, ...(attempt ? {attemptId: attempt.id} : {})};
      const prior = task.approvalOperations.find(item => item.sessionId === operation.sessionId && item.seq === operation.seq);
      if (prior) {
        const {attemptId: _attemptId, ...update} = value;
        Object.assign(prior, update);
      }
      else task.approvalOperations.push(value);
    });
  }
  finish(id, status, artifact, failureCode = null, failureStage = null) {
    return this.edit(id, 'finish', task => {
      const attempt = currentAttempt(task);
      const limitDenied = task.denials.some(denial => denial.code === 'TASK_CALL_LIMIT' &&
        (!attempt || denial.attemptId === attempt.id || (!denial.attemptId && attempt.kind === 'initial')));
      let finalStatus = task.status === 'cancel-requested' && status !== 'unknown' ? 'stopped'
        : status !== 'unknown' && limitDenied ? 'limited' : status;
      if (attempt?.kind === 'reconcile' && finalStatus === 'completed') finalStatus = 'reconciled';
      // A failed, cancelled or exhausted read-only review did not establish the
      // interrupted outcome. Keep the original task unknown while retaining the
      // precise terminal result on this reconciliation attempt.
      task.status = attempt?.kind === 'reconcile' && finalStatus !== 'reconciled' ? 'unknown' : finalStatus;
      task.artifact = ['completed', 'reconciled'].includes(finalStatus) ? artifact : null;
      task.endedAt = now(); task.failureCode = failureCode; task.failureStage = failureStage;
      if (attempt) {
        attempt.status = finalStatus; attempt.artifact = task.artifact; attempt.endedAt = task.endedAt;
        attempt.callEnd = task.calls.length; attempt.failureCode = failureCode; attempt.failureStage = failureStage;
      }
    });
  }
}

// Use host-owned lineage, never model text, to charge all descendants to their root.
export function taskOwner(sessionId, sessionHeader, roots) {
  const seen = new Set();
  while (sessionId && !seen.has(sessionId)) {
    if (roots.has(sessionId)) return roots.get(sessionId);
    seen.add(sessionId);
    const header = sessionHeader(sessionId);
    sessionId = header?.origin === 'subagent' ? header.parentSession : undefined;
  }
  return null;
}

// Missing/cyclic ancestry cannot establish an ordinary host session. Neither
// prompts nor request flags are identity evidence; read only host Sessions.
export function isOrdinaryHostSession(sessionId, sessionFor, gatewayPresets) {
  const seen = new Set();
  while (typeof sessionId === 'string' && sessionId && !seen.has(sessionId)) {
    if (sessionId.startsWith('gateway-agent-')) return false;
    seen.add(sessionId);
    const session = sessionFor(sessionId);
    if (!session?.header) return false;
    if (gatewayPresets.has(session.header.agentPreset) || session.snapshotEvents?.().some(event =>
      event.type === 'agent-preset/selected' && gatewayPresets.has(event.data?.agentPreset))) return false;
    if (session.header.origin !== 'subagent' && !session.header.parentSession) return true;
    sessionId = session.header.parentSession;
  }
  return false;
}
