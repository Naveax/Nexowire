# NEXOWIRE #09 / #780 CDP micro-scenario: bounded SOURCE contract and authority dependencies

Date: 2026-10-22. DRAFT AI Screen/CDP owner work. **No runnable micro-scenario endpoint, no new CDP engine, no live GUI, Chrome/Edge, UAC, VM or elevated execution.**

## Verified baseline

- #773 exact HEAD `ade5526b69b0a2c81bb8bdb4d1fd7de3aacb95b7` hosted CI **#39805175849: 7/7 jobs SUCCESS**. This is source acceptance only. A missing `state.json` must not fabricate `running:false`/physical STOP; the native Job/HANDLE+PID FILETIME owner/atomic stop witness is still **BLOCKED**.
- #780 is an open GitHub **issue/epic**, not a PR implementing a sandbox or a micro-scenario.
- #783 HEAD `0fab0d7eab6fc9455d8fa7bdadd528e41279182b` provides metadata-only `AgentLoopCheckpointV1Schema` and `reviewAgentLoopCheckpoint` / `reviewAgentLoopContinuation`. Stable `logicalMutationId`, original `requestId`, owner/device epochs and grant generation are part of the immutable identity. UNKNOWN -> RECONCILE_REQUIRED, `mayDispatch:false`, `mayReplay:false`; no external non-restorable CAS or native dispatch proof.
- #787 HEAD `3fe56ef39ab604a472974946dd31b4e016287f46` provides source-only signed reviewed diff approvals with owner/device epochs, base/diff SHA and separate rollback review. A valid synthetic signed diff review returns `APPROVED_SOURCE_ONLY_NO_MUTATION`, `canApply:false`, `canLaunchElevated:false`. This is not the task-scoped CDP grant, OS process sandbox, physical Access/native authority or automatic CORE. Do not import #01/#04 unmerged owner code into #09.
- #759 private picker and #767/775 Access are likewise source-only for native process effect. The regular signed pre-approved CORE Broker path must remain separately controlled; never transform it into browser click/UAC consent.

## Existing CDP inventory, reuse not rewrite

| Requested step | Existing CDP code | Boundary |
|---|---|---|
| `navigate` | `BrowserManager.navigate` calls `Page.navigate`, then polls only read-only `Runtime.evaluate` document.readyState until bounded deadline | Navigation can have already happened on timeout; no blind retry or stale-page assumption |
| `wait` | Existing *navigation readiness* wait is bounded; no general standalone selector wait exposed | New source plan's `wait` is an intended readiness-only step, **not implemented as a new runtime function** |
| `assert` | `browser.snapshot` and `browser.visual.verify` check bounded selector/text/DOM evidence | A single source assertion is not a durable native effect receipt |
| `screenshot` | `BrowserManager.screenshot` invokes `Page.captureScreenshot`, caps raw bytes and computes SHA-256/PNG dimensions | Base64 or a claimed SHA is not independent signed evidence; scope to exact task+session+target+capture step |

`src/agent/browser-control.ts` exposes these existing individual capabilities, while `BrowserManager` owns session UUID, page target selection, per-session browser profile and existing CDP WebSocket. Existing browser-live test starts its OWN headless Edge against an ephemeral loopback HTTP server, not the user's browser. This revision did **not** run that live fixture. The current implementation lacks task-bound sandbox ownership for ordinary headless sessions; headless is not OS isolation. On Windows, visible `Default` desktop launch is denied and `private_desktop` launch remains blocked until signed #03 native owner.

## #09 bounded metadata-only contract

`src/agent/browser-micro-scenario-contract.ts` adds a **pure** V1 strict plan type plus a read-only review. It has NO tool registration and NO call to `BrowserManager` or `executeBrowserCapability`; even correct source metadata returns `canDispatch:false`, `canReplay:false`, `canElevate:false`, `evidenceVerified:false`, `physicalStopVerified:false`.

- Immutable references: task ID, logical mutation ID, request ID, owner/device identity and epochs, owner epoch, grant generation, task/worktree grant IDs, sandbox ID, base Git SHA and diff SHA, browser session ID, target ID and one allowed origin. **References are not trusted grants**, even if a request says approved/effective.
- Strict ordered steps `navigate/wait/assert/screenshot`, maximum **8**; no `click`, `set_value`, arbitrary JavaScript/CDP evaluate, upload, shell, COM, Windows foreground, GUI UAC or new browser profile creation by a scenario. One origin, HTTPS or loopback HTTP, no credentials or cross-origin redirect authorization; redirected final origin must be checked by a future protected runner.
- Task time ceiling **60 s**, each navigate <=15 s, readiness wait <=10 s, bounded assert text/selector, screenshot <=2 MiB per step and <=4 MiB cumulative, no unlimited retries. Because even navigating a URL can alter server state, any timeout/lost CDP ACK after possible navigation is **MUTATION_STATE_UNKNOWN**, not a safe repeat.
- Source-only screenshot reference schema binds task/request/session/target/step, PNG format, SHA-256, dimensions and byte count. It returns `evidenceVerified:false` until an independently authenticated capture receipt and actual bytes readback are compared.
- A checkpoint marked `RECONCILE_REQUIRED` or `MUTATION_STATE_UNKNOWN` can yield only `READ_ONLY_RECONCILIATION`, preserving the original error code and logical mutation ID. No cloned checkpoint/runbook alias creates a new request ID.

These structural budgets reduce accidental unbounded plans but do NOT prove OS task isolation, current owner consent, signed grant validity or external cancel/readback. A client-provided `ownerEpoch` or grant UUID is never permission to execute.

## Required actual execution authority before a future thin adapter

1. **#05 task sandbox:** independently verified worktree/task root, immutable path/file volume/root identity, OS process/network boundary. Worktree path policy alone does not sandbox browser network, CDP targets, Chrome profile or native child process. No user's existing Chrome CDP endpoint reuse without an owner-scoped permit.
2. **#04 Access/task approval:** server-trusted current owner/device/session epoch/grantGeneration, exact worktree base+diff SHA, allowed origin, browser session/target and step fingerprint, TTL, revoke-start fencing and one-use/authorized effect receipt. #787 diff review alone is NOT a browser grant or elevated entitlement. CORE/HIGH remains out of CDP scenario scope.
3. **#01 Journal + #08 checkpoint:** immutable logicalMutationId/requestId across resumes and cloned tasks; per-step durable reserve/commit-for-dispatch against revoke before any navigation; authenticated readOutcome on ambiguity; verified screenshot artifact SHA and bounded encrypted, redacted evidence references. `retryUnknown:true` or a local screenshot/exit status cannot authorize retry.
4. **#03 Native and #09 Browser:** owner-verified process lifecycle and task-scoped CDP endpoint; target/origin must be revalidated immediately before each action and after every await, including redirects; cancellation MUST stop future steps and trigger separate verified native reconciliation. Never mark STOP COMPLETE merely from a lost browser session, missing state or marker file.
5. **#14 quotas:** cap steps, total time, screenshot/transfer bytes and concurrent sessions; cleanup/UNKNOWN reservations stay held until independent verified stop/deletion.

Only after those authorities exist should #09 add a minimal adapter that calls **the existing** `BrowserManager.navigate`, `snapshot/visualVerify` and `screenshot`. No new Playwright engine, no automatic fallback to visible Default desktop, native elevated Broker or Secure Desktop UAC.

## Source QA and blockers

`test/browser-micro-scenario-contract.test.ts` verifies strict budgets; wrong owner/worktree/sandbox metadata; forged approved/CORE fields; unsupported click/evaluate/UAC; cross-origin/credentials/public HTTP; duplicated IDs; mismatched screenshot SHA reference; UNKNOWN no replay; and confirms `browser.micro_scenario` is NOT an exposed executable capability. No live browser/GUI/VM/Agent is started or modified.

**Decision: SOURCE PLAN ONLY / P1-B execution BLOCKED** pending actual #01/#04/#05/#08/#03 grants, sandbox and reconciliation. #773 P0 protected physical stop remains NO-GO. This DRAFT is not production acceptance or permission to merge a runnable scenario.
