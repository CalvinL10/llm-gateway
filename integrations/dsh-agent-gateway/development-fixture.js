// Test-only scripted adapter. Loaded only in an isolated, credential-free Home.
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
export const name = 'gateway-development-fixture';
export const inject = ['llm', 'connection', 'agents', 'sessionProjections', 'approval'];
const text = value => ({type: 'text', text: value});
const tool = (id, name, args) => ({type: 'tool-call', id, name, arguments: JSON.stringify(args)});
function responseFor({goal, isChild, results, step}) {
  const has = id => results.some(r => r.toolCallId === id);
  if (goal === 'development mount probe') return [text('DEVELOPMENT_READY')];
  if (goal.startsWith('budget report ')) {
    if (goal.startsWith('budget report edit') && step === 2)
      return [tool('budget-2', 'edit', {file_path: 'seed.txt', old_string: 'BEFORE', new_string: 'BUDGET_EDITED'})];
    return [text('INTERMEDIATE_NOT_A_FINAL_REPORT'), tool('budget-' + step, 'read', {
      file_path: goal.startsWith('budget report failure') && step === 8 ? 'missing-budget.txt' : 'seed.txt'})];
  }
  if (goal === 'command failure report') return has('nonzero') ? [text('MODEL_CLAIMS_SUCCESS')] : [
    tool('nonzero', 'pwsh', {command: 'exit 7', description: 'Synthetic nonzero exit', timeoutMs: 10000})];
  if (goal === 'development approval workflow') {
    if (!has('approval-allowed-once')) return [
      tool('approval-no-escalation', 'write', {file_path: '../outside-no-escalation.txt', content: 'must not write'}),
      tool('approval-unapproved', 'write', {file_path: '../outside-unapproved.txt', content: 'must not write',
        sandbox_permissions: 'danger-full-access', justification: 'SYNTHETIC_UNAVAILABLE: no approval available'}),
      tool('approval-rejected', 'write', {file_path: '../outside-rejected.txt', content: 'must not write',
        sandbox_permissions: 'danger-full-access', justification: 'SYNTHETIC_REJECT: synthetic rejection'}),
      tool('approval-allowed-once', 'write', {file_path: '../outside-allowed-once.txt', content: 'ALLOWED_ONCE_WRITTEN\n',
        sandbox_permissions: 'danger-full-access', justification: 'SYNTHETIC_ALLOW_ONCE: synthetic single allow'})
    ];
    if (!has('approval-second-attempt')) return [
      tool('approval-second-attempt', 'write', {file_path: '../outside-second-attempt.txt', content: 'must not write without new approval'})
    ];
    return [text('DEVELOPMENT_APPROVALS_VERIFIED')];
  }
  if (goal === 'development shell probe') {
    if (!has('shell-read')) return [tool('shell-read', 'read', {file_path: 'shell-seed.txt'})];
    if (!has('root-pwsh')) return [
      tool('root-pwsh', 'pwsh', {command: "Write-Output 'PWSH_READY'", description: 'Print a fixture marker', timeoutMs: 10000})
    ];
    // Commands may invalidate a prior observation. Refresh it; never bypass the stale-file check.
    if (!has('shell-reread')) return [tool('shell-reread', 'read', {file_path: 'shell-seed.txt'})];
    if (!has('shell-edit')) return [tool('shell-edit', 'edit', {file_path: 'shell-seed.txt', old_string: 'SHELL_BEFORE', new_string: 'SHELL_AFTER'})];
    return [text('SHELL_PROBE_FINISHED')];
  }
  if (isChild) return has('child-read') ? [text('CHILD_READ_ONLY')] : [
    tool('child-read', 'read', {file_path: 'seed.txt'}),
    tool('child-glob', 'glob', {pattern: '*.txt'}),
    tool('child-grep', 'grep', {pattern: 'AFTER', include: '*.txt'}),
    // Intentionally request hidden capabilities: native dispatch must refuse them.
    tool('child-write', 'write', {file_path: 'child-created.txt', content: 'not allowed'}),
    tool('child-edit', 'edit', {file_path: 'seed.txt', old_string: 'AFTER', new_string: 'not allowed'}),
    tool('child-pwsh', 'pwsh', {command: "Set-Content -LiteralPath child-shell.txt -Value 'not allowed'", description: 'Must not execute'})
  ];
  if (!has('root-read')) return [
    tool('root-read', 'read', {file_path: 'seed.txt'}),
    tool('root-glob', 'glob', {pattern: '*.txt'}),
    tool('root-grep', 'grep', {pattern: 'BEFORE', include: '*.txt'}),
    tool('unread-write', 'write', {file_path: 'unread.txt', content: 'must remain unchanged'}),
    // This target is outside the SESSION workspace, but still inside the test's repo-local directory.
    tool('outside-write', 'write', {file_path: '../outside.txt', content: 'must not be written'})
  ];
  if (!has('root-edit')) return [
    tool('root-edit', 'edit', {file_path: 'seed.txt', old_string: 'BEFORE', new_string: 'AFTER'}),
    tool('root-write', 'write', {file_path: 'created.txt', content: 'CREATED_BY_NATIVE_TOOL\n'})
  ];
  if (!has('child')) return [
    tool('verify-edit', 'read', {file_path: 'seed.txt'}),
    tool('verify-write', 'read', {file_path: 'created.txt'}),
    tool('child', 'subagent', {description: 'Read only fixture inspection', prompt: 'development child fixture',
      provider: 'fixture-development', model: 'scripted'})
  ];
  return [text('DEVELOPMENT_FILES_VERIFIED')];
}
export function apply(ctx) {
  const calls = [], attempts = [], syntheticApprovals = [];
  ctx.on('approval/request', async function (req, next) {
    const reason = req.reason ?? '';
    if (reason.includes('SYNTHETIC_REJECT')) {
      syntheticApprovals.push({toolName: req.toolName, reason, outcome: 'rejected', synthetic: true});
      return 'rejected';
    }
    if (reason.includes('SYNTHETIC_ALLOW_ONCE')) {
      syntheticApprovals.push({toolName: req.toolName, reason, outcome: 'allowed-once', synthetic: true});
      return 'allowed-once';
    }
    if (reason.includes('SYNTHETIC_UNAVAILABLE')) {
      syntheticApprovals.push({toolName: req.toolName, reason, outcome: 'unavailable', synthetic: true});
      return 'unavailable';
    }
    return next();
  }, {prepend: true});
  const observe = options => {
    const agent = ctx.agents.get(options.sessionId), events = agent.session.snapshotEvents();
    return {sessionId: options.sessionId, parentSessionId: agent.session.header.parentSession ?? null,
      cwd: agent.session.header.cwd, origin: agent.session.header.origin ?? null,
      permissions: ctx.sessionProjections.stateOf(agent.session, 'permissions'),
      approvalSource: events.findLast(e => e.type === 'approval/policy')?.data.source,
      tools: (options.tools ?? []).map(t => t.name).sort()};
  };
  ctx.on('llm/stream', async function* (options, next) {
    attempts.push(observe(options)); yield* next();
  });
  class Fixture extends LlmAdapter {
    async listModels(provider) { return [{provider, id: 'scripted', name: 'Zero-model development fixture'}]; }
    async *stream(options) {
      const facts = observe(options);
      const results = options.messages.flatMap(m => m.content).filter(b => b.type === 'tool-result');
      const goal = options.messages.filter(m => m.role === 'user' && m.source?.kind !== 'tool')
        .flatMap(m => m.content).filter(b => b.type === 'text').map(b => b.text).join('\n');
      // Only synthetic fixture text exists in this test Home; never mount this observer in production.
      calls.push({...facts, results});
      const step = ctx.agents.get(options.sessionId).session.snapshotEvents().filter(e => e.type === 'tool/call').length + 1;
      const output = responseFor({goal, isChild: facts.origin === 'subagent', results, step});
      for (const [index, block] of output.entries()) {
        yield {type: 'block-start', index, blockType: block.type};
        if (block.type === 'text') yield {type: 'text-delta', index, text: block.text};
        yield {type: 'block-end', index, block};
      }
      yield {type: 'finish', reason: {kind: output.some(b => b.type === 'tool-call') ? 'tool-calls' : 'stop'}};
    }
  }
  ctx.llm.registerAdapter(['fixture-development'], new Fixture());
  ctx.connection.fetch.register({path: '/api/development-fixture', methods: ['GET'], requestBody: 'buffered',
    fetch: async () => Response.json({calls, attempts, syntheticApprovals})});
}
