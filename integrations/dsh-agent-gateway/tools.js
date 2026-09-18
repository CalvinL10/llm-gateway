export const name = 'gateway-delegation-tools';
export const inject = ['tools'];
export const delegationTools = ['subagent', 'list_subagent_models'];
export const developmentRootTools = [...delegationTools, 'read', 'glob', 'grep', 'write', 'edit', 'pwsh'];
export const developmentChildTools = [...delegationTools, 'read', 'glob', 'grep'];
export const allowedTools = delegationTools;

export function toolsFor(mode = 'delegation', origin) {
  if (mode !== 'development') return delegationTools;
  return origin === 'subagent' ? developmentChildTools : developmentRootTools;
}

export function apply(ctx, config = {}) {
  const mode = config.mode ?? 'delegation';
  if (mode !== 'delegation' && mode !== 'development') throw new Error(`Unknown gateway tool mode: ${mode}`);
  // Native tools belong to the standing preset scope. Once an Agent joins it,
  // those definitions are inherited and can be narrowed in the Agent's own scope.
  // Restricting during preset mount would target its own (not yet ready) registry.
  ctx.on('agent/created', ({agent}) => {
    // Native spawn inherits the parent's sandbox; it pins only approval=never.
    // Narrow development children through the host's normal durable mode event.
    // Do not change the root, approval policy, workspace, or any dependency.
    if (mode === 'development' && agent.session.header?.origin === 'subagent')
      agent.session.append('sandbox/mode', {mode: 'read-only'});
    // modelSelectionSettings registers delegation tools in the Agent's own layer;
    // restrict() accepts only ancestor tools and leaves those local tools intact.
    agent.ctx.tools.restrict({allow: toolsFor(mode, agent.session.header?.origin)
      .filter(name => !delegationTools.includes(name))});
  });
  // Keep the monotonic execution guard as well as schema restrictions. Neither
  // changes the host's filesystem sandbox or approval pipeline.
  ctx.tools.guard(exec => toolsFor(mode, exec.agent?.session?.header?.origin).includes(exec.name)
    ? undefined : `Gateway tool is not permitted in ${mode} mode for this Agent`);
}

export function assertExecutionSafety(ctx, agent, policy = {toolSet: 'delegation'}) {
  const tools = ctx.agentPresets.serviceFor(agent, 'tools') ?? ctx.tools;
  const permissions = ctx.sessionProjections.stateOf(agent.session, 'permissions');
  const schemas = tools?.schemas(agent);
  // Native DSH children pin `never`: approval-requiring actions are REJECTED,
  // not automatically allowed (dsh-subagent captureDelegatedPolicyOverrides).
  // Preserve that stricter delegation policy; never change a root's ask policy.
  const delegated = agent.session.header?.origin === 'subagent';
  const approval = agent.session.snapshotEvents?.().findLast(e => e.type === 'approval/policy');
  const approvalSafe = delegated
    ? permissions?.approval === 'never' && approval?.data.source === 'delegation'
    : permissions?.approval === 'ask';
  const permitted = toolsFor(policy.toolSet, agent.session.header?.origin);
  if (!schemas || !permitted.every(name => schemas.some(t => t.name === name)) ||
      schemas.some(t => !permitted.includes(t.name)) ||
      permissions?.sandbox !== (policy.toolSet === 'development' && !delegated ? 'workspace-write' : 'read-only') || !approvalSafe)
    throw new Error('Gateway requires the configured tool set, scoped sandbox and native root/child approval policies');
}
