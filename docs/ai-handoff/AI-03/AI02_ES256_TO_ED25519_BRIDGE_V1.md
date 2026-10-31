# AI-02 → AI-03 | v1 handoff contract for native ES256 grants and independent Ed25519 receipts

**Contract version:** `nexowire.ai02-ai03.bridge.v1` (design and test handoff only; **not a deployed or trusted API**).
**Ownership:** AI-02 owns protected Windows CNG signer/console and enrollment; AI-03 owns the verifier-side mTLS/Ed25519 response and protected PostgreSQL consume; coordinator owns authenticated Agent installation identity, cross-system composition, source pins, rollback-resistant revoke/generation and production PKI.

## Three independent trust roots, four signed domains

| Artifact | Signer/algorithm | Signed input domain | Independent verifier requirement |
|---|---|---|---|
| AI-02 durable grant v2 | installed device CNG **ECDSA P-256 SHA-256 / IEEE P1363** | `nexowire.local.enrollment.v2\\0` | Device SPKI from authenticated installation/owner custody, not `spkiBase64` returned by an untrusted pipe |
| AI-02 fresh witness v2 | same protected device CNG **ES256-P1363** | `nexowire.local.session.v2\\0` | Same verified device key; exact challenge nonce, owner SID, boot incarnation, Windows session/LUID, grant hash, time window |
| AI-02 authority challenge v2 | separately pinned local authority **ECDSA P-256 / P1363** | `nexowire.local.session.challenge.v2\\0` | Independently provisioned authority SPKI; the grant's `issuerSpkiSha256` identifies this authority, **not** the device grant signer |
| AI-03 verifier HTTP response v1 | independent, protected **Ed25519** signer | `nexowire.native.consent.response.v1\\0` | Pinned Ed25519 SPKI, exact request hash, nonce, origin, peer cert, grant/revoke/session readback and one-use ledger |

The native v2 signed grant/witness and v1 Ed25519 signed response are **not interchangeable**. Never reinterpret an ES256 64-byte P1363 signature as a 64-byte Ed25519 signature, change `version` fields, or reuse one public key for the other. A structurally valid signature over attacker-provided SPKI is **not authenticated provenance**.

## Proposed versioned handoff envelope (not yet implemented)

This is the **logical schema** to be implemented by the independent protected coordinator; no client-controlled claims are authorization inputs:

```json
{
  "kind": "nexowire.ai02-ai03.bridge.v1",
  "version": 1,
  "localGrant": {
    "format": "ai02.signed-grant.v2",
    "algorithm": "ES256-P1363",
    "payload": "exact AI-02 Grant v2 object",
    "signatureBase64": "canonical P1363 bytes",
    "deviceSpkiDerBase64": "device key candidate, not a trusted pin"
  },
  "localSession": {
    "format": "ai02.signed-session.v2",
    "payload": "exact AI-02 Session v2 object",
    "signatureBase64": "device witness signature",
    "authorityChallengeSignatureBase64": "independent challenge signature"
  },
  "protectedCustody": {
    "source": "independently authenticated readback, never request JSON",
    "deviceKeyPinRef": "opaque installation-bound pin reference",
    "authorityIssuerPinRef": "opaque independently provisioned P-256 issuer pin reference",
    "ownerEpoch": 1,
    "revokeEpoch": 0,
    "grantGeneration": 1,
    "windowsLogonSessionEpoch": "independently authenticated UUID",
    "currentRestoreWitnessRef": "opaque rollback-resistant generation/restore reference",
    "currentSessionWitnessRef": "opaque live WTS token/session/LUID evidence",
    "singleUseClaimRef": "opaque durable nonce and receipt CAS reference"
  },
  "target": {
    "format": "ai03.core-native-proof.v1",
    "signerAlgorithm": "Ed25519",
    "signedResponseVersion": 1,
    "issuerSpkiSha256": "independently verified authority issuer fingerprint"
  }
}
```

Strings marked `opaque` are **references**, not user-supplied permission flags. This proposal deliberately does not specify a serializable secret or a shortcut from a signed local grant to `accepted:true`. Production schema fields, signature canonicalization, certificate-bound machine admission and issuer/key rotation must be reviewed by AI-02/coordinator before implementation.

## Mandatory scope mapping and unprovided values

| Source | Target v1 proof/expected | Required validation |
|---|---|---|
| AI-02 `ownerAccountId`, `deviceId`, `installationId`, `enrollmentId` | exact same-named values | Full-byte canonical identity scope; protected original installation identity, not caller JSON |
| AI-02 `ownerSid` | `windowsUserSid` | Fresh impersonated token/WTS owner readback |
| AI-02 `generation` | `grantGeneration` | **Separate durable current generation CAS**, not old grant alone |
| AI-02 `consentedAtMs` | candidate `approvedLocallyAtMs` / `approvedAtMs` | A persistent enrollment timestamp is **not** a new per-operation human approval. v1 one-use approval remains unavailable without independent physical approval semantics |
| AI-02 service incarnation `bootId` | session freshness witness only | **Not** interchangeable with Windows kernel boot UUID or v1 `windowsLogonSessionEpoch` |
| AI-02 fresh `windowsSessionId`, `logonLuid` | v1 `windowsSessionId`, `windowsLogonLuid` | Re-read OS at actual authorization/effect boundary; compare with signed challenge and stored receipt |
| AI-02 `issuerSpkiSha256` | v1 expected issuer and protected ledger issuer | Verify from external trusted issuer custody, **not** only matching request or DB row |
| No AI-02 equivalent trusted source | v1 `ownerEpoch`, `revokeEpoch`, `windowsLogonSessionEpoch`, `challengeId`, `receiptId` | Mandatory independent protected allocator/readback and one-use durable reconciliation; never invent/default or cast |

## Acceptance state machine and failure classification

1. **DENY** if local grant/device key/authority pin mismatches independent protected custody; if ECDSA verification fails; if owner/SID/device/installation/generation or TLS certificate principal differs; if challenge nonce/session/epoch is replayed, expired, revoked or replaced.
2. **UNKNOWN** if current issuer/restore witness, one-use CAS, final OS readback, mTLS peer/cert state, ledger commit/ACK or protected signer custody is indeterminate. Do not retry an uncertain consumed nonce/receipt or mark owner approval.
3. **ALLOW-TO-VERIFY-ONLY**, never dispatch, only after independent live CNG grant + session witness + issuer challenge verification; certificate-bound mTLS; separately verified owner/revoke/generation/epoch; PostgreSQL one-use consume and post-COMMIT readback; Ed25519 response bound to the exact v1 request/nonce/hash. The v1 result remains `mayDispatch=false` unless independently reviewed Broker/CORE gates exist.
4. **Rotation/reenrollment** requires a protected, externally authenticated new device/issuer/client-server pin generation and owner-visible reenrollment. The old key/epoch must remain revoked and replay history durable; never silently adopt a newly observed key from a native response or a test CA.

## Cross-team blockers / test evidence

AI-03 **does not** own the actual protected Windows `readProtectedNativeBinding` implementation, owner presence, provisioning or TLS server certificate production keys. A disposable localhost CA and software P-256/Ed25519 test keys prove rejection code paths only, **not owner approval**. AI-08 must validate the combined integration SHA with revoked/rotated issuer, stale owner/device, changed ownerEpoch/revokeEpoch/grantGeneration, wrong session/LUID, lost ACK and one-use replay, as well as the D1 pre-native-readback completion race. Absent production bridge: CORE **NO-GO**, `CORE_EXECUTOR_DISPATCH_ENABLED=false`.
