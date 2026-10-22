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
