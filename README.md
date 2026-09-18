# Agent Execution Gateway

A local backend for **bounded, traceable LLM-agent execution**. A root agent can answer directly or delegate through DSH's native runtime; this project adds task admission, persistent execution records, and evidence-based reporting.

The engineering problem: a returned model response is not proof that a task succeeded. Parallel descendants, interrupted processes, and failed tools need explicit outcomes.

## Project contributions

- **Task control:** UUID-based duplicate submission handling, dispatch-time route checks, and a shared call limit across the root and descendants. Admission persists before a call proceeds.
- **Failure behavior:** failed calls are not refunded; cancellation closes further admissions; interrupted tasks become `unknown` after restart instead of being automatically replayed.
- **Execution evidence:** a read-only report separates turn completion from business acceptance and links file operations and command results to recorded tool events.
- **Confined development tools:** root file/terminal operations and read-only child tools, retaining native authentication, approvals, and sandbox enforcement.
- **Targeted Windows repair:** inherited anonymous pipes address a reproduced restricted-token `spawn EPERM` failure in isolated Node test workers, without disabling test isolation or using unrestricted execution.

DSH supplies the agent loop, model catalog, delegation, tools, sessions, authentication, and storage. These are upstream capabilities, not a self-built engine. See [attribution](THIRD_PARTY_NOTICES.md).

## Portable demo

Verified with Node.js **v24.15.0**. This demo needs no credentials, package installation, or private runtime:

```powershell
git clone https://github.com/CalvinL10/llm-gateway.git
cd llm-gateway
node --test integrations/dsh-agent-gateway/offline.test.mjs integrations/dsh-agent-gateway/report.test.mjs
```

This exercises admission, duplicate requests, cancellation/restart semantics, tool boundaries, and report projection. It is an automated local demo, not a live-model run.

## Verification scope

| Evidence level | Verified scope |
| --- | --- |
| Implemented and locally tested | Task API, admission ledger, tool restrictions, safe report projection, Windows worker-pipe repair |
| Real host, simulated models | DSH + loopback HTTP/SSE: parallel delegation, follow-up, child-error recovery, cancellation, restart without replay |
| Recorded real-model execution | A bounded coding fixture: the agent edited a boundary defect and ran the unchanged test with default process isolation |

The real fixture does not establish general autonomous development or production reliability. This is a **single-process, local project**, not a production incident-response or high-availability platform. The call limit is not a token/dollar cap; local cancellation does not prove remote billing stopped.

- [Demo steps and expected results](docs/demo.md)
- [Sanitized verification records](docs/verification.md)
- [Runtime and operating boundaries](docs/runbook.md)
- [API and implementation map](integrations/dsh-agent-gateway/README.md)

## Repository layout

- `integrations/dsh-agent-gateway/`: current task gateway and regressions.
- `integrations/dsh-workflow/`, `dsh-task02/`, `dsh-text-only/`: earlier integration experiments retained for reference and regression testing.
- `app/`, `tests/`, Python/Docker configuration: a separate FastAPI/MockProvider/Redis cache experiment, **not connected** to the agent gateway. Docker does not start this gateway.

Runtime packages, credentials, private sessions, debugging records, and personal application materials are excluded. No throughput, cost-saving, user-scale, or availability claims are made.
