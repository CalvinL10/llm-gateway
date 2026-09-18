import { randomUUID } from 'node:crypto';
import { stageResult } from './workflow.js';

export function dshRunner(ctx, cwd) {
  return async (stage, content, role, signal = new AbortController().signal) => {
    const api = ctx.sessionController;
    const notStarted = () => ({status: 'stopped', terminalReason: 'not-started', artifact: null});
    let agent, admissionStarted = false, stop;
    try {
      if (signal.aborted) return notStarted();
      const created = await api.create({sessionId: stage.sessionId, cwd, agentPreset: 'text-only'});
      if (created.sessionId !== stage.sessionId || created.agentPreset !== 'text-only') throw new Error('Text-only preset unavailable');
      const resolved = await api.resolveAgent(stage.sessionId);
      if (resolved.error) throw resolved.error;
      agent = resolved.agent;
      const tools = ctx.agentPresets.serviceFor(agent, 'tools') ?? ctx.tools;
      const permissions = ctx.sessionProjections.stateOf(agent.session, 'permissions');
      if (!tools || tools.schemas(agent).length || permissions?.sandbox !== 'read-only' || permissions?.approval !== 'ask')
        throw new Error('Workflow requires zero tools, read-only sandbox and approval');
      // An explicit local title suppresses automatic title generation, including on an older live profile.
      await api.rename({sessionId: stage.sessionId, title: role === 'generation' ? '工作流 · 生成方案' : '工作流 · 独立审阅'});
      const {provider, model, reasoningEffort} = stage.selection;
      const selected = (await api.selectModel({sessionId: stage.sessionId, provider, model,
        ...(reasoningEffort ? {reasoningEffort} : {})})).selected;
      if (selected.provider !== provider || selected.model !== model || (selected.reasoningEffort ?? '') !== reasoningEffort)
        throw new Error('DSH changed requested selection');
      if (signal.aborted) return notStarted();
      // Controller.cancel keeps the inbox. This workflow owns its dedicated Agent and drops
      // queued input instead: cancelling must never leave an automatically resumable prompt.
      stop = () => agent.cancel({kind: 'user'}, {keepInbox: false});
      signal.addEventListener('abort', stop, {once: true});
      admissionStarted = true;
      await api.prompt({requestId: randomUUID(), sessionId: stage.sessionId, mode: 'queue', content}, signal);
      // Cancellation may race asynchronous prompt admission; cancel again after its acknowledgement.
      if (signal.aborted) stop();
      await agent.whenIdle();
      const result = stageResult(agent.session.snapshotEvents());
      return signal.aborted && result.status === 'unknown' && !result.requestEvents.length
        ? {...result, status: 'stopped', terminalReason: 'not-started'} : result;
    } catch {
      if (!admissionStarted) return signal.aborted ? notStarted() : {status: 'failed',
        error: {code: 'PREPARATION_FAILED', message: '会话准备或安全检查失败；未提交模型请求，请检查宿主配置'}};
      // A rejected admission can be ambiguous. Do not label it safely retryable.
      if (agent) { agent.cancel({kind: 'user'}, {keepInbox: false}); await agent.whenIdle(); }
      return {status: 'unknown', error: {code: 'EXECUTION_UNCONFIRMED', message: '提交或执行结果无法确认；未自动重放'}};
    } finally { if (stop) signal.removeEventListener('abort', stop); }
  };
}
