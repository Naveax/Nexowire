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
