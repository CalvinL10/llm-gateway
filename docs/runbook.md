# Runtime and operating boundaries

The [portable demo](demo.md) only needs Node.js. Full integration uses a separate DSH installation in `.local/dsh-task02/node_modules/`; subscription tests also use a generated local subscription copy. Packages and credentials are not committed. The portable demo does not validate fresh-machine installation of the full runtime.

Recorded environment: Windows, Node.js v24.15.0, DSH launcher 0.1.5-rc.1, subagent/pi-ai modules 0.1.5-rc.2, pi-ai 0.85.1, subscription plugin 0.3.5. This describes the inspected environment, not compatibility with all versions. See [attribution](../THIRD_PARTY_NOTICES.md).

## Operating rules

- Use a dedicated Home/workspace. Unattributed model streams, including ordinary chat in that Home, are rejected.
- Retain loopback-only binding, DSH authentication, Host/Origin checks, approvals, and sandbox restrictions.
- The deployment helper is machine-specific, can prepare workspace permissions, and uses a default workspace that may differ from an existing deployment. Do not run it blindly against a live service.
- After an uncertain submission response, query/reuse the original request ID. A new ID is a new execution.
- Cancellation closes admissions and requests local termination; it does not establish that remote work/billing stopped.
- Restarted active tasks become `unknown`. Inspect recorded effects instead of assuming that no response means no side effects.
- The read-only report is not a submission/approval/cancellation UI or business-correctness certification.

## Storage

Tasks live in `$DSH_HOME/storages/gateway_agent_tasks.json`; full sessions live in `$DSH_HOME/sessions/`. They may include private goals, outputs, and source fragments. Do not commit Home data, authentication URLs, cookies, OAuth material, or raw session dumps.

Smoke tests create `.local/dsh-task02/delegation-test-*` directories and stop only their own services. Before manual cleanup, confirm the exact directory and that no process uses it. Never delete a real subscription Home as generic cleanup.

## Scope limits

The ledger serializes admissions within one process; it is not a distributed transaction or cross-process exactly-once guarantee. `maxCalls` counts harness stream admissions, not tokens, dollars, or every transport attempt. Provider-reported usage is not billing reconciliation.

The Windows patch targets the observed default isolated Node test-worker shape. Other Node versions, watch/IPC modes, and arbitrary subprocess behavior are outside the recorded acceptance. Native approvals remain in place; automated tests do not establish a real human approval interaction.
