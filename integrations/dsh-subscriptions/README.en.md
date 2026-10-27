# DSH subscription connections and main/child model settings

[中文](README.md) | **English**

Target: Windows Desktop / Web, **DSH 0.2.1-rc.3**. This candidate registers
Codex / ChatGPT, Antigravity and Claude community connections in the native
model catalog. DeepSeek and other API providers remain managed by DSH.

## Install and use

Paste the [v0.3.0-rc.1 package URL](https://github.com/CalvinL10/llm-gateway/releases/download/v0.3.0-rc.1/llm-gateway-dsh-subscriptions-0.3.0-rc.1.tgz)
into Add Plugin, or use an absolute path to the downloaded `.tgz`. Leave the
installation registry at its default. The repository homepage and GitHub's
Source code archives are not this installable package.

Restart when prompted. Open Settings → 订阅连接与模型设置 and sign in to your
accounts. Refresh the catalog, save the main model, default child model and
allowed child choices, then create an ordinary conversation. Installation
does not sign in or change existing defaults.

Native spawn subagents use the child defaults; an explicit model choice for
an individual delegation takes precedence. Fork and external-product agents
retain their own host settings. Saving does not rewrite running sessions.
If a multi-setting save partially fails, refresh to inspect the saved state.

Expired logins and exhausted quotas are reported by the connection; this
package does not automatically switch to API-key billing. Community access
is subject to provider conditions and is not a guarantee of subscription
billing, official endorsement or continued access.

## Verification and legacy functionality

An isolated native 0.2.1-rc.3 Web runtime on Windows passed install/remove,
ordinary conversations, independent child routing, mixed providers, a real
local HTTP API, restart persistence, authorization/origin checks and headless
browser UI checks. Original adapters passed controlled protocol tests.
The installed desktop backend, Electron Node and plugin installer also pass
installation/startup checks in an isolated test profile, without opening a
window or reading existing user accounts.

**Desktop URL installation, desktop transport and real account login/model
calls remain unverified.** No live subscription quota was used by these tests.
See `docs/releases/v0.3.0-rc.1.en.md` in the source repository for details.

The old task plugin remains in `integrations/dsh-agent-gateway`. Its task UI
has not been ported to 0.2.1 in this candidate and is not required here.

## Development

Install development dependencies, then run `npm run build` and `npm test`.
The build downloads pinned upstream source 0.42.0 and retains its license.
Alternatively set `DSH_SUBSCRIPTION_SOURCE` to that source directory.
Builds do not read account credentials. Runtime installation does not build
or download source. Set `DSH_TEST_RUNTIME` to an installed 0.2.1-rc.3 npm
runtime for host tests; `DSH_DESKTOP_ROOT` points to a desktop installation.
`DSH_BROWSER_PREVIEW` points to the isolated preview's
private URL file for browser tests. These environment-dependent tests report
a skip when the required runtime or preview is absent.
