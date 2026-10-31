# AI-02 | source contract: persistent local Windows enrollment v2

## Identity and durable enrollment

- An elevated same-SID owner must explicitly approve a visible enrollment ceremony on the **active local physical console**. Windows WTS active-console ID, protocol type (0 = local), connect state (0 = active) are read from the OS and rechecked after the visible confirmation. Remote/RDP and switched/disconnected sessions fail closed. No UAC automation.
- CNG ES256-P1363 protected grant contains owner account ID, Windows SID, device UUID, installation UUID, enrollment UUID, machine-binding hash, signer SPKI hash, generation and original consent. `expiresAt=null` is **not** a command permit or an indefinite per-command approval.
- The C#/TypeScript account grammar is `^[A-Za-z0-9._:@-]{8,128}$`. v1 Ed25519 and v2 P-256 are never interchangeable.
- Service incarnation and OS console token SID/session/LUID form a fresh witness. `bootId` identifies a service incarnation, not the kernel boot ID. Old/replayed/wrong-session proof denies.

## IPC and revocation

- Local-only `\\.\pipe\Nexowire.LocalEnrollment.v2`; maximum request/response 16384 bytes with little-endian length framing.
- Owner SID and native session/console evidence are necessary, but insufficient to authenticate the calling **Agent executable**. Any trusted client must separately verify issuer pin, signed scope, current external revoke/generation and one-use admission.
- `status` is diagnostic; a successful `attest` frame requires a witness object; `status` forbids a witness object. Both require `mayDispatch:false`, not the remote permission to execute.
- Rejected requests return generic bounded denial when the peer remains connected, or no response after disconnect/timeout. The nonce claim remains consumed after a lost ACK.
- An exclusive file-sharing fence in the protected `ProgramData\NexowireLocalEnrollment` root is held across attestation signing/response and the revoke marker's revalidation/write. A dead/stuck fence times out and denies, never bypasses revocation. A crashed process releases its kernel file handle; the durable revoked marker remains. This does **not** establish local rollback resistance.
- `scripts/local-enrollment/install.ps1` preflight additionally compares exact device/installation UUID and owner account between request and independent Agent identity; missing fields deny. This does not authenticate a caller-supplied Agent identity file.
- `scripts/local-enrollment/uninstall.ps1` defaults to read-only, and actual service removal requires existing durable revoke, exact service identity, local elevated interactive operator confirmation. No Agent/Broker deletion, no protected evidence purge.

## Cross-module handoffs

AI-03 owns issuer challenge issuance, pinned mTLS and independent verifier, persistent outside-host grant/revoke generations and replay/CAS history. The coordinator owns authenticated installed Agent identity and process/publisher trust plus shared Agent integration. AI-08 independently audits source and negative tests. AI-02 does not change those owners' files.

CORE stays disabled, never infer physical/local enrollment from synthetic fixtures. Production **NO-GO** until separate Windows SCM/IPC/TPM/reboot/offline acceptance and independent security review.
