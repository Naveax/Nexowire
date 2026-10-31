# AI-02 | v2 local enrollment service contract

## Native boundary

- Native .NET 10 Windows service `NexowireLocalEnrollment`; same-owner elevated *visible* local enrollment is the only grant-provisioning path.
- Grant persists until explicitly revoked; signed ES256-P1363 domain `nexowire.local.enrollment.v2\0`, linked to owner account, Windows SID, device/installation/enrollment UUID, machine binding, SPKI hash, generation and original consent time. `expiresAt=null` does not mean remote operations remain authorized.
- Owner-account identifier grammar must be the same in C# and TS: `^[A-Za-z0-9._:@-]{8,128}$`. Noncanonical Unicode/whitespace is rejected *before* verification.
- Status/attest IPC: Windows local-only named pipe `\\.\pipe\Nexowire.LocalEnrollment.v2`; 4-byte little-endian length, 1..16384 bytes JSON v2. Peer SID/session/LUID/active console is read from native OS. Only signed independently issued and scoped challenges can request a witness.
- On rejected operations where the peer can still receive data, server sends a bounded `{version:2,verified:false,error:"LOCAL_ENROLLMENT_REJECTED",mayDispatch:false}` frame. IO timeout/disconnect can still produce no response. Both paths are denial, never an ACK.
- The diagnostic client requires version 2, `verified:true`, `mayDispatch:false`, a grant and session evidence object, and no error field. This checks frame *shape only*. The Agent must perform independent SPKI pin, grant/witness signatures, current owner/device/installation, revocation and CAS admission.
- Attest consumes its nonce durably before signing and rechecks protected state; lost ACK is not retried with the same nonce. `mayDispatch=false` remains invariant.

## Installer and uninstall

- Opt-in installer is an elevated local-only explicit user action. Read-only preflight requires exact device UUID, installation UUID and owner account equality between request and independent Agent identity; missing identity fields reject. An untrusted caller-selected Agent identity JSON is **not** proof of authentic installed identity.
- New `scripts/local-enrollment/uninstall.ps1` defaults to read-only preflight. `-Execute` additionally requires exact service path/device, pre-existing persisted local revocation, interactive elevated operator confirmation, and unregisters only this named SCM service. Protected runtime, nonce ledger, keys and revocation state remain for independent recovery/review.
- No default installer, update pipeline, release or broad CORE dispatch change.

## AI-03 and coordinator handoff

AI-03 independently issues and validates expiring authority challenges, pins v2 ES256 device SPKI, authenticates mTLS client role and current owner/device/session/installation, consumes external admission once, checks current monotonic revocation/generation and denies stale/UNKNOWN. The coordinator supplies authenticated Agent-installation identity provenance and process-level named-pipe caller trust; no untrusted user-selected path is an authority. v1 Ed25519 and v2 P-256 stay explicitly versioned. See `INTEGRATION_REQUEST.md`.

All current code and tests are staged sources, not physical acceptance.
