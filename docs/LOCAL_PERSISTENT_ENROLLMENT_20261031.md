# Local persistent Windows enrollment

Status: architecture proposal only; no Windows service, enrollment or deployment is implemented by this document. Child of PR #982. Main, public packages and live installations remain unchanged. The user requests a Draft PR first, followed by an opt-in local build for exactly two owned devices.

## Acceptance contract

One explicit elevated local enrollment ceremony per device creates a signed, device-bound grant with no expiry. Reboot, service restart, Agent restart, idle time and loss of internet do not require renewed human approval. The owner can revoke locally without internet. Device/installation/owner identity replacement invalidates the grant. Missing, damaged, revoked or unverifiable records deny use; they never silently create another enrollment.

Persistent enrollment is distinct from permission to dispatch a particular operation. Existing authenticated owner, scope, revocation, anti-replay and native admission checks remain. Offline startup can validate the local grant without remote enrollment; absence of fresh remote admission does not authorize an otherwise blocked remote command. UAC/Secure Desktop is not automated by this design.

## Components and trust boundaries

1. A signed opt-in installer is launched with standard Windows RunAs. Its visible ceremony identifies the selected installation, device and owner SID, explains indefinite/revocable scope, and requires an explicit Enroll action. The elevated token must belong to the intended owner SID; over-the-shoulder credentials for a different administrator do not enroll silently. UAC elevation alone, task installation, or chat authorization is not an enrollment receipt.
2. A real SCM Windows service, NexowireLocalEnrollment, starts automatically as LocalSystem. Protected Program Files binaries and a ProgramData directory owned by SYSTEM/Administrators hold machine-wide state. The ordinary Agent cannot replace service binaries, signer pins, device bindings, grant files or revocation state. No Agent-held bearer token is sufficient to provision a grant.
3. A local named pipe exposes bounded status, challenge-signing and revocation operations. Reject remote clients; apply a DACL for SYSTEM and the provisioned owner SID. Impersonate each connection, verify token SID, Windows session and AuthenticationId, then revert impersonation in a finally block. Authenticate the connecting process/installed Agent as well as the user; same-user arbitrary processes must not gain an unrestricted signing oracle. There is no pipe operation that accepts caller-supplied localEnrolled/active or reinstates a revoked grant.
4. Create a non-exportable ECDSA P-256 key using Microsoft Platform Crypto Provider where supported. Explicitly report TPM-unavailable status; do not claim hardware binding for software keys. An explicitly selected software fallback uses Microsoft Software Key Storage Provider, SYSTEM-only key ACL and DPAPI machine protection plus protected filesystem ACLs. DPAPI LocalMachine alone does not protect against another local user able to read the ciphertext. Do not use a remotely supplied TPM key or manufacture hardware attestation.
5. Store a versioned, canonical signed grant containing owner account ID, owner SID, device UUID, installation UUID, public-key hash, enrollment UUID, scope, generation and original consent time. expiresAt is null. Public certificate and manifest contain no reusable private credential. Atomic replace, flush and recovery rules prevent partial writes becoming accepted grants. Do not put a wall-clock freshness deadline on the durable consent itself.
6. At boot the service verifies the grant signature, protected key identity, current machine/installation binding and durable local revocation state. It produces a fresh boot/session witness from Windows token/WTS data, with a challenge nonce and a short request validity bound. Never reuse the initial logon LUID or session epoch after reboot. Session-witness expiry does not expire enrollment or prompt the human again.
7. The Agent queries this service and validates its provisioned issuer pin; it does not calculate enrollment from writable preferences. The independent verifier authenticates device key possession and current authority state before accepting a new session witness. PR #982 supplies Node-host mTLS transport only: it is neither this service nor a Worker client-certificate binding.

## Protocol integration decision

Existing CoreNativeProofSchema v1 binds consumed human approval to one Windows session. Existing signed enrollment/response paths require Ed25519 signatures. CNG ECDSA keys cannot be passed into those paths as if they were Ed25519 keys. Implement a versioned v2 grant/session-proof envelope, explicit ES256/P1363 encoding and domain-separated canonical bytes; retain v1 verification unchanged. The mTLS transport remains reusable, but handler, independent key provisioning and authority/provider integration require explicit v2 support. Never merely relax same-session or approvedAtMs checks to make reboot appear successful.

Local enrollment first commits to protected durable state. Remote publication may remain pending during internet loss and resume idempotently with the same enrollment ID; no new human ceremony is needed. Lost acknowledgements require status reconciliation, not a new grant or replay of a consumed receipt. Signing requests bind nonce, operation, audience, device, installation, grant generation and current boot/session witness.

## Revocation and recovery

An owner-visible local revoke command stops further signing, durably records revocation before success, removes Agent admission caches and publishes remote revocation when connectivity returns. The service must not have a network dependency to honor local revoke. Uninstall preserves the revocation marker unless a separate explicit local re-enrollment ceremony creates a new generation.

Do not promise rollback resistance from a local JSON file, DPAPI or signature alone. TPM monotonic state or independently retained generation/revocation state must reject restored old grants. With software fallback and no independent current state, restored state cannot safely regain remote dispatch. Document that boundary rather than weakening the existing independent verifier.

## Planned files (not yet created)

| Path | Responsibility |
| --- | --- |
| native/windows-local-enrollment/Nexowire.LocalEnrollment.csproj | Windows service build, explicit supported target and pinned dependencies |
| native/windows-local-enrollment/Program.cs | SCM lifecycle, cancellation and bounded shutdown |
| native/windows-local-enrollment/EnrollmentStore.cs | CNG key custody, canonical signed grant, atomic persistence and revocation |
| native/windows-local-enrollment/EnrollmentPipe.cs | Local-only authenticated named pipe and bounded protocol |
| native/windows-local-enrollment/WindowsSessionEvidence.cs | Fresh token/WTS/boot evidence obtained independently of Agent input |
| native/windows-local-enrollment/EnrollmentCeremony.cs | Visible owner-bound elevated consent and explicit revocation |
| src/protocol/core-persistent-enrollment-v2.ts | Strict versioned grant/session schemas and canonical signature bytes |
| src/agent/windows-local-enrollment-client.ts | Bounded pipe client, pin validation and restart reconciliation |
| src/security/core-persistent-enrollment-verifier.ts | Independent v2 enrollment/session verification and revocation integration |
| src/security/core-native-enrollment-verifier-handler.ts | Explicit v2 endpoint dispatch without weakening v1 |
| src/agent/windows-core-console-provider.ts | Service adapter and persistent-grant/fresh-session separation |
| scripts/local-enrollment/install.ps1 | Reviewed elevated installation, exact device targeting and backup |
| scripts/local-enrollment/revoke.ps1 | Owner-visible offline revoke and independently checked result |
| scripts/local-enrollment/uninstall.ps1 | Remove only owned service/runtime; preserve revoked generations |
| test/core-persistent-enrollment-v2.test.ts | Signature, scope, replay, reboot and revoke negative tests |
| test/windows-local-enrollment.integration.test.ts | Real Windows SCM, CNG, ACL, pipe and restart acceptance |

## Build and rollout boundary

Use a separate opt-in branch and local artifact; do not add the service to the default installer, public release or automatic updater. The PR is visible repository content, even though unmerged; secrets, private keys, local tokens and identifying device inventory never enter GitHub. Build manifests must identify exact source and dependencies. A two-device allowlist belongs to protected local deployment input, not a generic public default.

Stage on one device first with validated backups and a rollback that restores previous service/task configuration without restoring operation journals or invalidated grants. Install only after service, protocol and negative tests pass. Request one genuine visible local ceremony when the actual installer is ready. Verify reboot/reconnect/revoke there before the second device. Do not reboot both devices together or stop the existing Agent before a tested recovery route exists.

## Required acceptance evidence

- Real service automatic start and key possession after Windows reboot; no synthetic native approval counted.
- Same signed grant/enrollment ID after Agent/service restart and internet interruption; fresh boot/session witness after reboot.
- Ordinary-user file/key overwrite and remote named-pipe access denied; same-user unauthorized clients cannot enroll or use an unrestricted signer.
- Changed device/installation/owner SID, tampered grant, copied protected state, stale session, wrong signer, duplicate nonce and revoked generation rejected.
- Interrupted install/write, lost response and service crash reconcile without duplicate enrollment or journal mutation.
- Offline local revoke survives reboot and blocks signing before network reconnection; restored revoked state cannot reopen remote authority.
- Both device-specific installations independently verified, with explicit TPM versus software custody evidence.

## Implementation order

1. Review this architecture and file inventory in the Draft child PR.
2. Implement and test the versioned protocol and Windows service/key/IPC components; provision independent verifier trust without test credentials.
3. Integrate the Agent and #982 transport, retaining existing dispatch gates until acceptance succeeds.
4. Build an opt-in local installer; complete the real owner ceremony, staged reboot/offline/revoke tests on device one, then device two.

Current evidence: #982 exact head 5e52b756cc6959ffacb7bcd25f2fc1ad2beccc39, CI run 41139860087 completed successfully. Its 32 local tests cover transport/handler behavior, not Windows service enrollment or live permanent access.
