# Nexowire Error Contract v2: isolated failure-chain acceptance

Date: 2026-10-18 (Türkiye). Repository: `Naveax/Nexowire`.
Baseline: `main` at `8660ac1fa9ec38fd81488a48b34affcb7d71fe65`.
Existing Error Contract v2: PR #549, merged as `7a8d73b537ac1378b72951ce67c30371c1303470`.
Acceptance branch: `test/parallel-02-error-acceptance-20261018`.
Scope: **synthetic in-memory MCP transport, an in-process mock AgentBroker, disposable temporary directories, and a local test runner**. The mock does not run a shell, access a real Windows UAC prompt, contact OpenAI, change device configuration, or talk to the hosted Hub.

## Verdict

**CONDITIONAL LOCAL PASS** for the specified simulated failure chain. **NOT production acceptance** and **NOT physical two-device acceptance**. A green test means the local implementation handled the injected observation correctly, not that the hypothesized real-world cause occurred.

Test command: `node --test --import tsx test/error-contract-chain-acceptance.test.ts` (14/14 PASS, zero skipped/failed). The existing `test/error-contract-v2.test.ts` and other related regression suites are run separately.

### Layer-by-layer evidence ledger

| Case | Synthetic observation and independent evidence | Observed and attributed layer | Safe next action |
| --- | --- | --- | --- |
| AC01: shell exitCode=1 | Agent transport `ok:true`; MCP `exitCode:1`, `taskStatus:failed`, `taskSuccess:false`, `isError` absent; durable audit `started → failed`; `SHELL_EXIT_NONZERO`; identical operation/correlation ID in provider request, diagnostic and audit. Synthetic stdout/stderr credentials absent from MCP response and raw log. | Agent transport succeeded; **operation** ended nonzero. Does not establish why the application exited or whether user-requested postconditions hold. | Inspect redacted stderr, exit code and independent task postconditions; do not equate transport with success. |
| AC02: shell timeout | Injected `data.timedOut:true` despite `exitCode:0`; `taskStatus:timed_out`, `taskSuccess:false`, audit `started → unknown`, diagnostic `SHELL_TASK_TIMED_OUT`. | Agent-reported shell timeout; final side effects **undetermined**. | Check process/task state and effects; reconcile before any rerun. |
| AC03: shell completion missing | Injected `exitCode:null`; `taskStatus:unknown`, `taskSuccess:null`, audit `started → unknown`. | **Task outcome unknown**, not a confirmed failure or success. | Inspect real process lifetime and authoritative completion artifacts. |
| AC04: PATH_DENIED | Mock Agent throws code `PATH_DENIED`; MCP retains original code and `isError:true`; attribution `native_agent`, remedy `after_reauthorization`, matched operation ID; injected Bearer credential absent from output and JSONL audit. | **Native Agent path-policy denial** based on the intentionally controlled fake Agent report; not a real filesystem grant test. | Request narrowly scoped owner path access. Do not route through shell/WSL to bypass denial. |
| AC05: Windows UAC denial | Mock Agent reports `WINDOWS_UAC_DENIED`; attribution `windows_wsl`; retry `after_reauthorization`; correlation persisted; injected password is redacted. | **Agent-reported Windows elevation denial**; no real UAC dialog was invoked. | Use the authorized owner-consent/UAC flow, or stop with a clear blocked state. Never bypass UAC. |
| AC06: UNAVAILABLE on read | `files.read` injects `UNAVAILABLE`; attribution `undetermined`, certainty `unknown`, `read_only_retry`; audit and provider request share operation ID. | **Provider/transport unavailability**, exact fault layer not proven. | Check Hub/device/provider reachability, then bounded retry of **read-only** operation. |
| AC07: UNAVAILABLE on mutation | `files.write` mock returns `UNAVAILABLE` after request submission; durable idempotency and audit `unknown`; repeat same key yields no second provider call. | **Unknown remote mutation outcome**, not verified failure. | Reconcile original operation ID and read target state before deciding on new side effects. |
| AC08: MUTATION_STATE_UNKNOWN | Mock disconnect on `files.write` produces `MUTATION_STATE_UNKNOWN`; `dispatchState:unknown`, `retrySafety:reconcile_first`; audit `started → unknown`; replay does not call Agent twice. | **Hub/Provider boundary** observes loss of confirmation; underlying Agent side effect is unknown. | Query Agent operation journal using original operation ID when available; compare postconditions; never blindly replay. |
| AC09: Agent never reached | Wrong target ID is denied with legacy `MCP_TARGET_NOT_AUTHORIZED`, attribution `mcp_hub`, `dispatchState:not_dispatched`; mock request count = 0; audit single `failed` with operation ID. | **MCP/Hub authorization and routing boundary**; no Agent dispatch occurred. | Select an account-authorized device or request correct scope. This does not prove an OpenAI policy refusal. |
| AC10: OpenAI/upstream refusal not delivered | A deliberate synthetic **external** `not_dispatched` assertion creates `upstream_client` attribution. Same error claimed by Hub without evidence remains `undetermined`. | **External upstream signal only when supplied explicitly**. Nexowire cannot see the private OpenAI safety rationale for calls not delivered to it. | Consult provider-visible diagnostics. Do not invent unseen refusal reasons or promise a policy bypass. |
| AC11: task-verification failure | `TASK_VERIFICATION_FAILED` attributed to `task_verification` **only** when the observation originates from that boundary; same code reported at Hub stays `undetermined`. | **Independent task verification** versus transport and OS status. | Check independent assertions/artifacts, not shell/transport metadata alone. |
| AC12: audit redaction | Direct audit append injects secrets in provider ID, device ID, error code and message; raw JSONL, in-memory list and query are checked for leaked synthetic credentials. | **Audit persistence boundary**. This validates common text secret formats, not generic DLP or historical logs. | Keep secrets out of metadata; conduct additional real-log and unknown-format redaction audits before rollout. |
| AC13: control success | Mock shell `exitCode:0` with no timeout yields `taskStatus:succeeded`, `taskSuccess:true`, audit `started → succeeded`. | **Process-exit success only**, not proof of external project acceptance criteria. | Verify intended artifact/state before declaring the task complete. |
| AC14: malformed provider response | A synthetic non-Agent provider emits `ok:true` without shell task fields; audit remains `started → unknown` and Agent is never called. | **Provider-to-Hub task-evidence gap**; transport success alone is insufficient. | Treat task completion as unverified, inspect provider protocol/evidence; do not fabricate status. |

### Findings fixed on the isolated branch

1. **Audit false positive:** `src/mcp/create-server.ts` previously assigned `succeeded` whenever `result.ok` was true, even for shell `exitCode:1`. It now requires matching explicit `taskStatus:succeeded` **and** `taskSuccess:true`; a confirmed nonzero exit is `failed`, while timeout/missing/inconsistent task proofs become `unknown`.
2. **Unknown mutation mislabeled failed:** post-dispatch `UNAVAILABLE`, `TIMEOUT`, `ETIMEDOUT`, `AGENT_TIMEOUT`, `MUTATION_STATE_UNKNOWN` and `IDEMPOTENCY_STATE_UNKNOWN` results are conservatively retained as `unknown` for mutating capabilities. Existing Agent journal ambiguous codes remain supported. No blind replay.
3. **Cross-layer correlation:** regular dispatched MCP responses gain a top-level `operationId` linked to the underlying provider `requestId` and durable audit event; prior `meta.requestId`, legacy error codes and optional v2 attribution remain.
4. **Audit sanitization boundary:** `AuditLog.write` now redacts known text-credential patterns in every string metadata field before recording the in-memory event or appending JSONL, not just in the caller's MCP result.

### Not accepted; physical or external acceptance needed

- Real OpenAI/ChatGPT refusal before MCP invocation: this is **invisible** to Nexowire without separate, explicit upstream evidence. Actual upstream policy reason is neither known nor simulated.
- Physical Windows UAC consent denial, real filesystem path and USB policy, Windows/WSL privilege transitions, and actual Agent crash/reconnect on two devices.
- Real hosted MCP/Hub networking, Cloudflare WSS, live correlation across restarts and surviving Agent journal/query; mock in-process `AuditLog` and `IdempotencyStore` are not substitutes.
- Actual stderr/application postconditions for shell tasks, crash side effects, process cleanup, security review of arbitrary data types, screenshots, nonstandard tokens and existing historical audit files.
- The test suite verifies fail-closed classifications, not production throughput, zero errors, or completed physical remediation.

**Release recommendation:** keep the follow-up PR DRAFT until independent review, exact-head CI and future authorized hardware acceptance. Do not infer completion from old Agent 1.0.5 deployment, GitHub merge state or a passing synthetic test.
