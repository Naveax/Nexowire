# P0 Worker #25: post-launch revoke, lost ACK and postcondition QA

**Source-only acceptance / DRAFT / production elevation BLOCKED.**

## Exact base and scope

The original QA parent is PR #643, inspected HEAD
`3e5117abbc449607ecfa3c727c56815d719f4d49`, whose only files were
`test/core-owner-revoke-mid-execution.adversarial.test.ts` and
`docs/CORE_OWNER_REVOKE_MID_EXECUTION_QA_20261021.md`.
Parent CI run **39626754232** had all seven jobs marked SUCCESS on inspection,
but the workflow API still returned `in_progress`. This is not a verified
whole-workflow SUCCESS. Do not rerun or duplicate any active workflow.

This follow-up adds only:
- `test/core-owner-postlaunch-unknown.adversarial.test.ts`
- this document.

It is stacked on PR #643, whose base is PR #633.
No #03 / #04 / #01 owner implementation edits or native privileged activity.

## Security invariants and explicit observed source limitations

The fixture imports the actual `evaluateCoreBrokerExecution` implementation
from PR #633. It also contains **SimulatedWitness**, an intentionally small
test-only source reference model. It has zero external storage, zero Windows
native attestation and zero actual process dispatch. Every launch is just an
append to an array. Its local map is **not** durable/external monotonic CAS.
Receipt `origin: 'independent-readback'` is synthetic test data only and
**is not** genuine independent evidence.

| Race / forgery | Test-only expected outcome | Native acceptance still required |
| --- | --- | --- |
| Revoke AFTER launch, BEFORE postcondition | MUTATION_UNKNOWN, not CANCELLED | Independently durable dispatch receipt, native process status and trusted postcondition |
| Cancel before any dispatch (proven in synthetic journal) | CANCELLED_NO_EFFECT | Trusted linearizable no-dispatch receipt |
| Cancel AFTER possible send, duplicate lost ACK | MUTATION_UNKNOWN and exactly one synthetic launch | One globally reserved requestId; no replay on missing ACK |
| Owner re-pair mid-flight | New owner cannot inherit old requestId/receipt | Owner/device/credential/epoch/session binding and atomic witness fencing |
| ROOT expires during already-running operation | No new dispatch; old effect stays UNKNOWN | Native fence at 900000 ms and authoritative monotonic time |
| Fake success from client/Broker, wrong launchId or stale owner epoch | Does not promote postcondition | Independent authenticated readback of actual target state, process identity and launch |
| Genuine independent postcondition after revoke (simulated) | Historical EFFECT_VERIFIED, never CANCELLED | Trusted source and tamper-evident old grant attribution |
| Two CORE commands under one enrollment | No repeated per-command UAC; source-only candidate | Installed signed high-integrity Broker and owner-approved persistent delegation |
| Revoke + pending mutation UNKNOWN | Actual gate returns GRANT_REVOKED; witness oracle says MUTATION_UNKNOWN | Fix runtime status precedence/journal reconciliation before production |

### Important negative finding

The source admission gate currently checks `ownerRevoked` before
`pendingMutationUnknown` and returns `GRANT_REVOKED` when both are set.
This is a permission decision, **not proof of no effect** if the command
already crossed a native execution boundary. Similarly, the gate always
returns `privilegedExecutionOccurred:false`, because this source module
has `CORE_EXECUTOR_DISPATCH_ENABLED=false`. That field cannot be used to
prove an already-started OS process was cancelled.

A real Windows Broker must expose distinct `authorization_state` and
`mutation_effect_state`. Revoke may deny *new* commands immediately, yet
an in-flight task can still have partially completed. `TerminateProcess`,
close handle, stop job, timeout, HTTP 200, exitCode 0 and `consent.exe`
presence do not prove no side effect. Mark a mutation cancelled only with
authoritative never-dispatched evidence; after possible dispatch, reconcile
to VERIFIED_EFFECT / VERIFIED_NO_EFFECT / UNKNOWN using trusted provenance.

### Required future owner contract (not implemented by this QA)

1. Independently owned **off-process atomic CAS** reserves requestId across
   all owners/generations and binds ownerAccountId, deviceId, credential,
   owner epoch, CORE/ROOT grant generation, session epoch, action digest.
2. After reservation, perform an atomic pre-effect lease/fence. A revoke
   that commits before this fence prevents any dispatch. If dispatch wins,
   cancellation stays UNKNOWN until readback/receipt is independently proven.
3. Treat duplicate ACKs, missing ACK, interrupted sessions and owner re-pair
   idempotently. Neither re-enrollment nor clock rollback grants a second
   dispatch. Native postcondition must bind the original historical launch,
   not the replacement owner.
4. ROOT is limited to an externally anchored fifteen-minute window.
   Expiration stops new privileged work; it does not reverse existing OS
   mutations. Recheck per independently side-effecting operation.
5. Durable CORE reuses previously authorized signed Broker for multiple
   broad preapproved commands without per-command UAC; no synthetic evidence
   can waive local first-time physical enrollment, high token, pinned
   Authenticode release or parent/import-tree ACL checks.
6. Source request schema lacks an explicit `sessionEpoch` and grant
   generation. The fixture tests owner epoch/credential and documents the
   missing native binding, rather than fabricating it.

## Reproduction

Node.js 22 or 24 (and repository locked dependencies):

~~~sh
npm ci
node --test --import tsx test/core-owner-postlaunch-unknown.adversarial.test.ts
node --test --import tsx test/core-owner-revoke-mid-execution.adversarial.test.ts
npm run typecheck
~~~

CI must be interpreted at exact branch SHA, distinguishing targeted source
tests from physical acceptance. No live UAC, Broker, Agent, VM, ACL change,
real OS process, or ReVoltVPN-Ubuntu-Lab modification is permitted.

Production status: **BLOCKED** until #03 and #04 native high-token admission,
off-process monotonic witness (#01), readback and trusted cancellation
semantics are integrated and independently tested on approved hardware.
