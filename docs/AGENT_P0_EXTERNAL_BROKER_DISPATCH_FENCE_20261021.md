# P0 #587 | Independent external Broker dispatch fence | 21 Oct 2026

**Owner:** #01 Agent Operation Journal / anti-rollback.
**Base:** PR #676, exact head \`b935a594a68c2ba3e043b0731e5eb6d01081fa07\`, CI \`39634099233\` **7/7 SUCCESS** verified.
**Scope:** Additive source-only dispatch gate, HTTPS transport and adversarial tests on a separate DRAFT PR. No #03/#04 Broker/Access implementation or #18 QA files edited, and no live database, elevated token, Agent, VM, service or physical filesystem outside isolated test fixtures changed.

## Why a reservation is not Broker authorization

A historical monotonic mutation requestId reservation (including \`created:true\`) cannot itself prove that **right now** the authenticated owner/device/session still has effective CORE or unexpired ROOT and an actually elevated Windows Broker. A restored journal, WAL or signed owner approval cannot grant execution. A local SQLite/provenance check is not authoritative.

The new \`src/agent/broker-external-dispatch-fence.ts\` makes executing the effect contingent on:

1. A strictly parsed request with owner UUID, device UUID, device epoch, authenticated session epoch, expected delegation generation, CORE/ROOT mode, UUID, capability and SHA-256 fingerprint. The identity resolver MUST use protected authenticated credentials, never a UI boolean or request input.
2. An independent \`verifyEffectiveBroker\` callback that must attest a **genuine signed protected image, high-integrity Windows token and protected parent/import ACL**, bound to a broker UUID. This is an interface/contract; the real Windows owner code is NOT wired in this PR.
3. An **online, newly acquired, atomically single-use** external \`beginIfCurrent\` dispatch claim, serialized in the remote authority with owner/device/session generation revocation and root expiry. The signed Ed25519 payload is bound to exact broker, request UUID, fingerprint, capability, owner/device/session generation and privilege, expires within at most 5000 ms and is not reusable. Even an authentic stale signed claim must not be accepted offline, because the client contacts the authority again for **every** dispatch.
4. Only then does the injected effect callback run. It is never invoked for denial, UNKNOWN or receipt mismatch. After completion the external claim is released. A failed release fences further local dispatch pending reconciliation.

The new \`src/agent/https-broker-dispatch-authority.ts\` implements real HTTPS-only, bounded deadline, protected broker credential resolver, no redirects or HTTP fallback; endpoints:
\`/v1/broker-dispatch/begin\`, \`/commit\`, \`/revoke-and-drain\`, \`/release\`.
No hosted remote authority was deployed. The external service MUST atomically check/retain state; this client does NOT make a second SQLite directory or signed claim rollback-independent.

## Concurrent dispatch and revocation contract

- Local \`revoke()\` immediately fences additional dispatches and calls the remote atomic \`revokeAndDrain\`, which MUST stop new claims and wait for **all previously admitted leases** to finish or fail UNKNOWN.
- A claim returned while revocation is pending is released and not dispatched. Exact signed revocation receipt with advanced generation and a \`drained:true\` assertion is checked; if response is stalled/UNKNOWN/forged, local fence remains closed.
- A claim admitted **before** revoke may already have dispatched a side effect. Remote drain semantics require a real protected Broker cancellation mechanism for in-flight operations, not implemented in #01's additive files. High-token/ACL/physical effect verification remain #03/#04 ownership.
- A local per-process fence alone is **not** durable across a crash or Agent restart. Remote generation fencing MUST be independently durable and checked again by every new Broker instance. If remote restore makes revoke disappear, the system is unsafe.
- Lost ACK after remote claim or revoke is **UNKNOWN**: no blind retry and no mutation replay.
- In-memory claim IDs detect replay within this process, while the external CAS is responsible for global uniqueness and surviving crash/restart; never count the local Set as an authority.

## Negative source evidence

\`test/broker-external-dispatch-fence.test.ts\` exercises the actual dispatch gate against a clearly labeled **synthetic remote CAS**:
- 28 concurrent duplicate dispatch requests, only one callback runs.
- Signed correct vs forged Ed25519 dispatch permit; signature scope binding.
- Real owner Ed25519 signed revoke approval vs different attacker key.
- Wrong owner/device/session epoch, missing real-Broker attestation and missing high token.
- A running admitted effect plus revoke (drain), stalled revoke, refused dispatch while revoke pending, release lost ACK, UNKNOWN revoke and signature denial.
- Real isolated SQLite WAL + backup/restore changes an old local authorization record to active again, but external revoked generation denies execution, including with a new gate instance.

\`test/https-broker-dispatch-authority.test.ts\` exercises real TLS against an isolated disposable HTTPS server and ephemeral CA, a genuine signed receipt, forged signer rejection, credential authentication, begin/release/revoke, HTTP and query/userinfo/redirect downgrade rejection. **The server uses synthetic in-memory state**. No real remote durability, physical key custody or trusted broker is asserted.

Parent #676 CAS adapter and P0 #587 negative tests remain separate; no independent #18 QA files altered.

## Physical threat model and release acceptance

| Attack/failure | Source expected | Remaining physical gate |
| --- | --- | --- |
| Historical signed CORE token replay after revoke | External online begin serialized with current grant generation | Real remote monotonic CAS and protected auth credentials |
| Agent journal + SQLite WAL / local DB rollback | No authorization without fresh external claim | Actual restore and immutable off-machine witness |
| Concurrent reserve vs revoke | Atomic begin/revokeAndDrain linearization; local pending fence | Real remote multi-host contention, force-exit/cancel |
| Forged owner/grant/dispatch signature | Pinned Ed25519 verification, exact identity scope, deny | Protected signing key and trust-anchor custody |
| Stalled revoke / ACK lost | No new local effects; UNKNOWN fenced, no retry | Durable pending-revocation state after Broker crash |
| ROOT at 900000 ms | Contract binds privilege to current remote grant | Real DB clock, physical expiry and Broker token readback |
| High-token Broker protection | Contract requires effective signed protected high-integrity attestation | #03/#04 physical Windows UAC/ACL, service identity |
| External CAS storage rolled back | **UNSAFE** if revoked generation / UUID is forgotten | Independently operated non-co-restorable monotonic authority |

**PRODUCTION NO-GO / #587 OPEN**: No independent non-restorable witness, no signed protected Broker dispatch integration, no physical two-device test. Work PC and Naveax live Agents are still v1.0.5; no live upgrade was performed.

## #01 2026-10-27 release owner-scope hardening (source contract only)

Previously `release(dispatchId)` allowed the HTTPS client to send only the UUID.
A remote implementation that trusts a shared Broker credential could let a caller
release/drain another owner's claim. The `release` contract now sends:
`{dispatchId, brokerId, request:{requestId, fingerprint, capability,
scope:{ownerId,deviceId,deviceEpoch,sessionEpoch,ownerEpoch,
expectedGeneration,requiredPrivilege}}}`.
The provider MUST match **every field** against the claim's **immutable
original reservation**, and authenticate the credential as the enrolled Broker
for that same owner/device/session. It MUST NOT accept release by guessing
a claim UUID, and MUST NOT reauthorize using an already revoked live grant:
releasing the original claim must still be possible during revoke-and-drain.

The disposable CAS fixture and isolated TLS test server now reject different
owner/device/session/generation, broker, and fingerprint release. Successful
release is single-use; unknown or lost release acknowledgement fences subsequent
dispatches in the current process. Remote tombstones and drain history MUST
survive Broker, Hub, database, VM and backup rollback, or remain unavailable
(fail closed). A `409`, timeout, bad receipt or release outcome UNKNOWN does
not authorize replay. A revoked owner may **reconcile by inspection** with
operator supervision, never by retrying the OS effect.

### Required independent provider and operator evidence (NOT provided)

1. Deploy a physically separate owner-authorized provider offering durable,
   linearizable `reserveIfCurrent`, `revokeIfCurrent`, `rePairIfCurrent`,
   `beginIfCurrent`, `commitIfCurrent`, `revokeAndDrain`, and scoped
   `release`. All use one independent monotonic owner/device/session fence and
   request UUID / dispatch tombstone domain, atomic against revocation.
2. Supply the actual immutable/non-co-restorable high-water anchor and prove
   restoration of BOTH the Agent/Hub persistence AND remote service backup
   cannot reinstate an already consumed UUID or revoked generation. Disjoint
   directory or separate database instances are not sufficient.
3. Protect the authority signing private key, pinned public key, TLS identity,
   per-Broker credential and owner enrollment outside untrusted Agent/VM
   snapshots. Rotate/revoke compromised credentials using operator-controlled
   procedures with independent audit events.
4. Produce signed exact-scope reserve/commit/revoke receipts, authenticated
   Broker evidence from #03/#04, and physical two-device contention,
   lost-ACK, forced-crash and rollback canary logs. Neither CI nor tests here
   supply an independently deployed server, credential or physical proof.
5. No live CORE enablement, release, deployment or main merge until independent
   acceptance. Any missing/ambiguous evidence remains **PRODUCTION NO-GO**.


## 2026-10-27 #01 async HIGH readback vs signed receipt expiration

The protected Broker proof must be freshly re-read after the asynchronous
`beginIfCurrent` and `commitIfCurrent` admission, and **immediately before**
the effect callback. The reattestation owner epoch, grant generation, signed
protected image, effective HIGH token, parent/import protection and Broker ID
must match the original request and claim. Failure fences the device locally
and releases the reserved claim without replaying the effect.

Even the final protected token readback is asynchronous. An Ed25519 reserve or
commit receipt that was valid *before* that await may expire *during* it.
Therefore the source gate independently rechecks (a) the reserve receipt expiry
after the pre-commit HIGH readback and (b) the committed receipt expiry after the
final HIGH readback, synchronously before the callback. Expiry denies and
locally fences subsequent dispatches. The external authority must also enforce
its own atomic lease/epoch/revoke/ROOT-expiry policy.

Deterministic negative tests in `test/broker-external-dispatch-fence.test.ts`
advance an injected clock during the second/third protected readback. They
assert **zero OS callbacks**, no remote commit after an expired reservation,
release of expired claims, and no mutation replay on retry. This is source
contract evidence only. A JavaScript callback cannot prevent kernel-native
token downgrade or revoke after the last readback: real protected Broker
admission/cancel barriers and effective Windows token evidence are still
required from #02/#03, together with independent durable CAS and physical
two-device rollback/revocation acceptance. Production remains **NO-GO**.


## 2026-10-27 #01 durable reservation when begin ACK is lost

The external authority MUST durably tombstone the immutable mutation
`requestId`, bound to the complete original request and Broker scope, in the
same atomic operation that reserves its dispatch claim and before acknowledging
it. If the response is lost after reservation, repeating begin with that same
`requestId`—including from another Hub or Broker process and with a fresh
`challengeNonce`—must reject or return a non-authorizing UNKNOWN outcome. It may
not allocate a new dispatch ID or issue a new permit. A release must not erase
the request tombstone. UNKNOWN is reconciled by inspection; never retry the
mutation under a fresh request ID.

An isolated HTTPS transport regression also persists a request tombstone,
then destroys the first response after reservation. It verifies that the client
does not retry by itself and that another Hub using a fresh nonce receives only
a denial for the same request UUID. Its TLS server and storage are disposable
in-memory fixtures, not a deployed or rollback-resistant provider.

Within a single Broker process, the same request UUID is held in a local
in-flight admission set through callback completion and remote release. A
concurrent duplicate is denied before a second CAS call and cannot fence the
winning attempt. This only prevents same-process races; the external durable
tombstone remains mandatory across Hubs and restarts.

The deterministic regression test forces the synthetic authority to persist
the request UUID and claim, then lose the begin ACK. It verifies that Hub A's
callback does not run, Hub A remains locally fenced without a second authority
attempt, and Hub B cannot obtain a second claim with a new nonce. The local
fence is defense in depth only; new Hub instances still depend on the independent
durable authority tombstone.
This is only a test fixture: it does not prove that an independent production
provider exists, is durable, or survives its own backup/restore. The real
provider, protected credentials, monotonic restore canary, and physical
multi-Hub/lost-ACK acceptance remain external requirements. Production remains
**NO-GO**.


## 2026-10-27 #01 fail-closed receipt time checks

The Broker accepts a configured permit lifetime only from 1 through 5000 ms,
and snapshots that bound at construction. A non-finite, fractional, non-positive,
throwing, or backwards clock reading makes this Broker clock untrusted and
denies the operation. If an invalid clock is observed after a known reservation,
the device is locally fenced and release is attempted; no effect is retried.

The clock and TTL tests use an injected source and a synthetic authority. A
nondecreasing process-local reading does not prove that the host clock was
initially correct, advances continuously, or survives restore. The independent
CAS authority must enforce its own trusted time, generation and revocation
policy; a real protected time source and physical acceptance remain required.
Production remains **NO-GO**.


## 2026-10-27 #01 revoke after an UNKNOWN dispatch

A local execution fence after begin or release UNKNOWN blocks new effects,
but it must not prevent the first separately authenticated owner revoke from
reaching `revokeAndDrain`. The Broker records an in-flight revocation before
the authority call and never retries it after UNKNOWN, lost ACK or receipt
failure. An invalid owner approval that was rejected before any authority call
may be replaced by a new valid approval; dispatch stays locally fenced.

The deterministic tests simulate durable reservation with a lost begin ACK,
operator reconciliation of the fixture claim, remote drain, lost release ACK,
and lost revoke ACK. The tests do not implement a real independent authority
or prove physical drain or restoration behavior. Production remains NO-GO.


Revocation input is parsed into a frozen scope before asynchronous owner
approval. Each remote revoke-and-drain call includes a fresh random challenge;
the signed revocation receipt must echo that exact challenge. A copied signed
receipt from an earlier call is rejected. This is a wire-contract change:
providers must accept and sign `challengeNonce`; old responses fail closed.
A nonce does not prove that a provider's storage survives rollback or that
physical drain completed. Those external acceptance conditions remain open.
