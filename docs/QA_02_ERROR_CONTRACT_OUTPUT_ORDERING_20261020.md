# QA #02: Error Contract v2 and Windows Job output-order acceptance

Date: 2026-10-20. Repo: Naveax/Nexowire.
Base `main` at `fda2a2da164ea7c6a2fe2271fc669f1fd623cede`.
Branch: `test/02-error-ordering-negative-20261020`.
Merged Error Contract #565: `97977a9f81f2e21102bdf910d2cbe45c9b4c484b`. All existing #565 tests remain in place.

## Actual external CI observations

| PR and exact failing run | Evidence from completed job log | Classification | Correct next step |
| --- | --- | --- | --- |
| #582, run [39416566585](https://github.com/Naveax/Nexowire/actions/runs/39416566585), browser-live job `118606925439` | `Windows Job fast-exit stdout and stderr are drained before exited status` failed at `test/windows-job-owner.test.ts:216`: stdout absent at **iteration 1**. 20 PASS / 1 FAIL across Job regression step. | Actual Windows stdout observation before sufficient stream proof. Intermittent race suspected; log alone does not prove guardian kernel ownership failure, Error Contract failure, or whose callback raced. | #03 / #576 Process Manager and native guardian owner: trace child-exit, guardian-exit, stdout/stderr drain and stream cursor with isolated fixtures. Preserve exact Job ownership/ACL gates. |
| #597, run [39468688109](https://github.com/Naveax/Nexowire/actions/runs/39468688109), browser-live job `118786718880` | Same Windows Job test failed at **iteration 11**, `test/windows-job-owner.test.ts:216`: stdout absent. Job regression step: 20 PASS / 1 FAIL. | Second distinct real Windows-runner manifestation with a different iteration, supporting intermittent output ordering. | Same #03 owner. Never mask missing stdout, skip the regression, or blindly promote `exited` to task success. |
| #597, same run, Linux Node24 job `118786719081` | `test/artifact-588-single-call-contract.test.ts` intentionally fails for missing durable one-MCP-call cross-device transfer. Node24 1790 PASS / 1 FAIL / 276 SKIP. | **Separate** intentional acceptance gate for issue #588, not stdout/Job Object regression. | #588 / #596 transfer owner must implement orchestrator. Keep the test red until truly implemented. |
| #572, run [39284185988](https://github.com/Naveax/Nexowire/actions/runs/39284185988), browser-live job `118165352355` | `durable process stdin/stdout reattaches across ProcessManager restart` failed at `test/durable-process.test.ts:46`: `Timed out waiting for durable process output: /NW_DURABLE_READY/` after ~27.1s. Recovery-from-atomic-temp-record companion test PASS. | A missing readiness output event, **not** proof the worker never launched, nor an OpenAI provider rejection. Durable output ordering / worker-ready persistence requires investigation. | #03 / #576 and durable owner: preserve worker status, readiness journal and output evidence, distinguish `lost` vs independently verified `exited`. |

## New isolated QA additions (no shared ProcessManager edit)

1. `test/qa-02-error-contract-no-replay.test.ts`: in-memory MCP client → Provider Registry → fake AgentBroker. Injects `AGENT_DISCONNECTED` on a synthetic `files.write` after dispatch. Verifies `MUTATION_STATE_UNKNOWN`, `retrySafety:reconcile_first`, the **same operation UUID** in provider request, MCP error and idempotency metadata; durable audit `started → unknown`, no injected Bearer token in raw JSONL, and **exactly one** provider request after same-key retries both before and after an isolated Hub/MCP process-level re-instantiation. No user file write is executed. Also checks upstream refusal remains undetermined absent explicit external evidence, and scoped `PATH_DENIED`.
2. `src/mcp/create-server.ts`: additive correction preserving `idempotency.operationId` on exception paths for post-dispatch unknown mutations. This was absent on the error path even though `operationId` existed at the top level. Without it, clients must guess how to correlate a journal record. No replay behavior or dispatch code was relaxed.
3. `test/qa-02-windows-output-ordering.test.ts`: deterministic synthetic negative snapshots reject `exited` without stdout or stderr, lost/orphaned/unknown status as success, and duplicated/out-of-order seq values. A Windows-only physical test starts **eight uniquely named synthetic cmd fixtures** under the existing verified native Job guardian and asserts both streams are observed before reported `exited`. No installed Agent, arbitrary PID or user process is touched.
4. `.github/workflows/ci.yml`: adds the new Windows physical QA file to the **existing** Job regression CI step; does not remove or skip any existing tests. The cross-platform no-replay and synthetic negative tests enter the standard suite.

## Results and release boundaries

Initial isolated Windows typecheck PASS; 8/8 new QA tests PASS after a real initial regression identified missing nested `idempotency.operationId` (initially 7/8 PASS). Locally compiled native helper from this isolated branch. The original #565 error attribution tests remain untouched.

**Not proven:** 24/7 Windows stability; fixed fast-exit stream draining (owned by #03); real `NW_DURABLE_READY` loss; real OpenAI upstream policy refusal; actual owner-approved rollout; hardware signer, native Job-object-handle retention protection and two-device production acceptance. All real Windows fixture tasks are test-created. Synthetic refusal ≠ live provider outcome.

Keep the QA PR **DRAFT** until exact-head CI and owner/security review. If Windows original/added ordering test fails, it is a genuine acceptance blocker, not a reason to delete or skip the test. The Process Manager implementation and native guardian remain owned by #03 / #576.
