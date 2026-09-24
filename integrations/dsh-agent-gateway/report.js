// Reporting only: no model calls, command parsing, retries or scheduling decisions.
const names = new Set(['read', 'glob', 'grep', 'edit', 'write', 'pwsh', 'subagent', 'list_subagent_models']);
const errorCodes = new Set(['FS_SANDBOX_DENIED', 'FS_NOT_FOUND', 'FS_STALE_VERSION',
  'SEARCH_FAILED', 'SANDBOX_UNAVAILABLE', 'TOOL_ABORTED', 'TOOL_ABORTED_BEFORE_DISPATCH',
  'UNKNOWN_TOOL', 'INVALID_TOOL_OUTPUT']);
export const safeToolName = name => names.has(name) ? name : 'other';
export const safeToolError = code => errorCodes.has(code) ? code : 'TOOL_FAILED';
const approvalOutcomes = new Set(['allowed-once', 'rejected', 'cancelled', 'unavailable']);
const tokenFields = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens',
  'cacheWriteTokens', 'reasoningTokens'];
const safePurposes = new Set(['compaction', 'session-title', 'planning', 'review']);

export const usageSemantics = Object.freeze({
  schema: 'dsh-provider-neutral-token-usage',
  inputTokens: 'uncached input only',
  cacheTokens: 'cacheReadTokens and cacheWriteTokens are disjoint from inputTokens',
  totalTokens: 'full-call provider aggregate when present; never add cache or reasoning fields to it',
  reasoningTokens: 'detail counter whose inclusion in outputTokens/totalTokens is adapter-specific unless separately evidenced',
  missing: 'unknown, not zero',
});

function safeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = {};
  for (const key of tokenFields) if (Number.isSafeInteger(value[key]) && value[key] >= 0) usage[key] = value[key];
  return Object.keys(usage).length ? usage : null;
}

const safePurpose = value => value === null || value === undefined || value === ''
  ? null : safePurposes.has(value) ? value : 'custom';

function callSource(call) {
  const sessionRole = call.sessionRole ?? (call.parentSessionId ? 'child' : 'root');
  const purpose = safePurpose(call.auxiliaryPurpose ?? call.purpose ?? null);
  return {kind:call.source ?? (purpose ? 'auxiliary' : sessionRole), sessionRole, purpose};
}

function callAudit(call) {
  const hasCurrentBoundary = call.adapterBoundaryPreparedAt !== null && call.adapterBoundaryPreparedAt !== undefined;
  const hasLegacyBoundary = !hasCurrentBoundary && call.dispatchStartedAt !== null && call.dispatchStartedAt !== undefined;
  const adapterBoundaryPreparedAt = hasCurrentBoundary ? call.adapterBoundaryPreparedAt
    : hasLegacyBoundary ? call.dispatchStartedAt : null;
  const adapterBoundaryBasis = hasCurrentBoundary ? 'durable-preparation-immediately-before-next-invocation'
    : hasLegacyBoundary ? 'legacy-dispatch-field-projected-as-boundary-preparation' : 'not-prepared';
  const httpAttempts = call.httpAttempts ?? (adapterBoundaryPreparedAt === null
    ? {observability:'unknown',count:null,basis:'legacy-record'}
    : {observability:'unavailable',count:null,basis:'legacy-record'});
  return {id:call.id, measurementKind:call.measurementKind ?? 'llm-stream-admission',
    ...(call.attemptId ? {attemptId:call.attemptId} : {}),
    sessionId:call.sessionId, parentSessionId:call.parentSessionId ?? null,
    source:callSource(call), logicalRoute:{provider:call.provider, model:call.model,
      reasoningEffort:call.reasoningEffort ?? null},
    admittedAt:call.admittedAt, adapterBoundaryPreparedAt, adapterBoundaryBasis,
    firstResponseAt:call.firstResponseAt ?? null, firstResponseBasis:'first-adapter-chunk',
    endedAt:call.endedAt ?? null, outcome:call.outcome,
    httpAttempts:{observability:httpAttempts.observability, count:httpAttempts.count,
      basis:httpAttempts.basis}, usageStatus:call.usageStatus ?? (call.usage ? 'unknown' : 'missing'),
    usageFirstObservedAt:call.usageFirstObservedAt ?? call.usageObservedAt ?? null,
    usageObservedAt:call.usageObservedAt ?? null,
    usageObservationCount:call.usageObservationCount ?? (call.usage ? 1 : 0), usage:safeUsage(call.usage)};
}

function toolRef(op) {
  return {sessionId: op.sessionId, seq: op.seq, name: safeToolName(op.name),
    ...(op.attemptId ? {attemptId:op.attemptId} : {}), outcome: op.outcome,
    ...(op.turn !== undefined ? {turn:op.turn} : {}), ...(op.step !== undefined ? {step:op.step} : {}),
    ...(op.startedAt ? {startedAt:op.startedAt} : {}), ...(op.endedAt ? {endedAt:op.endedAt} : {}),
    ...(op.resultSeq !== undefined ? {resultSeq: op.resultSeq} : {}),
    ...(op.errorCode ? {errorCode: safeToolError(op.errorCode)} : {}),
    ...(op.exitCode !== undefined ? {exitCode: op.exitCode} : {})};
}

function approvalRef(op) {
  return {sessionId: op.sessionId, seq: op.seq, name: safeToolName(op.name),
    ...(op.attemptId ? {attemptId:op.attemptId} : {}), outcome: op.outcome,
    ...(op.askedAt ? {askedAt:op.askedAt} : {}), ...(op.decidedAt ? {decidedAt:op.decidedAt} : {}),
    ...(op.decisionSeq !== undefined ? {decisionSeq: op.decisionSeq} : {})};
}

const eventTime = event => {
  if (!Number.isFinite(event?.time)) return undefined;
  const date = new Date(event.time);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

// Approval arguments and reasons remain in the native session.  The task page
// gets only enough audit metadata to locate the exact one-shot decision.
export function approvalEvent(sessionId, event, events) {
  if (event.type === 'approval/asked') return {sessionId, seq: event.seq,
    name: safeToolName(event.data.toolName), outcome: 'pending',
    ...(eventTime(event) ? {askedAt:eventTime(event)} : {})};
  if (event.type !== 'approval/decided') return null;
  const asked = events.find(e => e.type === 'approval/asked' && e.data.id === event.data.id && e.seq < event.seq);
  if (!asked) return null;
  return {sessionId, seq: asked.seq, name: safeToolName(asked.data.toolName), decisionSeq: event.seq,
    outcome: approvalOutcomes.has(event.data.outcome) ? event.data.outcome : 'unavailable',
    ...(eventTime(asked) ? {askedAt:eventTime(asked)} : {}),
    ...(eventTime(event) ? {decidedAt:eventTime(event)} : {})};
}

export function toolEvent(sessionId, event, events) {
  if (event.type === 'tool/call') return {sessionId, seq: event.seq,
    name: safeToolName(event.data.name), outcome: 'pending',
    ...(event.data.turn !== undefined ? {turn:event.data.turn} : {}),
    ...(event.data.step !== undefined ? {step:event.data.step} : {}),
    ...(eventTime(event) ? {startedAt:eventTime(event)} : {})};
  if (event.type !== 'tool/result') return null;
  const block = event.data.message?.content?.find(b => b.type === 'tool-result');
  const call = events.find(e => e.type === 'tool/call' &&
    event.sourceEventSeqs?.includes(e.seq) && e.data.callId === block?.toolCallId);
  if (!call || !block) return null;
  return {sessionId, seq: call.seq, name: safeToolName(call.data.name), resultSeq: event.seq,
    ...(call.data.turn !== undefined ? {turn:call.data.turn} : {}),
    ...(call.data.step !== undefined ? {step:call.data.step} : {}),
    ...(eventTime(call) ? {startedAt:eventTime(call)} : {}),
    ...(eventTime(event) ? {endedAt:eventTime(event)} : {}),
    // Native pwsh isError=false also covers non-zero exit. Its structured value
    // is available at tools/result, not in the persisted rendered text event.
    ...(block.isError === true ? {outcome: 'failed', errorCode: safeToolError(event.data.error?.code)}
      : block.isError === false && call.data.name !== 'pwsh' ? {outcome: 'succeeded'} : {})};
}

export function commandResult(value) {
  if (value?.kind !== 'foreground') return {outcome: 'unknown'};
  const exitCode = Number.isSafeInteger(value.exitCode) ? value.exitCode : null;
  const interrupted = value.aborted === true || value.timedOut === true || !!value.signal;
  const denied = value.sandbox?.denied === true || value.sandbox?.runnerFailed === true;
  return {outcome: interrupted || denied || (exitCode !== null && exitCode !== 0) ? 'failed'
    : exitCode === 0 ? 'succeeded' : 'unknown', exitCode,
    ...(interrupted ? {errorCode: 'COMMAND_INTERRUPTED'} : denied ? {errorCode: 'SANDBOX_UNAVAILABLE'}
      : exitCode !== null && exitCode !== 0 ? {errorCode: 'COMMAND_EXIT_NONZERO'} : {})};
}

export function finalAssistantText(events) {
  const end = events.findLast(e => e.type === 'turn/end');
  if (end?.data.reason?.kind !== 'completed') return null;
  const message = events.findLast(e => e.type === 'assistant/message' && e.seq < end.seq && e.data.turn === end.data.turn);
  const content = message?.data.message?.content ?? [];
  if (content.some(b => b.type === 'tool-call')) return null;
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n') || null;
}

function lifecycleReport(task, observation) {
  if (observation) return observation;
  const terminal = !['queued', 'running', 'cancel-requested'].includes(task.status);
  return {
    state: task.status === 'queued' ? 'queued'
      : task.status === 'running' ? 'executing'
      : task.status === 'cancel-requested' ? 'canceling'
      : task.status === 'unknown' && task.endedAt === null ? 'unknown-after-restart' : 'ended',
    localOutcome: terminal && task.endedAt !== null ? task.status : null,
    persistence: 'confirmed',
    stopConfirmation: task.status === 'stopped' ? 'confirmed' : task.status === 'unknown' ? 'unconfirmed' : null,
  };
}

export function taskReport(task, lifecycle) {
  const tools = task.toolOperations ?? [];
  const approvals = task.approvalOperations ?? [];
  const terminal = !['queued', 'running', 'cancel-requested'].includes(task.status);
  const attempts = task.attempts ?? [];
  const latestAttempt = attempts.at(-1);
  const limitDenied = task.denials.some(d => d.code === 'TASK_CALL_LIMIT' &&
    (!latestAttempt || d.attemptId === latestAttempt.id || (!d.attemptId && latestAttempt.kind === 'initial')));
  const usage = task.calls.map(call => ({status:call.usageStatus ?? (call.usage ? 'unknown' : 'missing'),
    value:safeUsage(call.usage)}));
  const tokenTotals = Object.fromEntries(tokenFields.map(field => {
    const reported = usage.filter(item => item.value?.[field] !== undefined);
    const final = reported.filter(item => item.status === 'final');
    const partial = reported.filter(item => item.status === 'partial');
    const unknown = reported.filter(item => item.status === 'unknown');
    return [field, {
      observedSum:reported.reduce((sum, item) => sum + item.value[field], 0),
      reportedCalls:reported.length,
      finalSum:final.reduce((sum, item) => sum + item.value[field], 0), finalReportedCalls:final.length,
      partialObservedSum:partial.reduce((sum, item) => sum + item.value[field], 0),
      partialReportedCalls:partial.length,
      unknownObservedSum:unknown.reduce((sum, item) => sum + item.value[field], 0),
      unknownReportedCalls:unknown.length,
    }];
  }));
  const http = task.calls.map(call => call.httpAttempts);
  return {
    executionStatus: task.status,
    lifecycle: lifecycleReport(task, lifecycle),
    stopReason: task.status === 'unknown' ? 'EXECUTION_UNCONFIRMED'
      : task.status === 'stopped' ? 'CANCELLED'
      : task.status === 'limited' ? 'TASK_CALL_LIMIT'
      : task.status === 'reconciled' ? 'STATE_RECONCILED'
      : task.status === 'completed' ? 'TURN_COMPLETED'
      : task.status === 'failed' ? 'EXECUTION_FAILED' : null,
    businessOutcome: 'unverified', validation: 'not-established',
    needsUserDecision: terminal,
    evidenceCoverage: task.toolOperations === undefined ? 'unavailable' : 'recorded-events',
    budget: {used: task.calls.length, maxCalls: task.policy.maxCalls,
      initialMaxCalls:attempts[0]?.budgetAfter ?? task.policy.maxCalls,
      addedCalls:attempts.reduce((total, attempt) => total + (attempt.additionalCalls ?? 0), 0),
      remaining: Math.max(0, task.policy.maxCalls - task.calls.length), limitDenied,
      everLimitDenied:task.denials.some(value => value.code === 'TASK_CALL_LIMIT')},
    attempts:attempts.map(attempt => ({id:attempt.id, kind:attempt.kind, status:attempt.status,
      startedAt:attempt.startedAt, endedAt:attempt.endedAt, callStart:attempt.callStart, callEnd:attempt.callEnd,
      additionalCalls:attempt.additionalCalls, budgetBefore:attempt.budgetBefore, budgetAfter:attempt.budgetAfter,
      failureCode:attempt.failureCode, failureStage:attempt.failureStage, artifact:attempt.artifact,
      ...(attempt.reconciliationEvidence ? {reconciliationEvidence:attempt.reconciliationEvidence} : {})})),
    modelCalls: task.calls.reduce((counts, call) => {
      const key = ['stop', 'tool-calls'].includes(call.outcome) ? 'returned'
        : ['error', 'aborted'].includes(call.outcome) ? 'failedOrAborted' : 'unconfirmed';
      counts[key]++; return counts;
    }, {returned: 0, failedOrAborted: 0, unconfirmed: 0}),
    observations:{admissions:task.calls.length,
      adapterBoundaryPreparations:task.calls.filter(call => call.adapterBoundaryPreparedAt ?? call.dispatchStartedAt).length,
      firstResponses:task.calls.filter(call => call.firstResponseAt).length,
      sources:{root:task.calls.filter(call => callSource(call).kind === 'root').length,
        child:task.calls.filter(call => callSource(call).kind === 'child').length,
        auxiliary:task.calls.filter(call => callSource(call).kind === 'auxiliary').length},
      sessionRoles:{root:task.calls.filter(call => callSource(call).sessionRole === 'root').length,
        child:task.calls.filter(call => callSource(call).sessionRole === 'child').length},
      httpAttempts:{observed:http.filter(value => value?.observability === 'observed')
        .reduce((sum, value) => sum + (value.count ?? 0), 0),
        knownZeroBeforeBoundaryPreparation:http.filter(value => value?.observability === 'bounded' && value.count === 0).length,
        unobservableCalls:http.filter(value => value?.observability === 'unavailable').length,
        unknownLegacyCalls:http.filter(value => !value || value.observability === 'unknown').length},
      usage:{final:usage.filter(item => item.status === 'final').length,
        partial:usage.filter(item => item.status === 'partial').length,
        missing:usage.filter(item => item.status === 'missing').length,
        unknown:usage.filter(item => item.status === 'unknown').length,
        tokenTotals, semantics:usageSemantics}},
    approvalOperations: approvals.map(approvalRef),
    approvalCounts: {pending: approvals.filter(value => value.outcome === 'pending').length,
      allowedOnce: approvals.filter(value => value.outcome === 'allowed-once').length,
      rejected: approvals.filter(value => value.outcome === 'rejected').length,
      cancelledOrUnavailable: approvals.filter(value => ['cancelled','unavailable'].includes(value.outcome)).length},
    toolOperations: tools.map(toolRef),
    confirmedFileChanges: tools.filter(t => ['edit', 'write'].includes(t.name) && t.outcome === 'succeeded').map(toolRef),
    failedOperations: tools.filter(t => t.outcome === 'failed').map(toolRef),
    unconfirmedOperations: tools.filter(t => ['pending', 'unknown'].includes(t.outcome)).map(toolRef),
    commandOperations: tools.filter(t => t.name === 'pwsh').map(toolRef),
    toolCounts: {succeeded: tools.filter(t => t.outcome === 'succeeded').length,
      failed: tools.filter(t => t.outcome === 'failed').length,
      unconfirmed: tools.filter(t => ['pending', 'unknown'].includes(t.outcome)).length}
  };
}

export function auditTask(task, lifecycle) {
  const attempts = task.attempts ?? [];
  return {id:task.id, sessionId:task.sessionId, workspaceId:task.workspaceId ?? 'default',
    status:task.status, createdAt:task.createdAt, endedAt:task.endedAt ?? null,
    failureCode:task.failureCode ?? null, failureStage:task.failureStage ?? null,
    lifecycle:lifecycleReport(task, lifecycle),
    attempts:attempts.map(attempt => ({id:attempt.id, kind:attempt.kind, status:attempt.status,
      startedAt:attempt.startedAt, endedAt:attempt.endedAt, callStart:attempt.callStart, callEnd:attempt.callEnd,
      failureCode:attempt.failureCode, failureStage:attempt.failureStage})),
    calls:task.calls.map(callAudit),
    denials:task.denials.map(denial => ({...(denial.attemptId ? {attemptId:denial.attemptId} : {}),
      sessionId:denial.sessionId, parentSessionId:denial.parentSessionId ?? null,
      logicalRoute:{provider:denial.provider, model:denial.model, reasoningEffort:denial.reasoningEffort ?? null},
      purpose:safePurpose(denial.purpose), code:denial.code, at:denial.at})),
    tools:(task.toolOperations ?? []).map(toolRef), approvals:(task.approvalOperations ?? []).map(approvalRef)};
}

export function auditExport(tasks, lifecycles = new Map()) {
  return {format:'gateway-agent-audit-v1', usageSemantics,
    tasks:tasks.map(task => auditTask(task, lifecycles.get(task.id)))};
}

export function publicTask(task, lifecycle) {
  if (!task) return null;
  const status = lifecycle?.state === 'ended-local' && lifecycle.persistence === 'unconfirmed' ? 'unknown'
    : lifecycle?.state === 'canceling' && task.status === 'running' ? 'cancel-requested' : task.status;
  const view = status === task.status ? task : {...task, status};
  // Attempt instructions are user/model input and stay in the durable ledger;
  // expose only the redacted report projection to the task page/API.
  const {attempts: _attempts, ...publicView} = view;
  // Legacy limited records may contain concatenated intermediate claims.
  return {...publicView, calls:view.calls.map(call => {
    const purpose = safePurpose(call.auxiliaryPurpose ?? call.purpose ?? null);
    return {...call, purpose,
      ...(call.auxiliaryPurpose !== undefined ? {auxiliaryPurpose:purpose} : {}), usage:safeUsage(call.usage)};
  }), denials:view.denials.map(denial => ({...denial, purpose:safePurpose(denial.purpose)})),
    artifact: ['completed','reconciled'].includes(status) ? view.artifact : null,
    report: taskReport(view, lifecycle)};
}
