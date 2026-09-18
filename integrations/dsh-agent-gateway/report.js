// Reporting only: no model calls, command parsing, retries or scheduling decisions.
const names = new Set(['read', 'glob', 'grep', 'edit', 'write', 'pwsh', 'subagent', 'list_subagent_models']);
const errorCodes = new Set(['FS_SANDBOX_DENIED', 'FS_NOT_FOUND', 'FS_STALE_VERSION',
  'SEARCH_FAILED', 'SANDBOX_UNAVAILABLE', 'TOOL_ABORTED', 'TOOL_ABORTED_BEFORE_DISPATCH',
  'UNKNOWN_TOOL', 'INVALID_TOOL_OUTPUT']);
export const safeToolName = name => names.has(name) ? name : 'other';
export const safeToolError = code => errorCodes.has(code) ? code : 'TOOL_FAILED';

export function toolEvent(sessionId, event, events) {
  if (event.type === 'tool/call') return {sessionId, seq: event.seq,
    name: safeToolName(event.data.name), outcome: 'pending'};
  if (event.type !== 'tool/result') return null;
  const block = event.data.message?.content?.find(b => b.type === 'tool-result');
  const call = events.find(e => e.type === 'tool/call' &&
    event.sourceEventSeqs?.includes(e.seq) && e.data.callId === block?.toolCallId);
  if (!call || !block) return null;
  return {sessionId, seq: call.seq, name: safeToolName(call.data.name), resultSeq: event.seq,
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

export function taskReport(task) {
  const tools = task.toolOperations ?? [];
  const terminal = !['running', 'cancel-requested'].includes(task.status);
  const limitDenied = task.denials.some(d => d.code === 'TASK_CALL_LIMIT');
  const ref = op => ({sessionId: op.sessionId, seq: op.seq, name: op.name,
    outcome: op.outcome, ...(op.resultSeq !== undefined ? {resultSeq: op.resultSeq} : {}),
    ...(op.errorCode ? {errorCode: op.errorCode} : {}),
    ...(op.exitCode !== undefined ? {exitCode: op.exitCode} : {})});
  return {
    executionStatus: task.status,
    stopReason: task.status === 'unknown' ? 'EXECUTION_UNCONFIRMED'
      : task.status === 'stopped' ? 'CANCELLED'
      : task.status === 'limited' ? 'TASK_CALL_LIMIT'
      : task.status === 'completed' ? 'TURN_COMPLETED'
      : task.status === 'failed' ? 'EXECUTION_FAILED' : null,
    businessOutcome: 'unverified', validation: 'not-established',
    needsUserDecision: terminal,
    evidenceCoverage: task.toolOperations === undefined ? 'unavailable' : 'recorded-events',
    budget: {used: task.calls.length, maxCalls: task.policy.maxCalls,
      remaining: Math.max(0, task.policy.maxCalls - task.calls.length), limitDenied},
    modelCalls: task.calls.reduce((counts, call) => {
      const key = ['stop', 'tool-calls'].includes(call.outcome) ? 'returned'
        : ['error', 'aborted'].includes(call.outcome) ? 'failedOrAborted' : 'unconfirmed';
      counts[key]++; return counts;
    }, {returned: 0, failedOrAborted: 0, unconfirmed: 0}),
    confirmedFileChanges: tools.filter(t => ['edit', 'write'].includes(t.name) && t.outcome === 'succeeded').map(ref),
    failedOperations: tools.filter(t => t.outcome === 'failed').map(ref),
    unconfirmedOperations: tools.filter(t => ['pending', 'unknown'].includes(t.outcome)).map(ref),
    commandOperations: tools.filter(t => t.name === 'pwsh').map(ref),
    toolCounts: {succeeded: tools.filter(t => t.outcome === 'succeeded').length,
      failed: tools.filter(t => t.outcome === 'failed').length,
      unconfirmed: tools.filter(t => ['pending', 'unknown'].includes(t.outcome)).length}
  };
}

export function publicTask(task) {
  if (!task) return null;
  // Legacy limited records may contain concatenated intermediate claims.
  return {...task, artifact: task.status === 'completed' ? task.artifact : null, report: taskReport(task)};
}
