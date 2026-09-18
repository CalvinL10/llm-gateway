# Agent gateway implementation

This plugin wraps DSH with task admission, persisted execution facts, and a read-only report. The root can answer directly or use native delegation. There is no fixed generate/review scheduler or hard-coded provider failover order.

| File | Project contribution |
| --- | --- |
| `index.js` | Protected task routes, host-owned lineage, stream admission/cancellation, event collection |
| `ledger.js` | Serialized persistence, request IDs, shared admission limit, recovery state |
| `tools.js` | Tool allowlists and dispatch-time checks, distinct root/child capabilities |
| `report.js`, `panel.js` | Allowlisted evidence projection and read-only display |
| `node-test-pipes.cjs`, `pwsh-test-pipes.js` | Targeted Windows worker-pipe repair through the confined executor |
| `deploy-subscription.mjs`, `subscription-copy.mjs` | Machine-specific deployment and local subscription adaptation |
| Tests and fixtures | Unit, native, and scripted-host integration verification |

## HTTP interface

The DSH-authenticated `/api/gateway-agent-tasks` route is loopback-only with `Cache-Control: no-store`.

| Request | Behavior |
| --- | --- |
| `POST /api/gateway-agent-tasks` | Submit `{requestId: UUID, goal: string}` under the configured policy |
| `GET /api/gateway-agent-tasks` | Read policy/tasks without model execution |
| `GET /api/gateway-agent-tasks?id=<id>` | Read one task and report |
| `POST /api/gateway-agent-tasks?id=<id>&action=cancel` | Submit `{}` to request cancellation |

Submission cannot override policy or attach extra fields. Same ID/goal returns prior work; a different goal returns `REQUEST_ID_CONFLICT`. This relies on retained records and one process owning the Home.

## Control and failure behavior

Host lineage attributes descendants to their task; actual provider/model/reasoning is checked at dispatch. Admission is returned only after persistence, and all descendants share the limit. Failed/aborted calls retain their admission because remote work may already have occurred.

Development mode permits root file/search/write/edit/pwsh operations and read-only child file/search tools. Native sandbox/approval checks remain. A child's `never` approval setting denies operations needing approval; it does not automatically approve them.

The local subscription adaptation disables selected implicit generation retries/model substitutions while retaining OAuth and protected credential storage. It is version-specific and does not provide a financial cap.

- `completed`: normal root-turn completion, not business acceptance.
- `limited`: the task-level call limit denied an admission.
- `cancel-requested` / `stopped`: cancellation requested / local execution stopped.
- `failed`: recorded execution/preparation failure.
- `unknown`: interrupted/unconfirmed execution, without automatic replay.

The report links tool calls/results and distinguishes confirmed, failed, and unconfirmed operations, including command exit status. `businessOutcome=unverified` and `validation=not-established` stay explicit. A successful edit event does not prove semantic correctness.

See [demo](../../docs/demo.md), [verification](../../docs/verification.md), [operating boundaries](../../docs/runbook.md), and [upstream attribution](../../THIRD_PARTY_NOTICES.md).
