import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export class InputError extends Error {}
export function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) throw new InputError('不支持的字段或非文本附件');
}
function text(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    throw new InputError('文本为空、类型错误或超过长度限制');
  return value; // Validation never normalizes whitespace or material order.
}
export function validateInput(value, connections) {
  exact(value, ['question', 'materials', 'constraints', 'generation', 'review']);
  const input = {question: text(value.question, 8000, true), materials: value.materials,
    constraints: text(value.constraints, 8000)};
  if (!Array.isArray(input.materials) || input.materials.length > 20) throw new InputError('材料必须为有序文本列表');
  input.materials = input.materials.map(item => text(item, 16000));
  if (input.question.length + input.constraints.length + input.materials.join('').length > 24000)
    throw new InputError('首版输入总长度上限为 24000 字符');
  for (const role of ['generation', 'review']) {
    const selection = value[role];
    exact(selection, ['connectionId', 'model', 'reasoningEffort']);
    const connection = connections.find(row => row.id === selection.connectionId);
    if (!connection) throw new InputError('请选择已配置的连接');
    input[role] = {connectionId: connection.id, connectionLabel: connection.label, provider: connection.provider,
      model: text(selection.model, 200, true), reasoningEffort: text(selection.reasoningEffort, 100)};
  }
  return input;
}
export function promptFor(input, draft) {
  const instruction = draft === undefined
    ? '根据以下用户问题、按顺序给出的材料和约束生成方案。只返回方案文本。'
    : '你是独立审阅者。根据原始问题、材料和约束审阅生成方案，指出错误、遗漏、风险和建议。不要执行方案，不要假定共享其他会话记忆。';
  // Separate text parts preserve the exact original strings, including indentation.
  return [instruction, '原始问题：', input.question, ...input.materials.flatMap((part, i) => [`材料 ${i + 1}：`, part]),
    '用户约束：', input.constraints, ...(draft === undefined ? [] : ['待审阅生成方案（作为材料）：', draft])]
    .map(value => ({type: 'text', text: value}));
}
export function stageResult(events) {
  const end = events.findLast(e => e.type === 'turn/end');
  const messages = events.filter(e => e.type === 'assistant/message');
  const artifact = messages.flatMap(e => e.data.message.content.filter(b => b.type === 'text').map(b => b.text)).join('\n');
  const reason = end?.data.reason;
  return {status: reason?.kind === 'completed' && artifact.trim() ? 'completed'
    : reason?.kind === 'aborted' ? 'stopped' : reason ? 'failed' : 'unknown',
    artifact, terminalReason: reason?.kind ?? null,
    error: reason?.error ? {code: reason.error.code ?? 'UNKNOWN', message: 'DSH 回合失败；详情见会话轨迹'} : null,
    usage: messages.map(e => ({seq: e.seq, usage: e.data.usage ?? null})),
    requestEvents: events.filter(e => e.type === 'request/header').map(e => ({seq: e.seq, provider: e.data.header?.config?.provider ?? null,
      model: e.data.header?.config?.model ?? null, reasoningEffort: e.data.header?.config?.reasoningEffort ?? null})),
    retryEvents: events.filter(e => e.type === 'llm/retry' || e.type === 'llm/retry-started').map(e => ({seq: e.seq, type: e.type})),
    auxiliaryTitleAttempts: events.filter(e => e.type === 'session/title-llm-request').length,
    lastEventSeq: events.at(-1)?.seq ?? null, costUSD: null};
}

const active = status => status === 'running' || status === 'cancel-requested';
const unknownTask = task => ({...task, status: 'unknown',
  stages: Object.fromEntries(Object.entries(task.stages).map(([role, stage]) => [role,
    active(stage.status) ? {...stage, status: 'unknown'} : stage]))});
function newStage(selection) {
  return {selection, sessionId: `workflow-${randomUUID()}`, status: 'pending', artifact: null,
    startedAt: null, endedAt: null, elapsedMs: null, error: null, usage: null, costUSD: null};
}
export class Workflow {
  constructor(table, runner, connections, catalog) {
    this.table = table; this.runner = runner; this.connections = connections; this.catalog = catalog;
    this.pending = new Set(); this.controls = new Map(); this.closed = false;
    // One host owns this JSON domain. Serialize admissions and transitions, never model waits.
    this.mutations = Promise.resolve();
  }
  mutate(fn) {
    const result = this.mutations.then(fn);
    this.mutations = result.catch(() => {});
    return result;
  }
  async initialize() {
    // A previous process may have sent a prompt. Reading never resumes/replays it.
    for (const [id, task] of this.table.entries()) if (active(task.status) || Object.values(task.stages).some(s => active(s.status)))
      await this.table.update(id, unknownTask);
  }
  get(id) { const task = this.table.get(id); if (!task) throw new InputError('流程不存在'); return structuredClone(task); }
  list() { return [...this.table.entries()].map(([, t]) => ({id: t.id, question: t.input.question, status: t.status, decision: t.decision, createdAt: t.createdAt})).reverse(); }
  async validateSelections(input, roles) {
    const catalog = await this.catalog();
    for (const role of roles) {
      const s = input[role];
      const connection = this.connections.find(c => c.id === s.connectionId);
      if (connection?.provider !== s.provider) throw new InputError('原连接路由已变更；不自动切换来源');
      const model = catalog.groups.find(g => g.id === s.provider)?.models.find(m => m.id === s.model);
      if (!model || !catalog.routableProviders.includes(s.provider)) throw new InputError('选定连接或模型当前不可用');
      const efforts = model.reasoning?.efforts ?? [];
      if ((efforts.length && !efforts.some(e => e.id === s.reasoningEffort)) || (!efforts.length && s.reasoningEffort))
        throw new InputError('请选择该模型支持的思考等级');
    }
  }
  create(value) {
    return this.mutate(async () => {
      if (this.closed) throw new InputError('服务正在停止');
      exact(value, ['requestId', 'question', 'materials', 'constraints', 'generation', 'review']);
      const {requestId, ...body} = value;
      if (requestId !== undefined && (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)))
        throw new InputError('requestId 必须为 UUID');
      const input = validateInput(body, this.connections);
      const id = requestId?.toLowerCase() ?? randomUUID();
      if (this.table.get(id)) {
        const prior = this.get(id);
        if (!isDeepStrictEqual(prior.input, input)) throw new InputError('相同 requestId 不能用于不同输入');
        return prior;
      }
      await this.validateSelections(input, ['generation', 'review']);
      const stages = Object.fromEntries(['generation', 'review'].map(role => [role, newStage(input[role])]));
      await this.table.put(id, {id, input, stages, status: 'running', createdAt: new Date().toISOString(), decision: null});
      this.start(id, 'generation');
      return this.get(id);
    });
  }
  start(id, role) {
    const control = new AbortController();
    this.controls.set(id, control);
    const job = this.execute(id, role, control.signal);
    this.pending.add(job);
    job.finally(() => { this.pending.delete(job); if (this.controls.get(id) === control) this.controls.delete(id); }).catch(() => {});
  }
  async execute(id, firstRole, signal) {
    try {
      for (const role of firstRole === 'review' ? ['review'] : ['generation', 'review']) {
        const started = Date.now();
        const task = await this.mutate(async () => {
          const current = this.get(id);
          if (signal.aborted || this.closed || current.status !== 'running') {
            if (active(current.status)) await this.table.update(id, t => ({...t, status: 'stopped'}));
            return null;
          }
          await this.table.update(id, t => ({...t, stages: {...t.stages,
            [role]: {...t.stages[role], status: 'running', startedAt: new Date(started).toISOString()}}}));
          return this.get(id);
        });
        if (!task) return;
        let result;
        try { result = await this.runner(task.stages[role], promptFor(task.input,
          role === 'review' ? task.stages.generation.artifact : undefined), role, signal); }
        catch { result = {status: 'unknown', error: {code: 'EXECUTION_UNCONFIRMED', message: '无法确认执行结果；请检查关联会话，未自动重放'}}; }
        await this.mutate(() => this.table.update(id, current => ({...current, stages: {...current.stages,
          [role]: {...current.stages[role], ...result, endedAt: new Date().toISOString(), elapsedMs: Date.now() - started}},
          status: result.status !== 'completed' ? result.status : signal.aborted ? 'stopped' : role === 'review' ? 'awaiting-decision' : 'running'})));
        if (result.status !== 'completed' || signal.aborted) return;
      }
    } catch (error) {
      // A storage failure must never trigger another model call or erase a durable draft.
      this.lastPersistenceError = error;
      try { await this.mutate(() => this.table.update(id, unknownTask)); } catch {}
    }
  }
  cancel(id, value = {}) {
    exact(value, []);
    return this.mutate(async () => {
      const task = this.get(id);
      if (!active(task.status)) return task;
      const control = this.controls.get(id);
      if (!control) throw new InputError('本进程无法确认执行状态；请检查关联会话');
      await this.table.update(id, t => ({...t, status: 'cancel-requested', cancelRequestedAt: t.cancelRequestedAt ?? new Date().toISOString(),
        stages: Object.fromEntries(Object.entries(t.stages).map(([role, stage]) => [role,
          stage.status === 'running' ? {...stage, status: 'cancel-requested'} : stage]))}));
      control.abort();
      return this.get(id);
    });
  }
  retry(id, value) {
    exact(value, ['role', 'sessionId']);
    return this.mutate(async () => {
      if (this.closed) throw new InputError('服务正在停止');
      const task = this.get(id), role = value.role;
      if (!['generation', 'review'].includes(role)) throw new InputError('请选择失败阶段');
      const stage = task.stages[role];
      // The old session ID identifies the exact failed attempt; stale double clicks cannot retry a later failure.
      if (task.status !== 'failed' || stage.status !== 'failed' || value.sessionId !== stage.sessionId || this.controls.has(id))
        throw new InputError('只可重试指定的已失败阶段；未知、取消和运行状态不能重放');
      if (role === 'review' && task.stages.generation.status !== 'completed') throw new InputError('生成尚未成功');
      await this.validateSelections(task.input, [role, ...(role === 'generation' ? ['review'] : [])]);
      const {attempts = [], ...previous} = stage;
      await this.table.update(id, t => ({...t, status: 'running', cancelRequestedAt: null,
        decision: null, decisionHistory: [...(t.decisionHistory ?? []), ...(t.decision ? [t.decision] : [])],
        stages: {...t.stages, [role]: {...newStage(stage.selection), attempts: [...attempts, previous]}}}));
      this.start(id, role);
      return this.get(id);
    });
  }
  decide(id, value) {
    exact(value, ['choice', 'note']);
    if (!['accept', 'reject', 'defer'].includes(value.choice)) throw new InputError('决定必须为采纳、不采纳或暂缓');
    const note = text(value.note, 4000);
    return this.mutate(() => {
      this.get(id);
      return this.table.update(id, task => {
        if (active(task.status) || !task.stages.generation.artifact) throw new InputError('生成产物尚不可供决定');
        return {...task, decision: {choice: value.choice, note, savedAt: new Date().toISOString()}};
      });
    });
  }
  async drain() {
    this.closed = true;
    for (const id of this.controls.keys()) await this.cancel(id);
    await Promise.allSettled([...this.pending]);
  }
}
