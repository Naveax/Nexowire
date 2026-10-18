# P0 Agent mutation-recovery journal (source-only release candidate)

## Problem

Hub history can report a missing acknowledgement as `MUTATION_STATE_UNKNOWN` even though a remote shell or file mutation already executed. Its local idempotency journal is insufficient proof of **Native Agent-side** dispatch. Retrying blindly risks duplicate side effects. Also, a tool request may return an Agent transport success while its shell exits nonzero.

## Implementation

- `src/agent/operation-journal.ts`: Agent-owned SQLite database with WAL and `synchronous=FULL`, keyed by the already-existing Hub `requestId` UUID and the Agent's canonical fingerprint (capability, payload and SAFE/FULL access). The journal is separate from Hub idempotency. **No input/payload, credentials, stdout/stderr, original result, or command text is stored.**
- Before calling a **mutation** executor, the Agent commits `in_progress`. If the commit fails or the journal cannot open (including corrupted SQLite), the mutation is not dispatched. The agent holds the existing per-device singleton lock. Unknown existing request IDs, even after restart, never execute again; mismatched fingerprints hard-fail.
- On successful Agent execution, persists `succeeded` (Agent response returned); on an Agent executor error, `failed`. On startup, interrupted `in_progress` rows become `unknown`. **A `failed` or `succeeded` Agent return does not by itself guarantee the target's physical state.** For `shell.exec` and `wsl.exec`, the record also stores `processExitCode`, `taskSuccess`, and `timedOut` to distinguish command success from transport success.
- The Agent exposes read-only capability `agent.operation.status` with exact `request_id` UUID. The MCP tool `agent_operation_status` is authorized ONLY to operator/admin and existing target-device restrictions. It returns record metadata, not payloads. Missing records never prove non-execution.
- `src/audit/log.ts` adds `unknown` status. The MCP audit recovery path now writes the real `recordedStatus`, rather than misleadingly writing every ambiguous outcome as `failed`.

## Operator examples / interpretation

`agent_operation_status({device_id: "<exact-id>",request_id: "<original UUID>"})` is a **read-only** first-party Nexowire tool available only after compatible Agent + Hub deployment and operator/admin authorization. While the Agent is offline, Hub-side `operations_idempotency_list({key:"..."})` can still show a recorded Hub idempotency status if there was a key.

- `in_progress`: started, still possible to finish; do not replay.
- `unknown`: process restarted or completion unconfirmed; read back target state, never automatically replay.
- `succeeded`: Agent returned a response, but for shell check `taskSuccess` and `processExitCode` before claiming the actual task succeeded.
- `failed`: Agent reported an execution failure; no guarantee that external side effects did not occur.
- `found:false`: no local record in this specific Agent journal; **NOT** proof of no remote effect (the request may never have arrived, another Agent/path may have run it, or the journal may have been lost).

## Limits and security

1. **No promise of exactly once across the remote OS:** A script can spawn descendants or mutate hardware outside the Agent's transaction; the journal only guards Nexowire request replay IDs. A brand-new request ID can still cause another side effect. The Agent cannot know the reason for upstream OpenAI security blocking if the tool call never reached it.
2. **Safe failure over availability:** Corrupted/locked/unwritable journal prevents native Agent startup or subsequent mutation. SQLite file and `-wal/-shm` files must stay together. The existing singleton lock must be held on startup.
3. **Storage grows until explicit archival:** Never silently expire a request ID; that would permit an ancient replay. The optional `maxRecords` is only for bounded/saturation tests, not a production default. Define retention, disk alarm, migration and independent archival approval before production.
4. **No live deployment in this PR:** Source-only tests and CI are not evidence of an active upgraded Agent. Validate Node's bundled SQLite support, Windows permissions, disk-full failure, crash/restart, exact request ID routing, and two physically running computers before release acceptance.
5. **No authority expansion:** The status tool is operator/admin-only, device-scoped; no new privilege or ability to bypass OpenAI, Windows UAC, physical-console approval or policy denials.

## Unit and integration tests

- `test/agent-operation-journal.test.ts`: durable commit, no duplicate execution, restart unknown, fingerprint conflict, corrupted/unwritable journal, SQLITE WAL retention, 230-operation throughput sample, shell exit and timeout.
- `test/agent-operation-status.test.ts`: exact metadata-only status capability and invalid-schema denial.
- `test/mcp-tool-authorization.test.ts`: default-user cannot invoke `agent_operation_status`; operator/admin may with configured scopes.
- `test/audit-log.test.ts`: unknown is distinct from confirmed failure.
- Run TypeScript, build, MCP surface, idempotency continuity and exact-head CI before considering merge. Keep running work-pc/Naveax services unchanged.

## Pending follow-up

A device-independent read-only offline Agent-state snapshot requires authenticated storage replication; the new Agent-only status tool needs an online Agent. Add authenticated secure owner-scoped replication and rollback-safe journal archival with tests before declaring lost acknowledgement recovery fully complete. Other P0/P1 work is tracked in `docs/NEXOWIRE_CROSS_PROJECT_RELIABILITY_BACKLOG_20261018.md`.

## 2026-10-18 Work PC connection-loss reproduction

While running a 38-file Agent/MCP regression in the **unupgraded live Agent 1.0.5**, the Nexowire connector returned `MUTATION_STATE_UNKNOWN` and operationId `37e18857-1c79-43fa-85ca-6e2a4bd8485e`. The call's result was lost, so it is **NOT** evidence of successful regression completion. A subsequent independent `windows_processes` read found only the long-running Nexowire Agent and no `node --test` process. A **new** managed, durable Nexowire `process_start` regression session was started only after that inspection, ID `8a84c12f-d347-4a13-b39d-0424796e6ad7`, to preserve new attempt stdout/exit details through reconnection. This is a reproduction of the old runtime problem, NOT a live verification that the new source implementation already fixed it.

## Exact pre-PR verification, 2026-10-18

- 37 directly relevant native-agent, MCP, capability-discovery, audit, idempotency and provider tests: **193/193 PASS**, no failures/skips, in a managed durable Nexowire process session `7bd65faa-6939-4fc2-af9a-e2c6dcbd7045`; terminal exitCode **0**.
- `npm run typecheck`, `npm run build`, `npm run continuation:check`, `npm run ai-screen:launch-audit`, staged whitespace guard: **PASS**. Existing AI Screen launch-audit warns unchanged legacy sinks are not proved isolated; this PR does not change those sinks.
- The earlier all-related suite included `process-manager.test.ts`; its worker remained running, so that wide run was explicitly stopped and **not** claimed PASS. This is a separate pre-existing/possibly environmental test hang to investigate before production acceptance. The 37-file successful run excluded that one known-hanging file.
- First broad run found missing MCP discovery map for `agent_operation_status`; corrected `src/mcp/tool-capabilities.ts`. Focused discovery/recovery retest: **24/24 PASS**. No active production Agent was upgraded.

## 2026-10-18 independent regression evidence after discovery-map correction

- On Work PC with **unupgraded** native-agent runtime 1.0.5, an initial 38-file regression `shell_exec` invocation lost confirmation and surfaced `MUTATION_STATE_UNKNOWN`, operation UUID `37e18857-1c79-43fa-85ca-6e2a4bd8485e`. Investigation confirmed the old runtime remains active. No claim that this new source patch is deployed.
- A managed persistent session for all 38 files stalled while `process-manager.test.ts` worker was alive without meaningful CPU progress; it was explicitly stopped. The unchanged process-manager test is isolated for independent timeout diagnosis and excluded from the next regression group.
- A first 37-file run caught a **new MCP tool discovery-map omission** for `agent_operation_status`. Fixed `src/mcp/tool-capabilities.ts`; subsequent 37-file test run **193/193 PASS**, 0 failures. Exact session `ea103b77-120c-45de-892d-a9e855fb0133` exited 0. TypeScript, build, continuation check, AI Screen launch audit and whitespace check passed. AI Screen warning about pre-existing launch paths remains (not a new acceptance proof).
- Separate `process-manager.test.ts` with `--test-timeout=20000` is **not covered by 193/193 figure**. It must pass independently or be reported as an outstanding blocker. Do not claim a fully green repo until it does.
- Additional MCP discovery contract map added. Because `agent.operation.status` is read-only and operator-only, it must be discoverable only when a device advertises its capability and the credential is authorized; out-of-date live Agents do not advertise it.

## P0 follow-up: Agent completion uncertainty must survive Hub idempotency

A static integration review found that an Agent may return `AGENT_OPERATION_COMPLETION_UNCONFIRMED` or `AGENT_OPERATION_ALREADY_RECORDED` as a **non-retryable provider error** after dispatch. The previous Hub implementation marked such structured error responses as `failed`, even though external mutation side effects were ambiguous. This was distinct from thrown `MUTATION_STATE_UNKNOWN` errors, which were already classified as `unknown`.

New `src/mcp/create-server.ts` classification uses `resultStatus='unknown'` for those two codes in the durable Hub idempotency record, MCP response metadata and audit log. A normal `PERMISSION_DENIED` still records `failed`. New `test/mcp-agent-outcome-reconciliation.test.ts` executes real MCP in-memory transport + AgentProvider + fake broker with these three codes and asserts one broker call despite retry. The Hub in-memory replay cache may return the same recorded error with `replayed:true`; after restart the durable status remains decisive. No automatic mutation replay is authorized.
