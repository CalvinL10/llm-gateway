import {SandboxPwshExecutor} from '@deepseek-ai/dsh-pwsh-sandbox';
import {
  buildDockerArgv, dockerDenialSignatures, dockerImageFromEnv, dockerRunnerFailureRules,
  safeDockerCliEnv, dockerProfileFromEnv,
} from './docker-executor-spec.mjs';

/**
 * DSH PowerShell executor backed by a pre-validated Docker image. This module
 * never falls back to host pwsh: a missing daemon/image is surfaced as the
 * sandbox runner failure handled by SandboxPwshExecutor.
 */
export default class GatewayDockerPwshExecutor extends SandboxPwshExecutor {
  dockerExecutor = true;

  constructor(ctx, config) {
    super(ctx, config);
    this.dockerProfile = dockerProfileFromEnv();
    this.dockerImage = dockerImageFromEnv();
  }

  confine(spec, policy) {
    return {
      argv: buildDockerArgv({
        argv: this.argv(spec),
        workspaceRoot: policy.workspaceRoot,
        workdir: spec.workdir,
        mode: policy.mode,
        image: this.dockerImage,
        profile: this.dockerProfile,
        dockerPath: process.env.DSH_GATEWAY_DOCKER_PATH || 'docker',
      }),
      enforcement: 'full',
      denialSignatures: dockerDenialSignatures,
      runnerFailureRules: dockerRunnerFailureRules,
    };
  }

  spawnSpec(spec, ...rest) {
    const result = super.spawnSpec(spec, ...rest);
    result.cwd = spec.sandboxPolicy.workspaceRoot;
    result.env = safeDockerCliEnv();
    return result;
  }
}
