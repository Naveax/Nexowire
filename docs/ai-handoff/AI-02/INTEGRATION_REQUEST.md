# AI-02 | integration requests (source-owner boundaries)

## P0-01: independently authenticated installed Agent identity
`scripts/local-enrollment/install.ps1` validates exact owner account, device ID and installation UUID but currently consumes an operator-provided `AgentIdentityFile`. Arbitrary caller-selected matching JSON is **not** an independent identity proof. Coordinator must define a protected, authenticated installation export and readback (with owner SID, agent binary provenance, device UUID, installation UUID, generation and trusted scope), without allowing `native-agent.ts` edits from AI-02.

## P0-02: named-pipe caller executable identity
The native pipe impersonates a same-owner active console and verifies an independent signed challenge. Same-user untrusted processes may still attempt status calls, relay challenges or exhaust nonce storage. Coordinator must provide a race-safe process/file-ID/publisher/launch-identity boundary and independent native hostile-client tests. No grant or CNG key by itself is a remote dispatch authority.

## P0-03: independent reversible/irreversible revocation custody
The AI-02 local marker and file-sharing fence order native revoke vs attest, but do **not** prevent old protected JSON/key state restoration after rollback nor revoke already issued remote permits. AI-03 must require current independent externally durable grant generation and revocation, mTLS peer binding, one-use challenge and exactly-once CAS. Missing remote freshness remains deny-only.

## P1-04: real Windows SCM/IPC/installer/recovery test facility
Provide approved, disposable Windows environment for service start/stop/crash/reboot, actual active console session/user consent, changed SID/session, hostile pipe peer, ACL/key checks, interrupted install/rollback and offline revoke. The CI `--self-test` diagnostics are not a substitute for physical owner acceptance; do not target Naveax or Work-PC without separate authorization.

## P1-05: operational error reporting
The pipe returns bounded generic denials without leaking keys or SID, while timeout/disconnect can close the pipe without a response. Coordinator should define protected redacted log/incident instrumentation before integration; do not expose enrollment secret or user telemetry in logs.

**Ownership:** AI-02 `native/windows-local-enrollment/**`, `scripts/local-enrollment/**`, v2 protocol/test and own handoff only; AI-03 verifier/mTLS, coordinator shared Agent/CI/release, AI-08 independent QA. Never change somebody else's files. CORE remains disabled.

## P0-06: independently verified authority pin provenance for visible owner consent

AI-02 now displays the provisioned authority P-256 SPKI SHA-256 in the local
consent summary and rejects noncanonical DER/base64. The local owner can
inspect this fingerprint, but **nothing in AI-02 authenticates its provenance**.
Coordinator/AI-03 must provide an out-of-band trusted fingerprint/issuer pin
bound to signed installation identity and matching exact device+owner+generation,
with a reviewed UX/verification step before production. Malicious but
well-formed replacement keys remain a production NO-GO.

## P0-07 | Versioned Agent integration API, failure mapping and native trust provenance (2026-11-01)

- **Local request envelope (strict v2):** `{version:2,operation:'status'}` or `{version:2,operation:'attest',challenge:{payload,signatureBase64}}`; framing is a 4-byte little-endian byte count in **1..16384**, then exact UTF-8 JSON (no duplicate/unknown fields). No pipe operation authorizes dispatch. The independently signed authority challenge's `payload` is `{version:2,enrollmentSha256,nonce,audience:'nexowire.local-enrollment.session',bootId,windowsSessionId,ownerSid,logonLuid,observedAtMs,validUntilMs}` (30-second maximum window). The returned `attest` witness must sign the **exact same challenge payload**; a foreign nonce, SID, LUID, boot, session or audience is denied.
- **Successful response envelope (strict v2):** `{version:2,verified:true,mayDispatch:false,grant:{payload,signatureBase64},spkiBase64,keyProvider,evidence:{bootId,windowsSessionId,ownerSid,logonLuid},witness}` where `witness=null` for `status`, signed `{payload,signatureBase64}` for `attest`. `grant.payload` uses `ES256-P1363` and `physical-console` with exactly ownerAccountId, ownerSid, deviceId, installationId, enrollmentId, machineBindingSha256, issuerSpkiSha256, generation, consentedAtMs and `expiresAt:null`. **Machine ES256 is not the independent verifier's Ed25519 v1 response signature.** A self-consistent signed response or `verified:true` does not prove a trusted installed Agent, an independently pinned issuer, current off-host revocation, or dispatch capability.
- **Fail-closed errors/unknown states:** native parser and protected session mismatch `LOCAL_ENROLLMENT_REJECTED`; bounded negative IPC response `{version:2,verified:false,error:'LOCAL_ENROLLMENT_REJECTED',mayDispatch:false}`; unavailable named pipe `LOCAL_ENROLLMENT_PIPE_UNAVAILABLE`; interrupted/expired frame or disconnect **UNKNOWN/DENY** (no automatic retry after nonce consume). Installer `CONFLICTING_INSTALL_MODES`, `INSTALL_EXECUTE_OPT_IN_REQUIRED`, `LOCAL_OWNER_DEVICE_MISMATCH`, `AGENT_IDENTITY_BINDING_INCOMPLETE`, `REPARSE_POINT_DENIED`, `RUNTIME_HASH_MISMATCH`, `RUN_REVIEWED_INSTALLER_WITH_STANDARD_LOCAL_UAC`. Never reinterpret these as owner consent or fabricate `localEnrolled`/CORE active.
- **Provisioning missing:** independently authenticated installed Agent identity (device/owner SID/owner account/installation/generation + binary provenance), protected *machine key* name and issuer P-256 pin sealed against unauthorized replacement, externally pinned authority challenge SPKI, protected nonce/monotonic revoke/restore CAS, and exact mTLS certificate-bound verifier principal. A locally displayed P-256 SPKI hash and a user-supplied `AgentIdentityFile` are not authenticated installation or remote issuer pins.
- **New test distinction:** native self-tests deny Cancel/No/close results from the *owner MessageBox decision* with **no real dialog**. This is **not** a cancelled Windows UAC test; cancelled UAC, denied ACL/SCM operations, real RDP switch and hostile same-user IPC processes still require coordinator-owned disposable Windows facility. No fake physical PASS.
