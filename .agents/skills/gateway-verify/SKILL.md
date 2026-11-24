---
name: gateway-verify
description: Run reproducible verification, bundle boundary inspection, zero-model smoke, and documentation contract checks for llm-gateway.
---

# Gateway Verification SOP

Use this skill when verifying changes across `integrations/dsh-agent-gateway/`, `docs/`, or `legacy/python-cache-experiment/`.

## 1. Full Gateway Node Regression (Serialized)
Always run Node gateway suites with `--test-concurrency=1` to avoid temporary directory/port/ACL collisions:
```powershell
$core = Get-ChildItem -LiteralPath integrations/dsh-agent-gateway/tests -Filter '*.test.mjs' | Sort-Object Name | ForEach-Object FullName
$ops  = Get-ChildItem -LiteralPath integrations/dsh-agent-gateway/tests/ops -Filter '*.test.mjs' | Sort-Object Name | ForEach-Object FullName
node --test --test-concurrency=1 @core @ops
```
- Note: Check `browser-ui.test.mjs` / `docker-executor.test.mjs` results honestly; never convert environment skips or failures into silent passes.

## 2. Zero-Model HTTP/SSE Smoke
Verifies end-to-end DSH Web startup, auth/Origin/Host, delegation, cancellation, and no-replay restart behavior without real model calls:
```powershell
node integrations/dsh-agent-gateway/smoke/web-smoke.mjs --http
```
Confirm output includes `AGENT_GATEWAY_PASS` and `realModelCalls: 0`, and check `integrations/dsh-agent-gateway/runtime/` has no leftover scratch directories.

## 3. Package Bundle Boundary & Docs Contract
Ensure `npm pack --dry-run` only ships the intended 22 runtime/preset/bilingual README files (no `tests/`, `ops/`, `smoke/`, `runtime/`, `.github/`, or credentials), and verify Markdown links:
```powershell
npm pack --dry-run ./integrations/dsh-agent-gateway
node --test docs/documentation.test.mjs
git diff --check
```

## 4. Isolated Legacy Python Experiment Verification
Only needed when touching `legacy/python-cache-experiment/`:
```powershell
Push-Location legacy/python-cache-experiment
$env:REDIS_URL = 'redis://127.0.0.1:6399/0'
..\..\.venv\Scripts\pytest.exe -v
..\..\.venv\Scripts\ruff.exe check .
Pop-Location
```
