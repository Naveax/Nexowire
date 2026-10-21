# P0 #25: Broker-crash ACK and ROOT/readback negative QA

**DRAFT / SOURCE ONLY / PRODUCTION ELEVATION BLOCKED.**

## Verified parent
Parent PR #688 HEAD: 4bc4ccdbb1ab69e39f25ee6577b1dcc018a3b72e.
Exact hosted workflow 39644726990: completed SUCCESS, all 7 jobs successful.
Stack: #688 -> #654 -> #643 -> #633. This child makes only one new test
and this document. No #03/#04 owner implementation edits.

## Security acceptance matrix

| Scenario | Expected negative behavior |
| --- | --- |
| CORE revoked before dispatch | No new launch; cancel alone cannot prove no-effect; signed never-dispatched witness required |
| Broker crash after dispatch, ACK delayed/duplicated | requestId never reused; duplicate ACK idempotent; effect remains MUTATION_UNKNOWN |
| Two contradictory signed ACKs | Quarantine conflict, do not claim success or auto-replay |
| Crash, owner re-pair, old ACK | Historical requestId still reserved globally; old scope cannot authorize new launch |
| Observer unavailable/failed/unsigned | MUTATION_UNKNOWN, never fabricated VERIFIED or CANCELLED |
| Broker ACK presented as postcondition | Rejected: independent observer key and immutable output evidence required |
| Wrong signer, altered output hash, wrong epoch, wrong launch, stale sequence | Rejected. Even a correctly signed wrong output digest cannot promote the result |
| ROOT dispatch at 899999 ms | Synthetic admission can pass before deadline |
| ROOT dispatch at 900000 ms, including backdated signed witness | Deny; trusted clock wins over stale signed timestamp |
| ROOT expires after dispatch | Prior potential OS side effect still UNKNOWN until authentic independent readback |
| Reusable enrolled CORE for multiple commands | No repeated per-command UAC, no actual elevated dispatch |

## Source versus physical truth

The test imports the real PR #633 evaluateCoreBrokerExecution function.
CORE_EXECUTOR_DISPATCH_ENABLED=false is asserted. Its synthetic candidate
result is not permission to launch an elevated process.

All Ed25519 keys, signatures, crash/restart events, ACKs, ledger,
and independent readback receipts live in one unit-test process.
TestOnlyDurableOracle is an in-memory *specification*, not off-process CAS
or native Windows evidence. A locally signed fixture is not independently
authenticated OS readback, no matter how valid the cryptographic signature.

Current production source checks ownerRevoked before pendingMutationUnknown.
GRANT_REVOKED therefore cannot be mistaken for proof that an existing OS
effect was cancelled. Broker crash, timeout, ACK, revoke, job stop and ROOT
expiration cannot undo irreversible mutations. Preserve MUTATION_UNKNOWN
and prevent automatic replay until independent immutable postcondition is
available, positively bound to historical owner/device/credential,
grant/session epoch, requestId, launch identity and output digest.

## Production NO-GO requirements

1. Rollback-resistant external requestId and dispatch journal with global
   uniqueness across owners, epochs and restarts.
2. Native monotonic pre-effect fence, signed owner delegation, protected
   high-integrity Broker, trusted EXE/import/updater publisher/ACL identity.
3. Truly independent authenticated immutable OS readback and
   fail-closed recovery after crash/duplicated ACK.
4. Strict ROOT 900,000 ms at native dispatch, CORE persistent owner approval
   with no repeated per-command UAC.
5. Authorized real hardware acceptance. No live Agent, Broker, elevated
   shell, VM, UAC or ReVoltVPN-Ubuntu-Lab actions in this branch.

## Reproduce

    npm ci
    node --test --import tsx test/core-broker-crash-ack-readback-negative.test.ts
    npm run typecheck

A green source test cannot establish installed privilege or production safety.
