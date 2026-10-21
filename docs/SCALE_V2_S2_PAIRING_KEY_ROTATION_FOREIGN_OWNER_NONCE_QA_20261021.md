# Nexowire #13: owner WSS issuer rotation and pairing-epoch source negatives

21 October 2026. Source baseline: #671 exact HEAD
1e9425c970219834d6488add77d53c1cdade750d,
Actions 39632434610 SUCCESS. **SOURCE STAGING ONLY / PRODUCTION NO-GO.**

## Trust boundaries exercised

- Ed25519 device possession requests include a deviceId and nonce; issuer's durable
  uniqueness table is keyed by (device_id, nonce), not nonce alone. Two distinct
  synthetic device signing keys owned by the same account can safely use the
  same nonce once EACH. Replays against either device reject; account-level
  quota remains an independent boundary.
- A trusted issuer's *public verification key* and keyId are obtained from
  the independent owner trusted-state reader, never from the signed receipt.
  After an authorized rotation old receipts reject; fresh receipts signed by
  the newly trusted issuer verify and can be consumed once.
- A valid operator-signed receipt for another owner must not be redeemed
  within a former/different account/device pairing. Legitimate foreign
  ownership can authorize its own matching receipt, not the old account.
- A WSS login, signed quota reservation, and CORE UI preference remain
  separate from a real Windows elevated access token or Broker delegation.

## Actual negative gap and source-only mitigation

An initially valid, as-yet-unredeemed operator-signed v1 receipt could be
redeemed after **same device ID re-pairing with a different public key**, when
the new reader pinned that new public key but the profile revision was left
unchanged. The original test on the unchanged #671 head FAILED: Missing
expected rejection. The receipt v1 wire signature binds account, device ID,
session generation and profile revision, but NOT the device signer SPKI hash.

A separate opt-in, disposable staging SQLite guard fixture now defines
triggers that atomically advance the independently read WSS minimum profile
revision whenever an existing device signer row changes key/enabled state,
is inserted/replaced/deleted, or a paired owner/device enabled state changes.
This causes pre-repair signed receipts to fail validation before the WSS
connection journal consumes them.

**Important:** The original shared enrollment fixture is unchanged. This
guard is **not** a production migration and is NOT implicitly installed by
other callers. The staging test explicitly loads the guard only after owner
accounts, devices, keys and revisions exist. Production must integrate
equivalent attested monotonic pairing generation/revoke behavior, ideally
with a receipt v2 signed device SPKI or per-pairing epoch. No deployed pairing,
OAuth or operator DB schema was changed by this test PR.

## Test cases

- Same nonce across two independently signed device proofs, one issuer
  receipt each; per-device duplicate proofs rejected; per-owner separate
  receipt journal acceptance.
- Real trusted operator public key/keyId rotation: old operator receipt
  rejected and new signed receipt accepted by refreshed independent trust.
- Foreign owner receipt signed by genuine trusted operator rejected under
  former owner, while correctly bound foreign owner receipt succeeds.
- Same device ID public key rotation invalidates old *unconsumed* receipt;
  correctly signed new device receipt advances profileRevision.
- Revocation and re-enabling of same device key cannot resurrect old receipt.
- Pairing owner change A->B->A cannot resurrect old owner signed receipt.
- INSERT OR REPLACE of native signer row also bumps revision and blocks old.
- Missing or stale current owner authority remains fail-closed as covered by
  #671 + #630 and their independently passing source tests.

## Physical and production non-acceptance

Synthetic device key pairs and SQLite rows are **not** two real physical
devices or a TPM-bound key lifecycle. CNG Ed25519 remains unsupported on
previously probed Windows KSPs; P256 presence or DPAPI CurrentUser does not
attest non-exportable TPM binding. The guard fixture's revision is not
rollback-proof or protected from a hostile local DB operator. Two-Hub
distributed monotonic CAS, actual Cloudflare Named Tunnel, trusted OAuth
issuer rotation, real TLS certificate rotation, signed Agent canary,
CORE Broker high-integrity token proof and 100+ live WSS remain BLOCKED.

#612 separate async device proof/nonce pinning remains DRAFT and is NOT
cherry-picked into this child of #671. No live Agent, VM, Cloudflare,
OAuth secrets, TPM, Broker or elevated UAC operations were performed.

Source QA only. Do NOT treat green CI as production release authorization.
