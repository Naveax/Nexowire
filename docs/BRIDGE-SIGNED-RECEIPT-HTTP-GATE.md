# Guardian-signed HTTP Bridge completion gate

This change makes the source-only `/api/v1/internal/device/bridge-command/receipt` endpoint **fail closed** to unsigned Hub-reported Broker outcomes.

## Command transport prerequisites

`createControlPlaneHttpHandler` now requires **both**:
1. `enableBridgeCommandTransport: true` (explicit opt-in), and
2. `getTrustedGuardianPublicKey(identity)`, a trusted current-enrollment resolver keyed by device ID, owner account and **current paired device credential binding**.

Without either requirement, **all four** command endpoints (owner issue, owner status, internal claim, internal receipt) return `503 BRIDGE_COMMAND_TRANSPORT_DISABLED`. The production Worker does not configure either opt-in or a trusted Guardian registry, so this is NOT a live Windows task control path.

The receipt endpoint accepts only `{credential, signedReceipt}` with a strict v1 `GuardianSignedReceipt` envelope. A plain unsigned `receipt` is rejected with HTTP 400, even if authenticated as Hub service and holding an Agent credential. The service fetches the claimed durable ledger command and current owner preference revision, resolves the registered Ed25519 key **independently of the incoming HTTP envelope**, verifies exact original intent + mode + owner/device/pairing + expiry + revision and the cryptographic signature, then revalidates the Broker postcondition and performs the same atomic one-time completion.

Wrong/revoked public keys cannot complete a claim. Malformed packets return bounded errors; no private keys are involved.

## What remains before any production activation

- The owner-approved **separately protected Guardian** process, recovery independent of Broker OFF, trust-bound authenticated local Hub session, secure signing-key generation/enrollment/rotation and authoritative persistent key registry do **not** yet exist.
- A signature authenticates message bytes to a registered key. Without a trusted local observer and protected process, it does **not** prove that a Windows Scheduled Task actually changed state.
- The current source-only opt-in command claim path is not hooked to a real connected Agent, and the browser preference toggle deliberately does not issue executable commands.
- Production P0 #271 remains unresolved: the legacy elevated Stack's inherited writable source must be securely cut over with explicit owner approval and independent physical validation before enabling privileged operations.
- This change is a **transport precondition**, not a mechanism to evade UAC, expand permissions or self-elevate.

Tests cover disabled and absent key resolver, owner approval, paired credential, wrong signer, signed success/failure, signature tampering, preference revocation, replay, expiry and SAFE/offline denials. No production deployment, D1 migration or Windows task change is included.
