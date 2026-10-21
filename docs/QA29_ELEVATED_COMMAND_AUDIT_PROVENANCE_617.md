# P0 #29: elevated command audit provenance, independent source acceptance

**Scope:** source-only QA, references #617, #633, #621 and #587. Branch `test/29-elevated-audit-provenance-617`. No production executor implementation was edited. This is a **synthetic acceptance model**, not real Windows audit evidence, signed Broker installation, local UAC confirmation, or an external authoritative replay barrier.

## Mandatory audit tuple

Every authenticated record binds `requestId`, `ownerId`, `deviceId`, `sessionId`, `ownerEpoch`, `coreEpoch`, execution mode, and signed request-expiry. Request IDs must be unique across owners/devices/sessions, not merely per connected socket. A distinct externally monotonic reservation counter is required before possible dispatch. The original command **body, arguments, passwords, tokens, cookies, private keys and raw stdout/stderr are not stored in this test model**. Instead, persist bounded opaque command reference, verified pipe byte counts/completion and protected output commitments; production code must evaluate sensitive-output redaction and use keyed or access-controlled digests to avoid low-entropy disclosure.

## Source-only evidence stages

| Stage | Expected independent signer / witness | Evidence |
| --- | --- | --- |
| Reservation | External CAS authority, outside Agent/Hub backup/restore domain | Unique request binding, monotonic reservation |
| Local authorization | Protected enrollment/approval recorder | Reference to *previous legitimate physical local* UAC bootstrap, signed grant, current owner/device epoch; **not UAC per command** |
| Running Broker | Independent native Windows token + release attestor | Actual High/System integrity as authorized, Administrators enabled, signed running image digest, pinned publisher, image start/file identity, protected binary/parent/import/updater ACL |
| Dispatch | Broker/kernel launch witness | PID **and** creation FILETIME, opaque command reference, unique request and session |
| Streams | Actual bounded pipe capture | Independent complete stdout/stderr byte counts and commitments, no literal sensitive data |
| Exit | OS process exit witness | Observed exit code/timeout bound to same PID + creation FILETIME; RPC HTTP 200 is not a task result |
| Postcondition | Separately authenticated readback authority | Independent expected vs observed state, result freshness, target identity and grant epoch; not asserted by the process or network ACK |
| External audit anchor | Truly rollback-independent monotonic trust root | Latest sequence and signed/hash-chained head; joint local journal+authority rollback must not restore the witness |

The fixture uses role-separated **test HMAC keys**, immutable sample process identity and a simulated external latest-anchor object. Anyone holding the in-memory fixture secrets can forge it. This is deliberate: **source test coverage is not a production trust root**. In real runtime, publisher pin, signed enrollment and OS attestation require protected keys and non-forgeable Windows observation. The local journal cannot authenticate its own rollback. Re-using an older authenticated anchor is unsafe unless the verifier retrieves the independently current monotonic head, rather than accepting the caller-supplied historical head.

## Verdict and retries

A reported `succeeded` requires all proven stages, correct sequence, authorized high token, complete stdout/stderr, successful OS exit and **independent verified postcondition**. Nonzero exit or trusted observed-state mismatch is `failed`. Missing/corrupt evidence, incompatible grants, stale token identity, missing ACK, unsupported physical evidence and a potentially dispatched but unconfirmed operation are **`unknown`**. Absence of a dispatch receipt is not proof of *no dispatch*. A distinct independently verified no-dispatch result would be needed to report denial; this QA model never fabricates it.

A late/duplicate ACK can neither advance a status nor authorize replay. After `unknown`, original `requestId` remains fenced until a fresh independently trusted reconciliation and external CAS witness exist. Never silently issue a new `requestId` for the same uncertain mutation. Revocation/re-pair/epoch mismatch invalidates stale authorization but **does not prove an in-flight elevated process was cancelled**.

## Test acceptance matrix

`test/qa29-elevated-command-audit-provenance.test.ts` contains deterministic source-only negatives for: forged success and HMAC tampering; restored journal vs newer external witness; authentic but stale witness; repeated ACK; UNKNOWN then ACK; owner/device/session/requestId/epoch substitution; revoke and signed request expiry; medium token, Administrators deny-only, altered signer or writable ACL; recycled PID/FILETIME; lost/partial stdout or stderr, missing exit and postcondition; nonzero exit despite transport success; and unsafe raw password/token/argv field insertion. No time sleeps, VM operations, filesystem writes, UAC, Broker, Agent or service interaction are executed by the test.

Reproduce **source tests** from the exact PR checkout:

```sh
npm ci
npm run typecheck
node --test --import tsx test/qa29-elevated-command-audit-provenance.test.ts
```

A separately scoped `qa29-elevated-audit-source.yml` runs only typecheck and this synthetic suite on Node 22/24. Review its exact head SHA and job conclusions; never infer CI PASS from job creation or an old green parent SHA.

## Unresolved physical/source integration blockers

1. PR #633 deliberately holds `CORE_EXECUTOR_DISPATCH_ENABLED=false`; this independent test cannot prove actual elevated Windows execution.
2. PR #621's source-only delegation and unrun D1 migration do not prove a protected signed Broker, real high token, current owner grant, or old v1.0.5 Agent compatibility.
3. #587 requires an **actually independent** external CAS/anti-rollback authority and authorized replay fence. A simulated HMAC witness, local DPAPI key or co-snapshotted SQLite DB does not close that gap.
4. Real running image file identity (including imports), publisher certificate, ACL, elevation/bootstrap transcript, secure identity of stdout/stderr readback, physically installed release/rollback and crash/revoke/reauthorize outcomes remain **BLOCKED pending independent Windows acceptance**.
5. The #03 / #04 / #12 owner implementation and ReVoltVPN-Ubuntu-Lab are untouched. This branch is an isolated independent QA artifact for #00 integration review, not an instruction to merge/deploy/enable an elevated command handler.

**NO-GO:** Physical authorized high-token and durable postcondition provenance not demonstrated by these tests.