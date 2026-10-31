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
