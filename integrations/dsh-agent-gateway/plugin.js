import {fileURLToPath} from 'node:url';
import {apply as applyGateway, inject} from './index.js';

export {inject};
export const name = 'llm-gateway-plugin';

export async function apply(ctx, config) {
  // Supported DSH exposes discovery roots. Add our package only: never replace
  // the host roster/default, write Home presets or copy tools into a release.
  const roots = ctx.agentPresets?.roots;
  if (!Array.isArray(roots) || Object.isFrozen(roots))
    throw new Error('llm-gateway requires DSH agentPresets.roots (mutable discovery roots); use the documented compatible DSH Web runtime');
  for (const [service, method] of [['agentPresets','serviceFor'], ['sessionProjections','stateOf'],
    ['sessionController','resolveAgent'], ['workspaceRegistry','create'], ['storageDomain','open']]) {
    if (typeof ctx[service]?.[method] !== 'function')
      throw new Error(`llm-gateway missing compatible host service: ${service}.${method}`);
  }
  if (!config?.policy || (!config?.workspaces && !config?.cwd))
    throw new Error('llm-gateway: configure policy and workspaces (or cwd) in the web profile before enabling gateway-agent-tasks');
  const {executor, ...gatewayConfig} = config;
  if (executor !== undefined && executor !== 'docker')
    throw new Error('llm-gateway: executor must be omitted (commands disabled) or explicitly set to docker');
  if (executor && config.policy.toolSet !== 'development')
    throw new Error('llm-gateway: executor requires policy.toolSet: development');
  const root = {path:fileURLToPath(new URL('./presets/', import.meta.url)), trust:'system'};
  roots.unshift(root);
  const remove = () => { const i = roots.indexOf(root); if (i !== -1) roots.splice(i, 1); };
  try {
    const suffix = executor === 'docker' ? '-docker' : '';
    const agentPreset = config.policy.agentPreset ?? (config.policy.toolSet === 'development'
      ? (config.policy.delegationEnabled === false ? 'llm-gateway-single' : 'llm-gateway-delegate') + suffix
      : 'llm-gateway-text');
    const scheduling = config.scheduling && {
      singlePreset:'llm-gateway-single' + suffix, delegationPreset:'llm-gateway-delegate' + suffix,
      ...config.scheduling,
    };
    // This flag is presentation only. The actual preset guard checks its own
    // executor and permissions for every dispatch; no host-shell fallback.
    const dockerPresets = new Set(['llm-gateway-single-docker', 'llm-gateway-delegate-docker']);
    const configuredDocker = dockerPresets.has(agentPreset) && (!scheduling ||
      [scheduling.singlePreset, scheduling.delegationPreset].every(id => dockerPresets.has(id)));
    await applyGateway(ctx, {...gatewayConfig, ...(scheduling ? {scheduling} : {}),
      policy:{...config.policy, agentPreset}}, {allowHostSessions:true,
      commandExecution:configuredDocker ? 'enabled' : 'disabled'});
    ctx.on('dispose', remove);
  } catch (error) { remove(); throw error; }
}
