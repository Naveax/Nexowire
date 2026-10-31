# AI-02 | Windows persistent local enrollment v2 contract

## Authority and local consent

- An elevated owner must visibly approve enrollment from the OS-reported active local console; prior and final WTS session/protocol/state readback is required. Remote/RDP/disconnected or changed SID/session/LUID fails closed. `bootId` identifies a service incarnation, **not** kernel OS boot.
- Grant v2 uses ES256-P1363 CNG P-256 with protected machine key, linked owner account ID, Windows SID, device/installation/enrollment UUID, machine-binding SHA-256, issuer SPKI SHA-256, generation, consent timestamp, `expiresAt=null`. This record is a persistent enrollment, **not** per-operation consent or UAC/CORE execution permission.
- Native canonical text validation requires true end-of-input (`\\z`) for ASCII owner ID, SID, lowercase SHA-256 and logon LUID. JS wire schema independently rejects real trailing newlines. Signed domain prefixes `nexowire.local.enrollment.v2\\0` and `nexowire.local.session.v2\\0` must remain distinct from authority challenge bytes.
- Invalid/absent protected store, nonce replay, expired challenge, incorrect owner/device/installation or opaque session state deny. A `revoked.json` entry, even malformed or directory-shaped, denies; enumeration errors are not treated as marker absence. This local marker is **not anti-rollback authority**.

## Native IPC and revoke

- Pipe `\\\\.\\pipe\\Nexowire.LocalEnrollment.v2` is local-only, 4-byte little-endian length, 1..16384 bytes JSON v2. Impersonated owner SID and current native active-console session/LUID are mandatory. Same-user executable trust is not established by SID alone.
- `status` and `attest` both hold the protected exclusive local revoke fence while reading current state and emitting the bounded response. `attest` additionally requires an independently signed authority challenge and durably consumes the nonce before witness signing. At the last pre-send boundary, native OS session identity, grant/revocation readback, challenge deadline and cancellation are rechecked. Lost ACK never replays a nonce.
- A successful v2 response has `version:2`, `verified:true`, fixed fields `grant,spkiBase64,keyProvider,evidence,witness,mayDispatch:false`; `status` witness is null, `attest` witness is an object. Duplicate/unknown/missing fields or any `mayDispatch:true` are protocol errors. A generic bounded denial or disconnected peer is **never** a success.
- `EnrollmentClient.RequireAcceptedFrame` checks shape only; the independent Agent verifier must pin the native issuer key, verify *both* signed grant and witness with explicit scope, and require independent freshness/revocation/CAS proof. Native output alone cannot authorize execution.

## Installer / protected storage

- `scripts/local-enrollment/install.ps1` is opt-in, exact two-device allowlist, manifest/hash/runtime/owner/device/installation preflight, read-only by default (`-PreflightOnly`). Missing Agent identity fields deny. An arbitrary caller-provided `AgentIdentityFile` is not independent trusted installation provenance: coordinator P0 must supply authentication.
- `scripts/local-enrollment/uninstall.ps1` defaults to read-only; actual service-only removal requires persisted local revoke, exact binary/SCM identity and explicit interactive elevated typed confirmation. It preserves CNG key, nonce ledger, revoke evidence and original Agent/Broker.
- Host-level SCM start/stop, hostile pipe peer, crash/restart, machine rollback, hardware TPM and owner physical approval **are not proven** by diagnostic tests.

## Independent owner handoffs

- AI-03: pinned mTLS verifier, independent challenge signer, current durable grant/revoke generations, replay/one-use CAS and final dispatch gate. Deny missing freshness or UNKNOWN.
- Coordinator: authenticated Agent executable/installation identity provenance and OS process trust, signed packaging/real Win32 integration. No arbitrary caller-selected identity JSON accepted as authority.
- AI-08: independent adversarial QA on **exact PR HEAD**, not borrowed green parent SHA.

**Production verdict: NO-GO; CORE disabled; `mayDispatch=false`.**

## Visible issuer and installation binding

The user-facing `--enroll` consent text includes the requested device,
installation ID, owner account and SID, key mode and **SHA-256 of the canonical
P-256 authority SPKI** that will be stored in protected config. Noncanonical
base64, truncated DER, unsupported curve or trailing bytes deny before any
approval dialog. This is for operator visibility only: a self-consistent
attacker-provided key remains untrusted absent AI-03/coordinator independent
pin provenance.
