# Reproducible demo

Run commands from the repository root. None below calls a real model.

## Clean-checkout demo

Node.js v24.15.0 was used for verification. These tests use Node standard libraries and repository source only.

```powershell
node --test integrations/dsh-agent-gateway/offline.test.mjs integrations/dsh-agent-gateway/report.test.mjs
```

Expected: `tests 16`, `pass 16`, `fail 0`, `skipped 0`. This was also run from a source archive without `.local/` or `node_modules/`.

Explain these cases during a demo:

1. Descendants share one admission limit; persistence failure cannot return a successful admission receipt.
2. Duplicate request IDs return existing work; conflicting inputs are rejected.
3. Cancellation closes admissions; restart marks interrupted work `unknown` without replay.
4. Failed/incomplete tool operations remain visible; `completed` does not imply business acceptance.

These are deterministic tests, not an evaluation of model reasoning quality.

## Real-host integration — existing runtime only

Requires the separately installed DSH runtime under `.local/dsh-task02/`. This is **not a clean-clone setup command**; see [runtime requirements](runbook.md).

```powershell
node integrations/dsh-agent-gateway/web-smoke.mjs
node integrations/dsh-agent-gateway/web-smoke.mjs --http
```

Both output `AGENT_GATEWAY_PASS`. The HTTP run uses the actual pi-ai adapter with scripted, loopback-only SSE endpoints. Each invocation creates a separate temporary Home/workspace and a random Web port; it stops its own test host/endpoints afterward. Diagnostic files remain local.

Assertions cover authentication, Host/Origin rejection, duplicate submissions, concurrent children, follow-up delegation, child-error recovery, budget exhaustion, cancellation, and an actual host restart. Scripted responses prove integration behavior, not real-provider planning or production failover.

## Native Windows regression — existing authorized workspace only

```powershell
$env:GATEWAY_PIPE_TEST_WORKSPACE = 'C:\path\to\existing-authorized-workspace'
try {
  node --test integrations/dsh-agent-gateway/node-test-pipes.test.mjs
} finally {
  Remove-Item Env:\GATEWAY_PIPE_TEST_WORKSPACE -ErrorAction SilentlyContinue
}
```

Requires the existing native runtime and workspace security configuration. This creates diagnostic fixtures; it is not an ACL setup/repair step. It checks original `EPERM`, repaired isolated execution, denied writes, assertion-failure status, concurrent output drainage, and timeouts. Without the variable the native workspace case is skipped, not accepted.

The recorded native run did not change workspace ACLs or disable test isolation. [Verification records](verification.md) distinguish it from real-model acceptance. Do not replay historical real tasks or run the subscription deployment helper as a demo.
