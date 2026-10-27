# llm-gateway

[中文](README.md) | **English**

Subscription account connections and independent main/child model settings for **DSH 0.2.1-rc.3**. Use ordinary new conversations alongside native DeepSeek and custom API providers.

## Installation

- **[Installation and usage guide](integrations/dsh-subscriptions/README.en.md)**
- **[Download v0.3.0-rc.1 candidate](https://github.com/CalvinL10/llm-gateway/releases/tag/v0.3.0-rc.1)**
- [Release notes and verification scope](docs/releases/v0.3.0-rc.1.en.md)

Paste the release asset URL for `llm-gateway-dsh-subscriptions-0.3.0-rc.1.tgz` into DSH's Add Plugin input. Restart when prompted, open Settings → 订阅连接与模型设置, connect your Codex / ChatGPT, Antigravity or Claude account, save model choices and create an ordinary conversation. Installing does not sign in or change model defaults.

No repository clone, copied workbench, historical Home or legacy launcher is required.

## Source and installable package

The new source is in [integrations/dsh-subscriptions](integrations/dsh-subscriptions). Set a default child model and permit per-delegation choices across subscription, DeepSeek and other API providers. Independent child routing uses native spawn subagents; fork and external-product subagents retain their host settings.

GitHub's automatically generated Source code archives are source snapshots, not installable plugin packages. Install the release's `.tgz` asset instead.

## Supported scope

- Windows tests use an isolated native **0.2.1-rc.3** runtime: install/remove, ordinary sessions, independent child defaults, mixed providers and restart persistence. A headless browser checks the native settings page. The installed desktop backend also loads the plugin in an isolated test profile.
- **Desktop URL installation, desktop transport and real account sign-in/model calls remain unverified.** Controlled local responses do not establish subscription availability, quota billing or long-term compatibility.
- Community adapters retain their original authorization and credential protection. This package is not endorsed by the model providers.

## Legacy task plugin

[v0.2.0](https://github.com/CalvinL10/llm-gateway/releases/tag/v0.2.0) task pages, call limits, cancellation and continuation remain documented in the [legacy guide](integrations/dsh-agent-gateway/README.en.md). That plugin targets a locally modified DSH 0.1.5 runtime and **has not been ported to 0.2.1 in this candidate**. Ordinary conversations do not require it.

[Third-party notices](THIRD_PARTY_NOTICES.md). Older experiments are historical context, not the current installation entry point.
