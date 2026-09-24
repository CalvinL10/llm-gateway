import {lstatSync, realpathSync, readdirSync} from 'node:fs';
import {resolve, relative, isAbsolute, sep, parse} from 'node:path';
import {fileURLToPath} from 'node:url';

export const name = 'gateway-delegation-tools';
export const inject = ['tools', 'sessionProjections', 'shell'];
export const delegationTools = ['subagent', 'list_subagent_models'];
export const developmentRootTools = [...delegationTools, 'read', 'glob', 'grep', 'write', 'edit', 'pwsh'];
export const developmentChildTools = [...delegationTools, 'read', 'glob', 'grep'];
// Unknown-task reconciliation is intentionally local and read-only: spawning a child can
// add new side effects before the interrupted task's state has been established.
export const reconciliationTools = ['read', 'glob', 'grep'];
export const allowedTools = delegationTools;
// Process-local dispatch state must not be inferred from a sandbox mode that
// ordinary delegation tasks also use. The durable attempt remains in the ledger.
const reconciliationSessions = new WeakSet();
const baseRestrictions = new WeakMap();
export function enterReconciliation(agent) {
  const session = agent.session;
  const base = baseRestrictions.get(session);
  // A delegation root has no file tools in normal turns. Release only its own
  // scope restriction, replacing it synchronously with the narrower read-only
  // scope. The guard remains active independently of model-visible schemas.
  if (base?.mode === 'delegation') base.release();
  let release;
  try {
    release = agent.ctx.tools.restrict({allow:reconciliationTools});
    reconciliationSessions.add(session);
  } catch (error) {
    if (base?.mode === 'delegation') base.release = base.tools.restrict({allow:[]});
    throw error;
  }
  return () => {
    if (base?.mode === 'delegation') base.release = base.tools.restrict({allow:[]});
    reconciliationSessions.delete(session);
    release();
  };
}

const protectedNames = new Set(['.git', '.hg', '.svn', '.local', '.ssh', '.aws', '.azure', '.kube',
  '.codex', '.agents', '.npmrc', '.netrc', '.pypirc', '.credentials', '.credentials.yaml',
  '.credentials.yml', 'credentials.json', 'id_rsa', 'id_ed25519']);
const privateName = name => protectedNames.has(name.toLowerCase()) || /^\.env(?:\.|$)/i.test(name) || /\.(?:pem|p12|pfx|key)$/i.test(name);
const inside = (root, path) => {const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));};
const pathDenial = 'Gateway path denied: use a regular, non-sensitive file inside the authorized workspace';
const searchDenial = 'Gateway search denied: choose a narrower directory without protected files, links or host state';
export const shellDenial = 'Gateway shell disabled: the current backend does not isolate host reads, credentials and network; an isolated executor is required';

export function commandExecutionCapability(shell) {
  return shell?.dockerExecutor === true ? 'enabled' : 'disabled';
}

// The native Windows sandbox is WRITE_RESTRICTED, not read/network isolation.
// This is a narrower capability boundary, never a command-string allowlist or an escalation fallback.
export function developmentPathDenial(exec, hostRoots = [process.env.DSH_HOME, fileURLToPath(new URL('.', import.meta.url))].filter(Boolean), executor = undefined) {
  if (exec.name === 'pwsh' && executor?.dockerExecutor !== true) return shellDenial;
  if (exec.arguments?.sandbox_permissions !== undefined) return 'Gateway sandbox escalation is not permitted by the authorized task scope';
  if (!['read', 'glob', 'grep', 'write', 'edit'].includes(exec.name)) return;
  try {
    const cwd = exec.agent?.session?.header?.cwd;
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) return pathDenial;
    const root = realpathSync.native(cwd);
    const search = ['glob', 'grep'].includes(exec.name);
    const input = search ? exec.arguments?.path ?? '.' : exec.arguments?.file_path;
    if (typeof input !== 'string' || !input.trim() || /[\x00-\x1f]/.test(input) || /^(?:\\\\|\/\/)/.test(input)) return pathDenial;
    const parts = input.replaceAll('\\', '/').split('/');
    // Refuse ambiguous Win32 spellings (ADS, device names, drive-relative names, trailing dots/spaces)
    // before normalization can erase a symlink-sensitive `..` component.
    if (parts.some((part, i) => part === '..' || (part !== '.' && /[. ]$/.test(part)) ||
      (/[:]/.test(part) && !(i === 0 && /^[a-z]:$/i.test(part) && /^[a-z]:[\\/]/i.test(input))) ||
      /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) return pathDenial;
    const target = resolve(cwd, input);
    if (!inside(root, target)) return pathDenial;
    const protectedRoots = hostRoots.map(p => {try {return realpathSync.native(p);} catch {return resolve(p);}});
    const safe = path => {
      if (!inside(root, path) || relative(root, path).split(sep).some(privateName) ||
          protectedRoots.some(p => inside(p, path))) return false;
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink > 1))) return false;
        const canonical = realpathSync.native(path);
        return inside(root, canonical) && !relative(root, canonical).split(sep).some(privateName) &&
          !protectedRoots.some(p => inside(p, canonical));
      } catch (error) {if (error?.code === 'ENOENT') return true; throw error;}
    };
    // Check every ancestor as well as the leaf; do not follow junctions or aliases into host state.
    let cursor = parse(target).root;
    for (const part of target.slice(cursor.length).split(sep).filter(Boolean)) {
      cursor = resolve(cursor, part);
      if (inside(root, cursor) && !safe(cursor)) return pathDenial;
    }
    if (search) {
      // Native search can include hidden/ignored files. Never inspect their content to decide safety.
      // Conservatively deny a mixed tree; callers can select a clean source subdirectory instead.
      const pending = [target]; let inspected = 0;
      while (pending.length) {
        const path = pending.pop();
        if (++inspected > 20000 || !safe(path)) return searchDenial;
        let stat; try {stat = lstatSync(path);} catch (error) {if (error?.code === 'ENOENT') continue; throw error;}
        if (stat.isDirectory()) for (const entry of readdirSync(path)) pending.push(resolve(path, entry));
      }
    }
  } catch {return pathDenial;}
}

export function toolsFor(mode = 'delegation', origin, reconcile = false, delegationEnabled = true) {
  if (reconcile) return reconciliationTools;
  if (mode !== 'development') return delegationTools;
  const tools = origin === 'subagent' ? developmentChildTools : developmentRootTools;
  return delegationEnabled ? tools : tools.filter(name => !delegationTools.includes(name));
}

export function modelVisibleToolsFor(mode = 'delegation', origin, reconcile = false, delegationEnabled = true) {
  const permitted = toolsFor(mode, origin, reconcile, delegationEnabled);
  // DSH registers delegation tools in the Agent-local scope, below the global
  // restriction layer. They remain visible during reconciliation, while the
  // dispatch guard still denies them in a root read-only reconciliation turn.
  return reconcile && delegationEnabled ? [...new Set([...permitted, ...delegationTools])] : permitted;
}

export function apply(ctx, config = {}) {
  const mode = config.mode ?? 'delegation';
  if (mode !== 'delegation' && mode !== 'development') throw new Error(`Unknown gateway tool mode: ${mode}`);
  const delegationEnabled = config.delegationEnabled ?? true;
  if (typeof delegationEnabled !== 'boolean' || (!delegationEnabled && mode !== 'development'))
    throw new Error('Disabling delegation requires development mode');
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
    const allowed = toolsFor(mode, agent.session.header?.origin, false, delegationEnabled)
      .filter(name => !delegationTools.includes(name));
    const release = agent.ctx.tools.restrict({allow:allowed});
    baseRestrictions.set(agent.session, {mode, tools:agent.ctx.tools, release});
  });
  // Keep the monotonic execution guard as well as schema restrictions. Neither
  // changes the host's filesystem sandbox or approval pipeline.
  ctx.tools.guard(exec => {
    const delegated = exec.agent?.session?.header?.origin === 'subagent';
    const reconciling = !delegated && reconciliationSessions.has(exec.agent?.session);
    if ((!delegationEnabled && delegated) ||
        !toolsFor(mode, exec.agent?.session?.header?.origin, reconciling, delegationEnabled).includes(exec.name))
      return `Gateway tool is not permitted in ${mode} mode for this Agent`;
    if (mode !== 'development' && !reconciling) return;
    const permissionDenial = 'Gateway execution permissions unavailable or changed; tool dispatch denied';
    try {
      const permissions = ctx.sessionProjections.stateOf(exec.agent?.session, 'permissions');
      const approval = delegated && exec.agent?.session?.snapshotEvents?.().findLast(e => e.type === 'approval/policy');
      // A native read-only root is a narrower development session, not a reason
      // to widen its sandbox. It may only dispatch the three local read tools.
      const readOnlyRoot = !delegated && !reconciling && mode === 'development' && permissions?.sandbox === 'read-only';
      if (readOnlyRoot && !reconciliationTools.includes(exec.name)) return permissionDenial;
      if ((reconciling && !reconciliationTools.includes(exec.name)) ||
          permissions?.sandbox !== (delegated || reconciling || readOnlyRoot || mode === 'delegation' ? 'read-only' : 'workspace-write') ||
          permissions?.approval !== (delegated ? 'never' : 'ask') ||
          (delegated && approval?.data.source !== 'delegation')) return permissionDenial;
    } catch {
      // Native tools materialize thrown messages into model-visible results. Do not echo projection internals.
      return permissionDenial;
    }
    if (mode !== 'development' && !reconciling) return undefined;
    let shell;
    try {
      // DSH injects ctx.shell only for the real executor; some offline callers
      // intentionally omit that dependency and must remain fail-closed.
      shell = ctx.shell;
    } catch {
      shell = undefined;
    }
    return developmentPathDenial(exec, undefined, shell);
  });
}

export function assertExecutionSafety(ctx, agent, policy = {toolSet: 'delegation'}, {reconcile = false} = {}) {
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
  if (delegated && policy.delegationEnabled === false) throw new Error('Gateway delegation is disabled');
  const permitted = toolsFor(policy.toolSet, agent.session.header?.origin, reconcile, policy.delegationEnabled);
  // Host scope-local delegation registrations cannot be masked by tools.restrict(), which
  // only intersects global tools. They may remain model-visible during reconciliation,
  // but the monotonic guard above denies every non-reconciliation dispatch.
  const visible = modelVisibleToolsFor(policy.toolSet, agent.session.header?.origin, reconcile, policy.delegationEnabled);
  const sandbox = reconcile || (!delegated && policy.toolSet === 'development' && permissions?.sandbox === 'read-only') ? 'read-only'
    : policy.toolSet === 'development' && !delegated ? 'workspace-write' : 'read-only';
  if (!schemas || !permitted.every(name => schemas.some(t => t.name === name)) ||
      schemas.some(t => !visible.includes(t.name)) || permissions?.sandbox !== sandbox || !approvalSafe)
    throw new Error('Gateway requires the configured tool set, scoped sandbox and native root/child approval policies');
}
