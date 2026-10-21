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


## 22 October cross-owner reconciliation: PR #719 / #709 and two-Hub lost-ACK QA

**No new feature or production change.** #712 parent code unchanged.
Reviewed exact HEAD #719 \`597191102dabc22e22c7f9822a026bbd12d60c52\`,
GitHub Actions \`39659394811\` SUCCESS. Access #04
\`access-queued-job-review.ts\` verifies a signed, current CAS *readback*
for queued CORE/ROOT status, not a mutating dispatch authorization. A past
dashboard EFFECTIVE or a signed readback alone is never a \`beginIfCurrent\`
permit and cannot bridge owner/revoke races. #719 does not deploy the
independent off-host CAS.

Reviewed exact HEAD #709 \`b083004b9ab8c18125a428cf74f3e97f7adf4e88\`,
GitHub Actions \`39658979397\` SUCCESS. Its
\`audit-core-broker-protected-tree.ps1\` validates a strict base64 JSON
path-inventory request and Windows ancestor ACL evidence. That source CI
does not attest a **physically installed, signed high-integrity Broker
process**, complete transitive imports, independent effective token or
protected running-image handle. Do not substitute a protected-tree fixture
for \`verifyEffectiveBroker\` production attestation.

New deterministic #01 tests exercise **two independent
BrokerExternalDispatchFence instances sharing one fake CAS authority**:
- Same requestId concurrently submitted by Hub A and B yields exactly
  one successful dispatch, one refusal and one effect.
- Hub B receives Hub A's old valid Ed25519 permit from a misbehaving
  cache; per-attempt nonce rejects it without executing.
- Hub A already has an admitted, waiting effect while Hub B requests
  revoke. The external fake commits revoke and advances generation but
  its ACK is lost. Hub B returns UNKNOWN; both Hub A and Hub B reject
  further dispatch, never automatically reissue the mutation.
- Hub A's **release ACK** is lost while Hub B's revokeAndDrain is waiting.
  Remote claim is already released and drain finishes; both instances
  refuse additional work after revoke.

Test evidence: \`test/broker-external-dispatch-fence.test.ts\`
**17/17 PASS**, \`npm run typecheck\` PASS before publication of this
test/documentation-only update. The two-Hub test is **not** two physical
machines or a real network witness: it models two independent gate
instances with one serialized in-memory CAS. It does not establish
durable CAS availability, genuine crash persistence, signed installed
HIGH Broker identity or cancellation of actual Windows processes.

P0 #587 remains OPEN, production NO-GO. No live Agent, database,
UAC, VM or ReVoltVPN-Ubuntu-Lab changes; no UNKNOWN replay.
