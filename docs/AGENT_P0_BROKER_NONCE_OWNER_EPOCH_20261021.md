# P0 #587 Broker dispatch nonce / owner epoch QA

21 Oct 2026 | Own #01 source-only child of PR #702 (HEAD 576eab8926c8257c13a47fa1be806554e2ecd190; hosted CI 39646460335 7/7 SUCCESS).

## Review of PR #669 Access authority
Access PR #669, SHA 99894af2c224d80ce4edeb71c1e98701f6c22ab8, carries distinct numeric ownerEpoch and grantGeneration in native and remote attestations. Its displayed EFFECTIVE status expressly keeps canDispatch:false. No dashboard/CORE preference may be used to issue a Broker dispatch permit. The new gate requires independent protected native high-token evidence plus fresh remotely signed proof. #03/#04 implementation files are untouched.

## Security amendment
The Broker dispatch request and protected Broker evidence now include an independently verified numeric ownerEpoch, distinct from grantGeneration. The signed remote dispatch permit must agree with both and with device, owner, session, capability, requestId and fingerprint.

Every beginIfCurrent generates a new 32-byte cryptographic challenge, sent over HTTPS, and demands the identical challenge in the Ed25519-signed remote permit. A previously signed permit resurrected from a rolled-back local SQLite WAL cannot authorize a different dispatch attempt or a restarted Broker process. The remote authority must itself enforce single-use atomic permits: this local nonce is defense in depth, not independent durable storage.

When remote begin has already reserved a claim but is delayed returning the signed permit as revokeAndDrain stalls, the locally revoked gate releases the unused claim, prevents effect execution and lets remote drain finish. Unknown release or revoke stays fail-closed with no replay.

## Adversarial evidence
15/15 focused source tests PASS, including (a) 28 duplicate dispatch attempts and single execution, (b) a reserved but unreturned claim racing stalled revoke, (c) real isolated SQLite WAL backup/restore resurrecting a validly signed duplicate claim, rejected by a fresh nonce after a new Broker instance, (d) local and remote ownerEpoch mismatch and valid Ed25519-signed wrong owner epoch, (e) forged owner revoke approval, (f) real disposable loopback TLS begin/revoke/release, and (g) lost ACK and missing high-integrity evidence. TypeScript typecheck PASS. External CAS in these tests is synthetic and is NOT a physically deployed non-restorable authority.

## Unproven release gates
A separately administered, rollback-external monotonic CAS service with durable claim reserve/revokeAndDrain, secured signing keys and authenticated device credentials remains undeployed and untested. Protected Windows Broker effective token/image/ACL and physical revoke cancellation belong to #03/#04 and require signed provider evidence. Real Agent 1.0.5 migration, two-device canary, WAL backup/restore across physical devices and rollback-independent receipt readback are pending.

P0 #587 OPEN. Production NO-GO. No live Agent/DB/UAC/VM changes, no automatic UNKNOWN replay.
