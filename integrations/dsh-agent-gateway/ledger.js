import { randomUUID } from 'node:crypto';

export class PolicyError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const active = status => ['running', 'cancel-requested'].includes(status);
const now = () => new Date().toISOString();

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
  edit(id, fn) {
    return this.exclusive(async () => {
      const task = this.get(id);
      if (!task) throw new PolicyError('TASK_NOT_FOUND');
      const result = fn(task);
      await this.table.put(id, task);
      return result;
    });
  }
  async recover() {
    for (const task of this.list()) if (active(task.status)) await this.edit(task.id, t => {
      t.status = 'unknown';
      for (const call of t.calls) if (call.outcome === 'admitted') call.outcome = 'unknown';
    });
  }
  create({requestId, goal}, policy) {
    return this.exclusive(async () => {
      const prior = this.get(requestId);
      if (prior) {
        if (prior.goal !== goal) throw new PolicyError('REQUEST_ID_CONFLICT');
        return {task: prior, created: false};
      }
      const task = {id: requestId, sessionId: `gateway-agent-${requestId}`, goal,
        policy: structuredClone(policy), status: 'running', createdAt: now(), endedAt: null,
        calls: [], denials: [], artifact: null, toolOperations: []};
      await this.table.put(task.id, task);
      return {task: structuredClone(task), created: true};
    });
  }
  async admit(id, facts) {
    const result = await this.edit(id, task => {
      const matches = r => r.provider === facts.provider && r.model === facts.model;
      const route = task.policy.allowedRoutes.find(matches);
      const childRoutes = task.policy.allowedChildRoutes;
      const childRoute = facts.sessionId !== task.sessionId && childRoutes ? childRoutes.find(matches) : route;
      const code = task.status !== 'running' ? 'TASK_NOT_RUNNING'
        : !route || !childRoute ? 'ROUTE_NOT_AUTHORIZED'
        : [route, childRoute].some(r => r.reasoningEffort && r.reasoningEffort !== facts.reasoningEffort) ? 'REASONING_NOT_AUTHORIZED'
        : task.calls.length >= task.policy.maxCalls ? 'TASK_CALL_LIMIT' : null;
      if (code) {
        task.denials.push({...facts, code, at: now()});
        return {code};
      }
      const call = {...facts, id: randomUUID(), admittedAt: now(), endedAt: null, outcome: 'admitted', usage: null};
      task.calls.push(call);
      return {call};
    });
    if (result.code) throw new PolicyError(result.code);
    return result.call;
  }
  finishCall(id, callId, outcome, usage) {
    return this.edit(id, task => {
      const call = task.calls.find(c => c.id === callId);
      call.outcome = outcome; call.usage = usage; call.endedAt = now();
      // Admissions are never refunded: a failed/aborted stream may already have cost money.
    });
  }
  cancel(id) { return this.edit(id, task => { if (active(task.status)) task.status = 'cancel-requested'; }); }
  recordTool(id, operation) {
    return this.edit(id, task => {
      task.toolOperations ??= [];
      const prior = task.toolOperations.find(t => t.sessionId === operation.sessionId && t.seq === operation.seq);
      if (prior) Object.assign(prior, operation);
      else task.toolOperations.push(operation);
    });
  }
  finish(id, status, artifact, failureCode = null, failureStage = null) {
    return this.edit(id, task => {
      task.status = task.status === 'cancel-requested' && status !== 'unknown' ? 'stopped'
        : status !== 'unknown' && task.denials.some(d => d.code === 'TASK_CALL_LIMIT') ? 'limited' : status;
      task.artifact = task.status === 'completed' ? artifact : null;
      task.endedAt = now(); task.failureCode = failureCode; task.failureStage = failureStage;
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
