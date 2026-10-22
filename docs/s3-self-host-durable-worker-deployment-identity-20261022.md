# Nexowire #12 | #780 self-host durable coding worker deployment and identity boundary

**Date:** 2026-10-22 | **Owner:** #12 installer/deployment | **Scope:** source inventory + future deployment design only
**Base:** #765 exact HEAD `df145abbc7b28d360a2afc1c4396909bb0af5d3f`
**CI:** workflow `39803342678` **SUCCESS on attempt 2**, including `browser-live` job `119914270919`.
The initial attempt FAILED `test/windows-job-owner.test.ts:216` fast-exit stdout-before-`exited` on iteration 11; the retry does **not** fix the intermittent Windows Job race. Do not rerun this SHA or waive the negative.
**State:** DRAFT / DESIGN ONLY / **P0 physical HIGH Broker NO-GO**. No production deployment authorization.

## 1. Actual source inventory: three separate mechanisms, not one coding agent

| Existing module | What its source actually does | Does **not** establish |
|---|---|---|
| `src/agent/process-worker.ts` (`runProcessWorker`, process status/control/events) | One managed command session; private worker rechecks execution environment and Windows private desktop identity; writes bounded process status and stdout/stderr event streams; local control socket/token, child lifecycle and Job guardian | A task graph, Git change approval, owner-device enrollment, durable multi-step planner, cross-restart grant or sandbox authority |
| `src/agent/process-manager.ts` | Starts/reads/writes/stops managed process sessions; limits/retains sessions and provides owner-specific process orchestration safeguards | Security-isolated coding tasks or a signed installed elevated Broker |
| `src/agent/operation-journal.ts` + `operation-journal-wal.ts` | Agent mutation requestId/fingerprint/capability; SQLite WAL/FULL, singleton journal owner and conservative WAL validation; incomplete `in_progress` after recovery becomes `unknown`; archive preserves anti-replay identifiers; deliberately omits command bodies, tokens and stdout/stderr | Trusted external monotonic CAS, rollback-independent owner epoch, task-step graph/checkpoint or proof of actual side effect; a local SQLite copy can be reverted with its disk |
| `src/workspace/artifact-checkpoint-adapter.ts` + Workspace/Artifact Bridge stores | Explicit one-way legacy checkpoint import with device/workspace scope, repository commit SHA and artifact references; lookup/list of checkpoints | Automatic resumption of a coding task, revalidation of current authority, or unknown native mutation reconciliation |
| `src/self-host-bootstrap.ts` + `docs/SELF_HOST.md` | Windows **same-account** Hub + local Native Agent bootstrap; distinct MCP and Agent **bearer** credentials sealed by CurrentUser DPAPI; local Hub health/agent authentication and optional separately configured Tailscale ingress | A separate coding worker principal, device signing identity or OS sandbox. Do not invoke bootstrap as part of this design review |
| `src/agent/device-anchor.ts` + `src/agent/native-agent-enrollment.ts` | CurrentUser-DPAPI local device anchor and Agent credential enrollment; authenticated Hub connectivity | A separate signed worker key, non-exportable hardware key, or HIGH/SYSTEM grant |
| `src/protocol/guardian-key-enrollment-proof.ts`, `src/product/owner-public-wss-device-signer-proposal.ts` | Owner/device challenge signing and proof-of-possession **source** contracts. Verified possession explicitly returns `enrollmentAuthorized:false` | Atomic trusted owner enrollment, challenge consumption/revocation or privileged command permission |
| `src/product/owner-public-wss-windows-dpapi-staging.ts` | TEMP-only Ed25519 PKCS#8 test key sealed under CurrentUser DPAPI; key is unsealed into Node for signing | Non-exportable CNG/TPM key, independent worker credential or installed SYSTEM task |
| `scripts/s3-release-bundle-audit.ts`, `s3-core-broker-install-gate.ts`, `s3-core-bootstrap-delegation-audit.ts` | Offline signed release/rollback preflight, exact Authenticode signer/certificate/hash, signed import DAG, ancestry/ACL and source owner/nonce/revoke/DPAPI/atomic cutover compatibility; synthetic success still `executionApproved:false` | First-party *installed* signed HIGH Broker, real owner UAC or native SYSTEM DPAPI revoke/physical Agent 1.0.5 rollback |

**Reconciliation rule:** do not call a process worker a "durable coding-agent worker" merely because a command subprocess survives an Agent connection loss. Likewise, distinct self-host MCP/Agent bearer credentials are not separate device signing keys.

## 2. Deployment identity design (self-host **first**)

### Identities and authority (proposed, not provisioned)

1. **Local self-host worker principal:** standard **non-elevated** OS identity with its own task-specific worktree root and narrowly scoped read/write permissions. It is NOT the existing Agent principal, Task Scheduler SYSTEM account, Nexowire Hub service, or signed HIGH Broker. No service impersonation, token theft, retained privileged handles or `RunAs` escape.
2. **Independent worker device ID and key:** a new `workerDeviceId` and attested SPKI fingerprint bound to `ownerAccountId`, host identity, enrollment epoch, role=`coding-worker` and install/re-pair transaction. Never copy/reuse the Native Agent device anchor, Hub bearer token, Guardian test signer, protected Broker DPAPI key, or any other device's private key. One workspace does not inherit another's grant.
3. **Production key provider gate:** require local OS-controlled **non-exportable** key access under the distinct worker principal (Windows CNG/TPM KSP when supported) with private-key export prohibited; independent native provider and readback proof required. TEMP CurrentUser-DPAPI PKCS#8 staging signer is NOT acceptable production evidence. Unix/macOS need their own platform-key storage providers.
4. **Owner enrollment:** owner must explicitly approve the self-host worker's exact host/device/key fingerprint, task-root, capability subset, expiry and current owner epoch. Sign the canonical challenge, and consume it **once** through independently authenticated owner authority with durable non-restorable nonce/CAS and fresh key/lease readback. Possession alone grants nothing; `enrollmentAuthorized:false` until external acceptance. The human-approved worker enrollment is NOT the Windows UAC approval for elevated Broker enrollment.
5. **Revocation / rotation:** external owner revoke-start blocks new dispatch first; cancel/stop current task under its **own** OS account; mark late/lost ACK as UNKNOWN; wait for separately signed stopped/postcondition readback; disable and rotate the worker key on re-pair. Never refund quota or release reservations solely because local UI shows 'cancelled'. Old owner epoch, key fingerprint, nonce and requestId must remain invalid after rollback of local disk.
6. **Scope discipline:** worker may request its own `shell/file/git/test` capabilities via typed approved operations. Elevated Windows CORE capability stays **separate** behind genuinely signed protected HIGH Broker, #271 ACL and #587 CAS. The worker cannot use a Broker token, attach Broker PID/Job handle, reuse Agent credentials, claim local UAC, or write to protected installer/import/updater/rollback paths.

### Proposed split of responsibilities

| Layer | Owns | Cannot decide |
|---|---|---|
| #12 deployment/enrollment adapter | Worker install/package signature/rollback verification **as a future unprivileged worker**, task-root staging and published readiness truth; separate device-key integration contract | Journal mutation ordering, CAS authority, sandbox kernel policy or privileged CORE dispatch |
| #01/#02 journal/errors | Immutable requestId, owner epoch, cross-Hub CAS outcome and `UNKNOWN -> RECONCILE_REQUIRED` | Physical installed HIGH token |
| #03/#05 process and sandbox | Real child-process/Job/AppContainer/token/handle/root-relative file isolation and leak testing | Owner's enrollment grant |
| #08 progress/checkpoints | Versioned task checkpoint, verified artifact/hash refs, no raw secret dump, CAS-safe publication receipt | Retrying uncertain physical mutation |
| #04/#07 access/enrollment | Owner-signed scoped approval, key rotation/revoke, external authority readback | Reusing protected Broker enrollment |
| #14 quota | Worker steps/time/IO/token/memory reservation and authenticated final release | Refund after final ACK without proven stop/delete |
| #16 independent QA | Forged/offline/replay/denied/no-consent/crash probes | Replacing physical P0 acceptance with synthetic PASS |

## 3. Restricted task recovery (design-only state machine)

`CREATED -> ENROLLMENT_VERIFIED -> RESERVED -> STAGED -> RUNNING -> CHECKPOINTED -> (COMPLETED_VERIFIED | FAILED | DENIED)`

- **Before each mutation:** independently re-read current owner epoch/key fingerprint, task capability, worktree root, base commit SHA, diff approval scope and task budget; allocate an immutable `requestId` and durable reservation. Journal cannot silently inherit a previous task's authority.
- **Checkpoint fields:** `schemaVersion`, `taskId`, `workerDeviceId`, `ownerAccountId`, owner epoch, enrollment key SPKI SHA256, immutable requestId and issuedAt, `worktreeRoot`, repository/base/current commit SHA, path/diff digest, step index + bounded state, known external effect/receipt IDs, remaining budget, encrypted content-addressed artifacts, `pendingUnknown`, stop token/stop proof and redacted recovery reason. **No** tokens, key bytes, raw command bodies or secret environment contents.
- **After crash/restart:** local WAL validation and singleton owner are necessary but insufficient. Require *new* off-host readback: enrollment/owner epoch, grant validity, device-key identity, worktree/file contents/commit, immutable publication evidence, actual stopped or completed OS process, and any effects already committed. If there was any dispatched mutation without authenticated final effect evidence, transition **`UNKNOWN -> RECONCILE_REQUIRED`**; never replay, clone `requestId`, or silently advance step.
- **Expired/revoked/re-paired worker:** close only the worker's own task session; *never* restart a privileged Broker, silently accept the previous DPAPI blob or reuse owner UAC/Agent keys. Retry requires a freshly approved task and new requestId **after** independent reconciliation.
- **Rollback:** Git diff reset only when verified safe worktree base SHA, identical tracked file hashes, no conflicting external side effects and explicit owner rollback approval. Rolling back code files cannot undo released transfers, cloud payments, DPAPI enrollment, installed Agent/Broker updates or previously dispatched OS effects. Old signed Agent 1.0.5 rollback is a separate #551 protected installer operation, never a worker checkpoint feature.
- **Lost ACK / partial task:** show `RECONCILE_REQUIRED`, with verified effect source and exact original `errorCode`/UNKNOWN preserved. Neither `pid exited` nor `stdout drained` implies task COMPLETED_VERIFIED or external publication commit.

## 4. Source vs physical acceptance matrix

| Acceptance | Existing evidence | State / blocker |
|---|---|---|
| Current #765 signed installer, ancestor/import/old DPAPI source checks | 189/189 previous local owner suite PASS; exact commit CI attempt 2 7/7 SUCCESS | SOURCE GREEN, **executionApproved:false** |
| Trusted separate self-host worker *production* signing key | TEMP staging SPKI/DPAPI + Guardian possession source only | **BLOCKED**: non-exportable provider, separate worker principal and owner-registered key fingerprint absent |
| Worker-owner revocation surviving disk rollback | SQLite journal WAL checksum, local tombstones and signed-source epoch | **BLOCKED**: off-host non-restorable owner CAS and post-revoke readback #587 |
| Real restricted task process/file/network sandbox | ProcessWorker, ProcessManager, private Windows desktop and path-policy components exist | **UNVERIFIED** for coding-agent isolation; independent restricted token/AppContainer/root-relative native isolation #03/#05 |
| Checkpoint across restart/UNKNOWN with no replay | Workspace/Artifact Bridge checkpoint and Agent operation journal separately exist | **UNINTEGRATED**: task-step journal, authority readback and effect reconciliation #01/#08 |
| Owner local OS consent and physically installed protected HIGH Broker | #551 staged synthetic signed installer, signed import DAG and OS intent source | **P0 NO-GO**: #271 live inherited `Authenticated Users: Modify`, real native token/immutable importer/rollback, independent signed CAS, physical one-time UAC and SYSTEM DPAPI |
| Optional ephemeral cloud runner | #780 says **after self-host** | **DEFERRED**: separate short-lived cloud device enrollment, provider budget consent and sandbox; no Cloudflare/VM deployment |

## 5. Required future negative and physical tests (owner allocation, do not duplicate other branches)

- Old worker key presented for **new** owner epoch/device, shared device key across two workers, Guardian proof with unconsumed nonce, expired approval or replaced SPKI: **DENIED**, not a fallback to Agent bearer or HIGH Broker key.
- Owner revoke after task reserve but before dispatch: no new native effect. Revoke after OS effect but lost ACK: **UNKNOWN**, no new requestId or replay until independently reconciled. Two-Hub external CAS races remain P0.
- Kernel lower-integrity caller cannot write signed imported DLL/updater/rollback or access/duplicate Broker Process/Job handles. Synthetic same-user TEMP `PROCESS_DUP_HANDLE` observation is **not** a production pass.
- Process crash, failed checkpoint write, torn WAL, stale Git base, wrong root, resurrected old DPAPI blob, mismatched signed Agent 1.0.5 rollback and unknown artifact final publication: fail closed.
- Stop/cancel/revoke must prove the own worker process and all children actually stopped before task-state transition, quota release or next step. Separate stdout/stderr fast-exit failure history remains a distinct Windows Job owner regression.
- Read-only inventory and test fixture do not authorize a live signed installer, UAC click, ACL write, service/Agent restart, DPAPI secret read, Cloudflare provisioning, billed ephemeral cloud runner or VM.

## Decision / next action

**#12 conclusion:** no newly proven installer-owner P0 source defect in #765 revoked SYSTEM DPAPI / signed old Agent 1.0.5 rollback requiring code changes. Produce this deployment and enrollment **documentation only**. Self-host worker proof must precede ephemeral cloud by #780. Actual HIGH Broker stays **NO-GO** under #271/#551/#617; preserve `executionApproved:false`, `productionApproved:false`. No runtime action, credentials, cloud resources, UAC, Agent, service, ACL, DPAPI or VM touched.
