# Guardian Ed25519-signed Admin Bridge receipts (protocol only)

This is an **inert cryptographic protocol** for future Guardian-produced receipts. It does not provision keys, authorize Windows task operations, change existing Cloudflare endpoints, or deploy a Guardian.

## Envelope and signature

`src/protocol/guardian-signed-receipt.ts` validates strict v1 envelopes with:
- The exact previously validated owner/device/pairing-bound Admin Bridge intent.
- Latest owner preference audit revision.
- Admin Bridge postcondition receipt with exact request ID, device binding, mode, observation time, task state, health evidence and failure reason.
- A key ID equal to SHA-256 of the Ed25519 public key's SPKI DER representation.
- A canonical base64url Ed25519 signature over a deterministic domain-separated, fixed-field-order transcript.

`verifyGuardianSignedModeReceipt` requires a **trusted, previously registered** public key for this paired device. A public key supplied inside the HTTP request must never establish trust. The caller must also supply the current authoritative owner intent and preference revision and the current time. Validation rejects malformed, expired, altered, cross-device, cross-request or wrong-key receipts. An authenticated failed receipt remains `applied:false`. A signed false claim about Broker task state must still be rejected by trusted, independent device-local health measurement.

## Boundaries still open

- This protocol **does not prove that a signing key belongs to a physical Windows device**. Key generation, trusted enrollment/rotation and secret-key protection require an owner-approved, ACL-protected local Guardian installation. Keep signing private keys out of the Hub, browser and Worker.
- Valid signatures **can be replayed verbatim**. A separately durable atomic request/receipt ledger must enforce one completion, expiry, pairing and newest preference revision. The cloud D1 ledger exists but is not wired to this v1 signed-receipt verifier and is not production-enabled.
- A signature proves only who possessed the enrolled private key and the integrity of the signed bytes. It does not attest that local Task Scheduler evidence was truly measured, that a task was successfully started/stopped, or that a running Guardian has Elevated Windows authority.
- Existing un-signed internal receipt flow is **default disabled** and remains unchanged. No key provisioning or production public key registry is included here.
- P0 #271 (user-writable live elevated Stack source), Hub → Guardian command delivery, separate Guardian recovery while Broker is OFF, and actual local OS actuation still block production use.

Focused tests use ephemeral Ed25519 keys generated in memory; no real secret keys are written to disk or shared.
