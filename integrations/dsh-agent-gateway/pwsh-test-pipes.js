import { fileURLToPath } from 'node:url';
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox';

export function withTestPipePreload(env = {}, inherited = process.env.NODE_OPTIONS) {
  const preload = fileURLToPath(new URL('./node-test-pipes.cjs', import.meta.url));
  const current = env.NODE_OPTIONS ?? inherited ?? '';
  return { ...env, NODE_OPTIONS: (current + ' --require ' + JSON.stringify(preload)).trim() };
}

// Retain the native executor's confinement, approval, cancellation and reporting.
export default class GatewayPwshExecutor extends SandboxPwshExecutor {
  spawnSpec(spec, ...rest) {
    const result = super.spawnSpec(spec, ...rest);
    if (process.platform === 'win32' && spec.sandboxPolicy?.mode === 'workspace-write')
      result.env = withTestPipePreload(result.env);
    return result;
  }
}
