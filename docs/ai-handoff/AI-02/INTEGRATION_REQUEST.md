# AI-02 | integration requests to coordinator / AI-03

## INT-02-01 (P0): authentic Agent-installation provenance

The installer now compares device UUID, installation UUID and owner account ID but still reads `-AgentIdentityFile` supplied at the command line. An attacker-controlled file can trivially assert the same values. Coordinator must define a protected, independently authenticated read-only identity export (including SID/owner/device/installation/generation and source path/signature/ACL provenance). AI-02 must not edit `native-agent.ts` or change the installer into a false production PASS.

## INT-02-02 (P0): authenticated pipe caller process

`EnrollmentPipe` validates impersonated owner SID, console session and logon LUID, plus an independent signed challenge; it does not attest the precise installed Agent client executable. Determine a process-handle/file-ID/publisher/launch trust API with race-resistant verification, and test same-user hostile client, challenge relay and nonce exhaustion before real admission. Same Windows SID alone is not authenticated application identity.

## INT-02-03 (P0): external revoke and restore custody

Local `revoked.json`, ACL and a software CNG key cannot establish rollback resistance. AI-03 must make remote acceptance dependent on current independently durable grant generation/revocation and consumed external CAS. Offline command admission remains denied without accepted freshness evidence. No fake owner confirmation or grant restoration.

## INT-02-04 (P1): generic error visibility

Native pipe now attempts a bounded, generic denial frame, and client rejects it. Distinguish protocol rejection from peer disconnect/timeout in protected operational logs once a verified source and privacy policy exist. Do not expose SID, signing key, challenge or protected configuration in errors.

## INT-02-05 (P1): acceptance and rollback

New source-only `uninstall.ps1` unregisters only the owned opt-in service after local revoke, preserving runtime/key/nonce/revoke evidence. No actual SCM install/remove/restart tests yet. Coordinator must provide approved disposable Windows acceptance, upgrade recovery, signed binary provenance and evidence requirements. Real devices explicitly out of scope of this Draft.

## Contract owner

AI-02 owns native service/local scripts/v2 protocol tests only. AI-03 owns independent verifier/mTLS. Coordinator alone owns Agent, release, workflow, top-level shared files and deployment decision. CORE remains disabled.
