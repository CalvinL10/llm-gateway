# Verification record

Publication review: **2026-09-18**. Source snapshot: local revision `2757215821cb`; published implementation/test files are byte-for-byte copies of that snapshot. Documentation was rewritten for this delivery. No new real-model execution was made during the review.

## Reproducible tests

| Run | Recorded result | Evidence |
| --- | --- | --- |
| Dependency-free gateway/report tests, source archive | 16 passed, no failures/skips | [test output](evidence/clean-source-tests.txt) |
| Full local Node suite, existing runtime | 63 passed, 1 skipped, no failures | [test output](evidence/node-tests.txt) |
| Original authorized Windows workspace, explicit native regression | 10 passed, no failures/skips | [test output](evidence/native-pipes.txt) |
| Actual DSH with in-memory scripted adapter | `AGENT_GATEWAY_PASS`, no real model calls | [result](evidence/smoke-memory.json) |
| Actual DSH + pi-ai + loopback HTTP/SSE fixtures | `AGENT_GATEWAY_PASS`, no real model calls | [result](evidence/smoke-http.json) |

Counts are test results, not reliability or performance measurements. They overlap and must not be added into a success-rate claim. Per-test timings were removed from the public transcript; test names and outcomes were preserved.

The default Node suite skips the original-workspace native case unless its environment variable is supplied. The separate native run above supplied it and reproduced the unpatched failure, then verified repaired execution, isolated workers, denied writes, command failures, concurrent output, and timeout handling.

Full existing-runtime suite:

```powershell
node --test integrations/dsh-task02/offline.test.mjs integrations/dsh-workflow/offline.test.mjs integrations/dsh-agent-gateway/offline.test.mjs integrations/dsh-agent-gateway/subscription-offline.test.mjs integrations/dsh-agent-gateway/preparation.test.mjs integrations/dsh-agent-gateway/report.test.mjs integrations/dsh-agent-gateway/node-test-pipes.test.mjs integrations/dsh-agent-gateway/development.test.mjs
```

Use the [demo](demo.md) for prerequisites and safe commands. These tests do not justify production availability, scale, or model-quality claims.

## Recorded real-model fixture

[Sanitized evidence](evidence/real-fixture.json) describes one existing bounded coding acceptance, recorded at **2026-09-18 06:08–06:09 UTC** (**September 17 in America/Los_Angeles**).

- The root agent changed `max - 1` to `max` in an intentionally faulty clamp fixture.
- It ran `node --test .\range.test.js` with default isolation; the unchanged boundary test passed and the command exit code was zero.
- The review matched edit/command facts against the original compressed session and durable ledger, rather than trusting the assistant's final answer.
- There was no child delegation or approval request in this task. It does not establish real-model parallel recovery or human approval UX.
- API reporting retained `businessOutcome=unverified` and `validation=not-established`: a narrow externally inspected fixture success does not turn every `completed` task into a verified business success.

The original session, task ledger, and authentication data remain private; the public JSON is a minimal source-derived projection, not an independent third-party attestation. It is not a script to replay or spend on real models.

## Claim boundaries

Implemented controls are supported by code and tests. Parallel delegation, child-error recovery, and transport cancellation have scripted-model integration evidence. The real coding evidence is limited to the fixture above. The evidence does not establish general production autonomy, distributed recovery, or exact cost caps.
