# NX AI-01 | Handoff receipt and rollback race follow-up | 2026-11-24

This follow-up is isolated from reviewed PR #1242 at `ebeadc0a7708f8d67f2ee0c6afbbb5646878d2db` and coordinator candidate #1250. Neither existing branch nor its reviewed fixture blobs are changed. Merge decisions remain with the coordinator.

## Reproduced defect

The existing install transaction registers its own Boot task, rereads the legacy user Hub, and throws `HUB_USER_TASK_STATE_RACE` before touching the user task if its state changed. However, the outer rollback previously restored the stale preflight state whenever its Boot task existed. A concurrent intentional disable could be undone by Enable/Start, despite the guard rejecting the race. Exact source blob `2602205c6bd4989be82b050140419dd4a6c069c9`; isolated source-extracted PowerShell simulation request `b20c9d5c-3677-42e4-b0ae-a72a33987119` produced guard rejection plus simulated ENABLE_LEGACY and START_LEGACY. No real scheduler operation was executed.

## Narrow recovery boundary

- The trusted PowerShell child returns a strict JSON receipt containing actual legacy-mutation-attempted and SYSTEM-start-attempted booleans, set before the corresponding side effect. A returned failure before any legacy mutation permits only ownership-checked Boot rollback, not legacy state restoration.
- A returned failure after a legacy mutation attempt, but before SYSTEM startup was attempted, retains the existing ownership-checked restoration route.
- A missing/malformed receipt, attempted SYSTEM start, or subsequent health/status/manifest failure cannot prove that no new SYSTEM writes occurred. Fail closed with `HUB_BOOT_HANDOFF_RECOVERY_REQUIRED`; preserve task, launcher, protected root and both state trees. The receipt is in-process evidence of this invocation's attempts, not a durable transaction journal or proof about an external concurrent scheduler actor.
- Do not automatically rerun install, remove the new root or blindly restart the old writer on that error. AI-02/AI-09 must use the independent protected recovery protocol and prove writer/receipt/rollback state. No new production operations are authorized.

## Acceptance

New `test/hub-boot-handoff-receipt.test.ts` exercises strict receipt classification, source ordering and source-derived in-memory PowerShell stage receipts. It does not call actual task cmdlets or touch live data. Existing reviewed tests remain unchanged. The new file needs separate AI-08 review and exact-SHA hosted Windows execution; prior #1242/#1250 receipts do not cover this change. Real task/VM/reboot/cutover/rollback acceptance remains NOT_RUN. Test outcomes are attached to the new draft PR; do not infer execution from discovery.

Rollback source-only: revert this follow-up commit series on its own branch, or exclude it from the coordinator's integration. Never roll back a deployed SYSTEM installation by deleting protected state or ignoring UNKNOWN writes.
