# llm-gateway plugin: installation and usage

[中文](README.md) | **English**

[Download v0.2.0](https://github.com/CalvinL10/llm-gateway/releases/tag/v0.2.0)

Install the same package into separate compatible DSH Web Homes. Each instance uses its own host providers, credentials, authorized workspaces, and storage. No account copying, automatic task execution, or second DSH installation is required.

The new `./plugin` entry coexists with ordinary host sessions. The default `.` entry retains the strict dedicated-host behavior for existing deployments.

## 1. Requirements and installation

Supported scope: Windows, local loopback (`127.0.0.1`), and a compatible DSH Web installation with Node and pnpm already available.

**The tested local runtime uses CLI 0.1.5-rc.1 and service packages 0.1.5-rc.2 with existing local modifications. Matching version numbers alone do not establish compatibility with an unmodified upstream installation. This release does not bundle that runtime.**

The host must supply agentPresets discovery roots/serviceFor, sessions, sessionController, sessionProjections, workspaceRegistry, storageDomain, native tools/approvals, and Web authentication. Missing services must be resolved in the host, not by bypassing permissions.

Download `llm-gateway-dsh-agent-gateway-0.2.0.tgz` from the release above, **not** GitHub's automatically generated Source code archive. Save it to the example directory below or adjust the path. A repository clone is unnecessary.

```powershell
$env:DSH_HOME = 'F:\my-dsh-home'  # Current terminal only; choose a different Home for another instance
dsh plugin --profile web add F:\packages\llm-gateway-dsh-agent-gateway-0.2.0.tgz --config.auto-install-peers=false
```

The bundle adds a **disabled** `gateway-agent-tasks` entry. Installation does not select accounts, authorize directories, or call a model. Dependencies come from the existing host; investigate missing peer dependencies rather than installing another runtime automatically.

## 2. Configure and enable

Add this override to `profiles/web/cordis.patch.yml` inside the selected Home. Replace the directory and provider/model placeholders with existing host values you explicitly authorize. Keep unrelated profile entries intact. A patch's `config` replaces the entire configuration rather than merging it deeply.

```yaml
- id: gateway-agent-tasks
  disabled: false
  config:
    workspaces:
      - id: work
        label: My project
        cwd: 'F:\work\my-project'
    policy:
      toolSet: development
      delegationEnabled: false
      root: { provider: YOUR_PROVIDER, model: YOUR_MODEL }
      allowedRoutes:
        - { provider: YOUR_PROVIDER, model: YOUR_MODEL }
      maxCalls: 8
    scheduling:
      roots:
        - { provider: YOUR_PROVIDER, model: YOUR_MODEL }
      children: []
```

For delegation, list explicitly authorized child provider/model pairs in `scheduling.children`, then select delegation and child models on the task page. Without scheduling, set `policy.delegationEnabled: true`, configure `allowedChildRoutes`, and include those routes in `allowedRoutes`.

The entire task tree shares the call limit. This is a call count, not a monetary budget. `authorizedTaskMaxCalls` can explicitly list selectable limits. `authorizedContinuationCallIncrements` defaults to an empty list, so continuing cannot silently increase the budget. Native approvals remain in force; the plugin does not approve on your behalf.

### Optional isolated command execution

Without an executor, authorized workspace file access remains available, but **command execution is disabled**. There is no fallback to the unisolated host shell.

If Docker, a compatible PowerShell Linux image, and its execution configuration already exist, explicitly add `executor: docker` under `config`. This selects the packaged `llm-gateway-single-docker` / `llm-gateway-delegate-docker` presets. Their Docker shell is scoped to those presets and does not replace the ordinary host shell.

Configure the host process with `DSH_GATEWAY_DOCKER_IMAGE`, `DSH_GATEWAY_DOCKER_PROFILE` (standard/browser), and optionally `DSH_GATEWAY_DOCKER_PATH`. The plugin does not install Docker or pull images automatically. An enabled indicator means a supported executor was selected, not that the daemon, image, or a development command has been verified. Execution failures are reported without unsafe fallback.

Custom policy/scheduling presets must provide equivalent executor isolation and gateway tool protection.

## 3. Start and use

```powershell
dsh web --host 127.0.0.1 --port 3084 --no-open
```

Open the local login link printed by DSH; do not share its token. Open the task entry (currently Chinese UI), select a workspace, root/child models and call limit, then submit a goal. Results, native approvals, cancellation, continuation and supplemental instructions remain available. Ordinary DSH sessions stay host-managed.

The API remains `/api/gateway-agent-tasks`. Unauthenticated and invalid-origin requests are rejected. Interrupted tasks become `unknown` after restart and are **not replayed automatically**. Explicit read-only reconciliation is required before deciding whether to continue.

## 4. Remove or restore

Finish/cancel active gateway tasks and stop the host. Remove your `gateway-agent-tasks` configuration override, then run:

```powershell
dsh plugin --profile web remove @llm-gateway/dsh-agent-gateway
dsh web --host 127.0.0.1 --port 3084 --no-open
```

Removal does not erase the Home, tasks, preferences, or accounts. Reinstall a compatible plugin to read historical gateway tasks; do not open gateway-preset sessions while the plugin is absent.

To restore a previous version, reinstall the explicitly retained package, restore its configuration, and use the same Home. Never copy credentials into another Home as a recovery shortcut. Native DSH commands are sufficient; no historical workbench launcher or release directory is required. Identify a port owner before addressing a conflict; never kill an unknown process.

## Verification scope

The same package was installed and removed through native DSH commands in two independent Homes. Local scripted model responses exercised ordinary-session coexistence, separate data/preferences, results, delegation, shared limits, approvals, cancellation, continuation, and restart without replay.

**No real model calls or Docker development commands were used for this acceptance.** These checks establish installation and control flow, not complete real-model development capability or cost savings. The package contains no runtime, tests, historical Homes, experiment reports, or credentials.
