# AI-05 cross-owner integration requests

**Requests only. Do not change another AI's files from this branch.**

## AI-04: Broker admission + signed effect receipt

A protected per-effect Broker must re-check the original immutable request UUID, capability, fingerprint, owner/device/session generation, readback and exact wire payload at actual dispatch time. A grant or external CAS reservation is not itself a native permit. Preserve global tombstones/UNKNOWN after lost ACK, restart and revoke; `created:false` must never execute a callback. Provider authenticity must be established independent of Agent process state and synthetic receipts.

## Coordinator: native-agent, operation journal and CI

Coordinator owns `src/agent/native-agent.ts`, `src/agent/operation-journal.ts` and `.github/workflows/**`. Wire the original approved deep-frozen request into the protected Broker callback without reconstructing it from a mutable input. Keep WAL restart/recycled-frame safeguards, and do not retry mutations after ambiguous CAS/HTTP outcomes. Integration must preserve released v1.0.8 startup behavior. The Windows `browser-live` job has previously run long within its console/DPAPI stages; investigate independently if full CI cannot finish. AI-05 does not edit the workflow.

## AI-07: real OS sandbox

Each `shell.exec`, subprocess, graph or nested effect needs a verified independently isolated low-privilege worker, descendant/handle/network/environment containment and revoke/drain witness. A signed Core grant or Job Object alone is not kernel isolation proof. Provider absence/UNKNOWN must deny execution.

## Physical operator acceptance

Only independently authorized owner-side Windows tests can verify real enrollment, UAC/ACL, signed Broker image, two-PC restart/revocation, protected local record, protected CAS custody and restore resistance. Source CI passing does not replace these gates.

## Executor-approved callback descriptor binding
When coordinator and AI-04 integrate a real protected Broker callback, send only validated plain frozen `requestId/capability/fingerprint/scope` data with the canonical JSON bytes used by the executor. Accessors, Proxy wrappers, additional fields and nested owner/session substitutions must remain terminal DENY. AI-05's source-level check is not a substitute for independent Broker-side signature and OS admission.

## Coordinator P0/P1 investigation: #974 journal worker IPC timeout
CI [41201707887](https://github.com/Naveax/Nexowire/actions/runs/41201707887), exact previous AI-05 SHA `1b3f78d1647847373401a6248e209f6d3e212f25`: Windows `browser-live` job failed at `Verify recycled WAL and consecutive journal process restarts`. `test/agent-journal-restart-regression.test.ts` reported `Journal worker timed out:` at line 44 for the 1,307-record, six crash/clean restart #974 scenario. This was its child IPC timer of **30 seconds**. It does not prove checksum corruption, and equally does not justify dismissing a real hang. Other 30 tests passed, one skipped. The later source CI 41204241838 passed that initial WAL step on Windows, suggesting non-determinism but **not** closing the issue. Investigate child process scheduling, worker IPC/exit timing, blocked reads and runner contention; retain the original WAL/UNKNOWN assertions. Only coordinator owns the test, journal implementation and workflow: AI-05 must not modify them or inflate timeouts as a substitute for a root cause.

## Coordinator and AI-04 executor admission handoff
The AI-05 executor accepts only a detached frozen original Broker request, with exact capability/fingerprint and owner/device/session epochs and generation validated from own descriptors. Integrate this with AI-04's independently authenticated permit/COMMIT and native effect readback. Do not replace the approved callback with a mutable caller-owned request. The source-only hard stop `CORE_EXECUTOR_DISPATCH_ENABLED=false` must remain until the physical signoff.

## AI-04 Broker handoff: immutable bytes, fingerprint and failure semantics (2026-11-01)

**Pre-CAS source snapshot.** `prepareCoreWindowsMutation(capability,input)` accepts canonical JSON data only. Nested data is copied synchronously from own enumerable data descriptors; getter/setter, Proxy, symbol, sparse/hidden array index, non-enumerable or inherited/extra authorization keys, non-finite numbers and cycles fail closed. It recursively sorts object keys and freezes the resulting detached tree with null prototypes. The exact Broker input bytes are `UTF8(canonical({capability,input:frozenInput}))`. `brokerBody` is that canonical JSON string; `fingerprint=SHA256(UTF8(brokerBody)).hexLowercase`. A separate assertion compares these bytes to `JSON.stringify({capability,input:frozenInput})`; a mismatch denies dispatch. Broker HTTP `POST /execute` serializes this same `{capability,input}` shape, but **do not** infer authenticity of a request from matching JSON alone.

**Full immutable request to authenticate.** Pass the detached `snapshotCoreWindowsDispatchRequest` record: `requestId` (UUID), `capability`, `fingerprint`, `scope:{ownerId,deviceId,deviceEpoch,sessionEpoch,ownerEpoch,expectedGeneration,requiredPrivilege}`. Scope must match the signed external CAS reserve/commit receipt and the protected Broker's fresh owner/process/session/privilege readback. The callback receives only the frozen approved request bound to exactly those original fields and exact input bytes. Separate `beginIfCurrent` + `commitIfCurrent` must atomically serialize against revoke/re-pair and reject `created:false`, duplicate requestId, stale owner/grant/revoke epochs, expired/unknown permit, lost ACK and any scope swap **before native effect**. A 200 response with unreadable body is **UNKNOWN**, not a safe commit/denial ACK. The protected Broker must enforce callback count **0** on any non-admitted outcome; AI-05 cannot validate this physically while `CORE_EXECUTOR_DISPATCH_ENABLED=false`.

**Action required from AI-04/coordinator:** publish real protected Broker admission receipt format, exact signed input digest, verified image/HIGH token/ACL/process witness and cancel/revoke/drain semantics for the immutable request. An independent CAS custody/rollback report and OS effect-boundary permit are also absent. **BLOCKED / production CORE NO-GO**; no change to `executors.ts` or other owners' Broker/native files.
