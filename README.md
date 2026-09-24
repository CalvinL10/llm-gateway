# llm-gateway

**DSH Web task plugin / DSH Web 任务插件**

Reuse the host's models, credentials, workspaces, tools and approvals. The plugin provides task pages, root/child model selection, delegation, shared call limits, cancellation and explicit continuation without restricting ordinary host sessions.

复用宿主模型、账号、工作区、工具与审批，提供任务页面、根/子模型选择、委派、共享限额、取消和显式继续；普通宿主会话不受网关误拦截。

## Install / 安装

- **[中文安装教程](integrations/dsh-agent-gateway/README.md)**
- **[English installation guide](integrations/dsh-agent-gateway/README.en.md)**
- **[Download v0.2.0 / 下载插件包](https://github.com/CalvinL10/llm-gateway/releases/tag/v0.2.0)**

Use the release's `.tgz` asset with native `dsh plugin --profile web add/remove`. Installation is disabled by default until you configure authorized workspaces and policy. No repository clone, copied Home, or historical launcher is needed.

下载 Release 中的 `.tgz`，通过 DSH 原生插件命令安装；首次默认未启用，配置授权工作区和策略后再启用。无需复制整个工作台或历史 Home。

## Scope / 支持范围

- Windows, loopback, compatible DSH Web. Tested against a **locally modified** CLI 0.1.5-rc.1 / service 0.1.5-rc.2 runtime; unmodified upstream installations are not certified. 当前只验收该本机兼容组合，不承诺任意发行版。
- Commands require an explicitly configured supported isolated executor; there is no unisolated host-shell fallback. 命令执行需要显式配置隔离执行器。
- Interrupted tasks become `unknown`; restart never replays them automatically. 重启不自动重放任务。
- Two-Home installation/removal and task control were checked with local scripted responses, not real model calls or Docker development commands. 不把接入验证当作真实业务验收。

[Third-party notices / 第三方归属](THIRD_PARTY_NOTICES.md). Older repository materials are historical context, not the installation entry point for this release.
