# llm-gateway

[中文](README.md) | **English**

A task plugin for compatible DSH Web hosts. Reuse the host's models, credentials, workspaces, tools and approvals. Manage tasks, root/child model selection, delegation, shared call limits, cancellation and explicit continuation without restricting ordinary host sessions.

## Installation

- **[Installation and usage guide](integrations/dsh-agent-gateway/README.en.md)**
- **[Download the v0.2.0 plugin](https://github.com/CalvinL10/llm-gateway/releases/tag/v0.2.0)**
- [v0.2.0 release notes](docs/releases/v0.2.0.en.md)

Download `llm-gateway-dsh-agent-gateway-0.2.0.tgz` and use native DSH `plugin --profile web add/remove` commands. Installation is disabled by default until authorized workspaces and policy are configured. It does not select accounts or start tasks automatically.

No repository clone, copied workbench, historical Home or legacy launcher is required.

## Source and installable package

The runtime source is in [integrations/dsh-agent-gateway](integrations/dsh-agent-gateway). The `v0.2.0` tag preserves the release source; `main` includes subsequent documentation updates.

GitHub's automatically generated Source code archives are source snapshots, not installable plugin packages. Install the release's `.tgz` asset instead. This documentation language-switch update does not change runtime code or replace the published package.

## Supported scope

- Acceptance covers Windows, loopback and compatible DSH Web. The tested CLI **0.1.5-rc.1** / service **0.1.5-rc.2** runtime includes **existing local modifications**. Matching version numbers alone do not guarantee compatibility with an unmodified upstream installation.
- Commands require an explicitly configured supported isolated executor. There is no unisolated host-shell fallback.
- Interrupted tasks become `unknown` after restart and are never replayed automatically.
- Installation, removal and task control in two independent Homes were checked using local scripted responses, without real model calls or Docker development commands. These checks do not establish complete business-task acceptance or cost savings.

[Third-party notices](THIRD_PARTY_NOTICES.md). Older experiments are historical context, not the current installation entry point.
