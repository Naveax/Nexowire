# #35 WSS pairing/enrollment writer authority: source contract, production BLOCKED

Base main inspected at 754cc4364822be5fda528f54042fb22a84f19924.
Owner: NEW isolated src/product/pairing-writer-authority-contract.ts; no
changes to #13 WSS, #485 production ControlPlaneService/D1, or #07 OAuth.

## Observed boundary and source gaps

1. ControlPlaneService.consumePairing reads a challenge, checks the token,
   writes putDevice, resets multiple preferences/leases, then calls
   putPairing(consumed.record). These are separate calls, NOT one atomic
   consume-and-enroll transaction. D1ControlPlaneStore.putDevice is an
   INSERT ... ON CONFLICT(id) DO UPDATE; putPairing likewise upserts and
   does not compare consumed_at IS NULL before modifying devices.
2. #792 OAuth strict authenticateOwnerForExternalWriter yields only an
   authentication snapshot; oauthSessionEpoch is not WSS pairing epoch,
   issuer key epoch, signed device possession or dispatch permission.
   #792 DRAFT head 11ac2b320b4b1843d3f39b1b7e50c72add469b46.
3. #720 WSS DRAFT head f79b3cce45b9334598ea7acb39873d1231dc1594
   improves an opt-in disposable SQLite pairing revision guard. This is
   NOT a cross-Hub, non-restorable external CAS or production D1 migration.
4. owner-public-wss-device-issuer-proposal.ts uses an atomic nonce insert
   only within its staging SQLite transaction. The signed WSS enrollment
   lease checks owner state around reservation, but final off-host commit
   versus revoke-start is not guaranteed by these local checks.

## Provider-required atomic contract (not implemented here)

A trusted, separately provisioned operator must supply an independently
reviewed linearizable, non-restorable owner/device authority supporting:

- commitPairing: immutable original requestId + intent fingerprint;
  exact expected ownerEpoch, pairingEpoch, issuerEpoch, owner/device,
  signerSpkiSha256, realm (self-host or cloud) and nonce digest. Atomic
  operation across PAIR/REPAIR/REVOKE and owner revoke-start; monotonic
  pairing epoch/high-water must survive snapshot rollback and failover.
- readCurrentPairing: authoritative fresh current owner, device, realm,
  signer, all epochs, revocation state, original request fingerprint and
  commit witness with verifiable provider incarnation/high-water. Cached
  OAuth bearer, WSS signed profile, local DB row and restored checkpoint
  are NOT authoritative reads.
- claimEnrollment: atomic one-time nonce use bound to original requestId,
  fresh current owner/session and signer SPKI, expected pairing/issuer
  epochs, realm and verified device possession. Concurrent Hub claims,
  signer replacement, expired owner and revoke-start must not both commit.
- REPAIR and REVOKE use one shared serialization domain. During a race
  exactly one wins. A stale repair cannot revive a revoked owner or key.
  Provider outage, lease expiry, epoch rollback or conflicting request
  payload under identical requestId must STOP.
- Signer SPKI pin is a digest of DER SPKI of device public key. A signature
  alone cannot prove current owner authority or Windows HIGH/CORE rights.
- Self-host/cloud have disjoint issuer keys, credentials, authority realms
  and explicit migration grants. Never infer cloud ownership from self-host.
- Commit ACK lost after the invocation = UNKNOWN; read-only reconciliation
  with the same original requestId and independent high-water witness
  is mandatory. No automatic new requestId, retry, blind replay, device
  credential activation, native effect or grant promotion.
- Real provider acceptance requires cross-Hub concurrent tests, process
  crash/disk snapshot restore tests, revocation linearization, partition
  recovery, lost ACK/duplicate delivery, signer rotation, issuer rollback,
  and current-owner logout checks. One process mutex, local SQLite, a D1
  ordinary upsert, test fixture, and arbitrary claimed supportsCAS:true
  are NOT acceptable provider evidence.

UnboundPairingWriter implements the public operations but returns
BLOCKED for all read/write/claim operations. It performs no external
calls, no credential writes and no enrollment. pairingAcknowledgementLost
only labels an uncertain externally issued operation UNKNOWN with the
original request ID and no replay permission. It is not a CAS implementation.

## Acceptance status

- Source contract/hostile disposable TEMP fixture may pass without production
  acceptance; the race reproduction intentionally models unsafe sequential
  calls rather than acting on the production store.
- No external provider capability, non-restorable CAS witness or atomic
  pairing-credential replacement has been verified.
- PRODUCTION BLOCKED until #13/#485 provider integration, #07 strict
  owner-bound principal and real two-Hub/restore acceptance are reviewed.
- No Cloudflare D1 deployment, live Agent, Broker, UAC, VM, user files,
  OS/native rights or main merge in this change.

## NEXT2 exact seam and cross-owner review (2026-10-23)

- #818 previous exact HEAD `8e99588a92098c78df67bb55d9e17d94ddb035a0`, CI
  `39862502930`: Node22/24 and four other jobs SUCCESS; macOS LaunchAgent
  lifecycle FAILURE at `src/agent/native-agent-lifecycle.ts:399`,
  `launchctl bootstrap` error 5. This source path is unchanged by #35;
  **CI remains FAILURE**, and the job result cannot be called pairing proof.
- #42 DRAFT #819 exact HEAD `55f1cf7d83c772a1eff5fc52eb6fb09ec002fca2`,
  CI `39862509470` 7/7 SUCCESS, is a read-only worker reconnect
  contract. It separately binds `ownerEpoch`, `oauthSessionEpoch`,
  `pairingEpoch`, `issuerEpoch`, signer digest, originalRequestId and
  logicalMutationId. It cannot consume WSS pairing or authorize dispatch.
- #07 DRAFT #792 `authenticateOwnerForExternalWriter` provides a
  frozen **authentication-only** principal and `oauthSessionEpoch`. That
  epoch must be checked **in the same authoritative commit ordering as
  logout/revoke-start**. No cached principal snapshot is enough.
- #13 DRAFT #720 supplies an opt-in local SQLite revision fixture, not a
  distributed operator. A signed WSS profile is not a one-use claim.

### Exact intended producer / consumer handoff, NOT a runnable provider

The #35 *unbound* adapter continues to return `BLOCKED` on every operation.
The intent now has a **separate `oauthSessionEpoch` and `issuerId`**;
`readCurrentPairing` and `claimEnrollment` require the **original requestId
and original intent fingerprint**. Their presence is a correlation/schema
check only. The source cannot compare them against authoritative state.

Required independent authority transaction for `commitPairing`:

1. Pin the trusted operator issuer/configuration and realm (self-host vs
   cloud), verify strict current #792 owner principal, client and resource;
   obtain original requestId, fingerprint, exact current ownerEpoch,
   oauthSessionEpoch, pairingEpoch, issuerId/issuerEpoch and device SPKI.
2. Under **one non-restorable linearizable authority** compare all expected
   values against current owner + OAuth logout state + device + issuer +
   pairing state; require expiry under provider clock, and serialize
   ENROLL/REPAIR against `REVOKE_START` and logout-start for the same owner
   and device. A successful revocation fence cannot be followed by an old
   epoch repair. Store immutable requestId/fingerprint, nonce reservation,
   monotonic new epoch, and durable outcome under one commit decision.
3. A one-use `claimEnrollment` must atomically verify the original
   committed intent, current epochs, signer possession and unused nonce,
   consume the nonce and publish the authoritative credential-generation
   activation. **A D1 projection must not activate a credential before
   this authoritative decision**, or allow older putDevice/putPairing
   upserts to restore an earlier generation. Distinct self-host/cloud
   issuer keys and credentials remain separate, with explicit migration.
4. `readCurrentPairing` must support read-only reconciliation for the
   exact original requestId and fingerprint and return a verified durable
   outcome plus independent non-restorable high-water/issuer incarnation.
   A missing local row, HTTP timeout or provider partition cannot prove
   that the previous mutation never committed. Lost ACK always `UNKNOWN`;
   no blind retry even with identical requestId, and never a new requestId.
5. Worker #42 and native execution separately require task/worktree/source
   SHA, logicalMutationId, originalRequestId, WSS generation, device owner
   generation and final externally fenced dispatch-vs-revoke CAS. Pairing
   success alone grants **no** native capability or Windows HIGH/CORE.

Provider review must demonstrate two distinct Hubs and physical service
partitions, concurrent REPAIR-vs-REVOKE_START and logout race, nonce double
claim, owner A->B->A, signer/issuer rotation, lost ACK readback, DB snapshot
rollback/failover, and deterministic precedence of authority outcomes.
A client-side `supportsCAS` switch, constructor injection or local SQLite
transaction is not an admissible implementation. **Production P0 NO-GO.**

## NEXT4 contract delta and precise native proof barrier (2026-10-23)

Inventory reconfirmed at `main` `754cc4364822be5fda528f54042fb22a84f19924`:
`ControlPlaneService.consumePairing` executes `getPairing` ->
`consumePairingChallenge` -> D1 `putDevice` (unconditional upsert by ID)
-> reset lease/prefs -> D1 `putPairing` (unconditional consumed update).
No shared atomic one-use enrollment nonce, owner revoke-start admission or
device-credential generation comparison exists at this actual source seam.
#818 prior exact HEAD `1c37f241d33d318d4fc1b6cca97c3bb5445b3c62`,
Actions `39869582708` 6/7: Node22/24 successful, physical Windows
`test/windows-job-owner.test.ts:216` fast-exit stdout capture negative failed.
This is NOT a #35 source test failure and must not be masked.

#42 #819 now exact HEAD `8394b9472ca4540cb7849b8943932aeb17b4bc84`,
Actions `39869733813` SUCCESS 7/7 (source-only). Its
`WorkerMutationIdentity` includes pairingRealm + WSS/device signer epochs
but still cannot supply the external pairing authority or protected grant.

The NEXT4 #35 **input contract**, with no provider, now also binds expected
`deviceGeneration`, `credentialGeneration`, `revocationEpoch` and
`issuerSpkiSha256` (issuer operator signing key, distinct from the device
`signerSpkiSha256`) into original request fingerprint and claim. The
provider must compare these values, along with `oauthSessionEpoch`,
`ownerEpoch`, `pairingEpoch`, `issuerEpoch`, full original request and
nonce against CURRENT state in a shared REPAIR/REVOKE_START transaction.
A caller supplying numerically larger generations is not authoritative.

`UntrustedPairingGenerationReceipt` is only a forward-looking schema:
owner+issuer+device+credential generation, nonce consumption, original
request fingerprint, provider incarnation/high-water and signature.
It is NOT signed by this module and is NEVER used as a grant. The
`UnboundPairingWriter.requireNativeGrant` method ALWAYS returns BLOCKED,
including with forged, replayed, cross-realm or apparently signed receipt
fields. A real trusted provider must securely pin an independent signing
identity and verify canonical signatures and current non-restorable
high-water before any separate external native dispatch-vs-revoke CAS.
This is not implementable from the existing SQLite/WSS/D1 staging objects.

**Atomic device credential boundary:** the source owner of
`ControlPlaneService.consumePairing` and `D1ControlPlaneStore.putDevice`
must change projection activation so no Hub can authenticate a new credential
until externally committed one-use claim and device generation are current.
Immediately after a revoke-start, neither delayed D1 UPSERT nor a stale
signed receipt may reactivate an older credential. Return UNKNOWN on
commit/ACK ambiguity; never retry or mint new request identity.

Required external-provider test: two independently hosted Hubs with
REPAIR-vs-REVOKE_START racing and OAuth logout concurrently, atomic one-use
nonce consumption, owner A->B->A re-pair, issuer/device key rotation,
provider partition, lost ACK, DB restore/rollback, high-water and current
owner readback, including a native grant denial without a signed provider
witness and independent final native effect fence. No in-process mutex,
unconditional `supportsCAS` flag, local SQLite fixture or signed WSS
hello can satisfy this gate. P0 production NO-GO; no live source edited.
