# llm-gateway

[中文](README.md) | **English**

A bounded multi-agent task gateway control-plane plugin for compatible **DeepSeek Harness (`dsh`) Web** hosts. It reuses the host's models, accounts, authorized workspaces, native tools, and approvals to provide a protected task dialog, root/child model scheduling, shared tree-level call & token budgets (`maxCalls` / `maxTotalTokens`), read-only prefix-cache telemetry (`prefixCache`), cancellation, explicit post-restart read-only reconciliation, a `gateway-otel-trace-v1` causal trace tree, and a deterministic `gateway-policy-sensor-v1` (`L1/L2/L3`) post-task audit, while leaving ordinary DSH sessions unrestricted. The [v0.2.1 release](docs/releases/v0.2.1.en.md) matches `main`.

**Plugin installation & usage**: see [Plugin Quickstart](integrations/dsh-agent-gateway/README.en.md) · [v0.2.1 Release Notes](docs/releases/v0.2.1.en.md).
**Architecture & roadmap**: see [System Architecture](docs/architecture.md) · [Option A Roadmap](PLAN.md) · [AI-Native Engineering Rules](AGENTS.md).

## Repository Layout

| Directory | Purpose |
| :--- | :--- |
| [integrations/dsh-agent-gateway/](integrations/dsh-agent-gateway/README.en.md) | `@llm-gateway/dsh-agent-gateway` shippable plugin core (8 root runtime modules + `presets/` + bilingual READMEs) |
| `integrations/dsh-agent-gateway/ops/` | Local managed service lifecycle (`lifecycle.mjs`), offline maintenance (`maintenance.mjs`), and offline cost attribution (`cost-report.mjs`) |
| `integrations/dsh-agent-gateway/smoke/` | Zero-credential HTTP/SSE smoke (`web-smoke.mjs`) and manual approval harness (`approval-manual.mjs`) |
| `integrations/dsh-agent-gateway/tests/` | Core security/state-machine/portability/sensor regression suites and `tests/ops/` operational tests |
| [docs/](docs/architecture.md) | [Architecture](docs/architecture.md), [Runbook](docs/runbook.md), [Local Use](docs/local-use.md), [History Snapshot](docs/history-snapshot.md), and [v0.2.1 Release Notes](docs/releases/v0.2.1.en.md) |
| [legacy/python-cache-experiment/](legacy/python-cache-experiment/README.md) | Archived Python FastAPI + Redis Singleflight L1 cache prototype (isolated from the DSH control plane) |

## Quick Verification

```powershell
# 1. Gateway core and ops regression (run serialized to prevent port/directory contention)
$core = Get-ChildItem -LiteralPath integrations/dsh-agent-gateway/tests -Filter '*.test.mjs' | Sort-Object Name | ForEach-Object FullName
$ops  = Get-ChildItem -LiteralPath integrations/dsh-agent-gateway/tests/ops -Filter '*.test.mjs' | Sort-Object Name | ForEach-Object FullName
node --test --test-concurrency=1 @core @ops

# 2. Zero-model HTTP/SSE smoke, documentation contract & shippable tarball boundary check
node integrations/dsh-agent-gateway/smoke/web-smoke.mjs --http
node --test docs/documentation.test.mjs
npm pack --dry-run ./integrations/dsh-agent-gateway
```

## Supported Scope & Honest Boundaries

- Acceptance covers **Windows, local `127.0.0.1` loopback, and compatible DSH Web hosts** only; cross-OS or public multi-tenant production readiness is not claimed.
- Command execution remains disabled unless a supported isolated executor (`executor: docker`) is explicitly configured; it never falls back to the unisolated host shell.
- Interrupted tasks converge to `unknown` on process restart with no automatic replay; explicit read-only `reconcile` is required first.
- Missing token `usage` stays `unknown`/`missing` (never zero-filled), and `businessOutcome` / `validation` remain `unverified` / `not-established` unless separately verified; see [History Snapshot](docs/history-snapshot.md) (full P01–P12 logs are preserved in tag `archive/p01-p12-history`).
- [Third-Party Notices](THIRD_PARTY_NOTICES.md).
