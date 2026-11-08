# Windows WebAuthn component for initial CORE owner verification

This supplies a native Windows WebAuthn assertion path and independent
cryptographic verifier. It is one component of the missing protected approval
authority, NOT a completed installed consent service, trusted authenticator
registration, native Windows receipt, production credential or CORE grant.
All result types keep `coreAuthority=false` and physical acceptance NOT_PROVEN.
No production factory, enrollment route or hard enable flag is changed.

The intended ceremony is initial enrollment for persistent, revocable CORE,
not a per-command prompt or replacement of CORE with a short ROOT lease.
The protected provider must retain the owner approval and separately validate
current Windows sessions, native Broker integrity and each CAS admission.

## Native assertion

`windows-core-webauthn-approval.exe --probe` loads only System32's Windows
WebAuthn API and reports version availability. It never creates UI, credentials,
consent or authority. The build and CI tests invoke only this read-only probe
and invalid invocations; no valid interactive assertion is attempted in CI.

An explicitly requested `--assert <rp-id> <64-hex-challenge> <credential-id-hex>`
requires the active local console and Default input/thread desktop. It invokes
`WebAuthNAuthenticatorGetAssertion` with REQUIRED user verification, an exact
pre-provisioned credential and an independently issued transaction challenge.
Windows Hello or a supported security key performs the authenticator ceremony;
no Forms/MessageBox result, timestamp, UI flag or automated approval fallback
is accepted. A scoped cancellation ID and a bounded cancellation thread are
used. Failure/cancel/unavailable stays denied. The protected parent must still
enforce its own hard deadline on this held helper process and treat lost output
as UNKNOWN, never retry a consumed enrollment.

The helper does not create a credential, use RunAs, elevate, switch desktops,
send input, install a task/service, modify ACLs or enroll a device. Its unsigned
stdout cannot authenticate its own process/code/Windows logon provenance.
The installed authority must hold and verify the native helper identity and
independently read the exact owner SID, Windows logon and current session.

## Independent verification and one-use storage

The challenge hashes owner/device/installation/enrollment IDs, owner/grant/revoke
epochs, Windows SID/session/LUID/session epoch, RP, pinned credential ID, a
fresh random nonce and a two-minute ceremony deadline. The native component
constructs exact bounded, non-cross-origin `webauthn.get` client data. The
verifier checks its original bytes, RP hash, canonical encodings, UP+UV flags,
strict ES256/P-256 key pin, user handle and signature counter. Synced/backup
credentials, unknown extensions, substituted identities, forged signatures,
stale challenges and counter rollback are denied in this initial profile.

Counterless authenticators are supported only with explicit durable atomic
challenge/nonce consumption. `consumeCoreWebAuthnApproval` requires that
separately implemented store and matches its exact original challenge, scope
hash, credential pin and counter transition. It checks both wall and monotonic
deadline after the await. Missing/mismatched/unknown ACK never grants anything.
There is no production in-memory/file fallback or automatic replay.

## Remaining real service and physical acceptance

The relying-party domain and credential/public-key/user-handle mapping must be
independently provisioned. No default domain, registration, key or credential is
invented. Authenticator attestation/custody policy and hardware-backed key
registration remain separate work: a mathematically valid software test key
can sign UP/UV flags and does not prove real human presence or a genuine TPM.

Still required: protected signed native service/IPC and publisher chain;
account-to-Windows-SID provisioning; independent current kernel readback;
rollback-independent challenge/receipt consume implementation; remote verifier
composition; trusted permanent-parent enrollment/current-logon delegation;
signed installation and physical approval/revoke/restart tests on both PCs.
No native assertion or live enrollment is performed by this change.

The tests generate software EC fixtures, explicitly marked synthetic, to prove
cryptographic rejection behavior and one-use interface behavior. Windows CI
only proves MSVC compilation/API availability. It is not physical enrollment,
native containment, deployment or production acceptance.

Primary API/format references:
- https://learn.microsoft.com/en-us/windows/win32/api/webauthn/nf-webauthn-webauthnauthenticatorgetassertion
- https://learn.microsoft.com/en-us/windows/win32/api/webauthn/ns-webauthn-webauthn_authenticator_get_assertion_options
- https://www.w3.org/TR/webauthn-2/
