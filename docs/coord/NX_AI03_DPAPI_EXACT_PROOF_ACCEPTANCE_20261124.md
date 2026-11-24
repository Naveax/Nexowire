# NX AI-03 — exact DPAPI proof fixture and physical acceptance boundary (2026-11-24)

Baseline #1160: `d2696376aae7a23aa9e0df01c19aa5c9b07f0595`. Separate source-only candidate. #1239, green #1247 and #1251 remain unchanged.

## Why this test change is independent

The existing read-only script `scripts/ai03-system-dpapi-acceptance.ps1` has Git blob `446a1f31466b9ee8b941be20175dc42ab01d366d`. No change to this script. Its synthetic Windows test previously checked proof shape, repeatability and nonce variation, but not the specified HMAC bytes. The targeted test now independently computes the known answer from a **public synthetic fixture**, binds the exact domain separator + NUL + 32 decoded nonce bytes, verifies the exact eight output keys and all non-acceptance flags, and rejects an unrelated envelope purpose. A SYSTEM runner no longer silently counts the ordinary-user negative case as executed. It marks that case SKIP with an explanation.

The existing branch-filtered AI-03 Windows authority workflow already invokes this exact test path on Node 22 and 24. No workflow or protected provenance matrix change. AI-08 #1252 expands other source fixtures, not this file; the lanes are independent.

## Operator acceptance — read-only, AI-09 only for physical execution

The script requires Windows PowerShell 5.1 and is **not** an elevation mechanism. Preserve existing authority; do not register tasks, elevate from this harness, change ACLs, reveal tokens, change production DPAPI or simulate a SYSTEM SID.

1. Establish exact reviewed source/release SHA, target device identity, original interactive owner, and protected destination independently. Record only non-secret metadata and bounded diagnostics. Verify script bytes against the reviewed artifact. The current script uses fixed trusted machine destination under `C:\ProgramData\Nexowire\hub-boot`; another layout is NOT_RUN/unsupported by this script, never bypass the path fence.
2. Generate a fresh one-use 32-byte random challenge for this paired observation, e.g. locally with Node `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"`. Record nonce with the observation session privately; do not reuse across devices, reruns or migration attempts.
3. In the original interactive owner's existing authorized process, run the reviewed script with `-Mode Source -Nonce <challenge> -SourceFile <verified-current-user-envelope-path>`. Determine the path using the reviewed configuration, not guessed filenames or another user's profile. Keep raw envelope contents, credentials and unsealed bytes out of logs.
4. **Only after independently owner-approved controlled cutover**, AI-09 runs the same reviewed script, same challenge, `-Mode System -Nonce <challenge>` inside an independently verified existing authorized SYSTEM context. No SourceFile override; no new task/elevation created by AI-03. If the context cannot be verified, STOP/NOT_RUN.
5. Require exit 0 from both invocations, schemaVersion 1, modes Source/System respectively, actual separately verified owner/SYSTEM identities (System exactly SID S-1-5-18), scopeVerified=true, secretContentEmitted=false, both physicalRebootAccepted and brokerEffectAccepted=false, and equal canonical 64-lowercase-hex proofSha256. Compare in the operator's private session. These JSON fields alone are not authenticated evidence; bind them to the same controlled observation, source SHA, verified host and fresh challenge using the operator transcript. Equality is **DPAPI credential continuity only**. It is not proof of reboot, native HIGH effect, signed enrollment or revocation.
6. Record separate physical acceptance for owner consent, authenticated Broker identity/HIGH token, reversible allowed effect and independent readback, STOP and durable no-replay, reboot, rollback and restored-state denial. Missing any mandatory observation remains NOT_RUN/NO-GO. No proof value or plaintext credential belongs in public PRs.

## Acceptance status

- Existing source script unchanged.
- New exact known-answer Windows fixture: PENDING exact-head Node22/24 CI.
- Actual owner/SYSTEM proof pair: NOT_RUN.
- Real native HIGH effect, physical STOP, reboot and rollback: NOT_RUN.
- Rollback of this source-only change: revert the test/doc commit on its own draft; no runtime state changes.
