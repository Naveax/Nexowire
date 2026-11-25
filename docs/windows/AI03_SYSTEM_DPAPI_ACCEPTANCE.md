# AI-03 | SYSTEM DPAPI and Broker physical acceptance

Status on 2026-11-11: **NO-GO / physical SYSTEM execution NOT_RUN**.

## Scope

- scripts/ai03-system-dpapi-acceptance.ps1 is read-only and does not install/start/stop tasks or elevate a process.
- **Source mode** reads the original user's CurrentUser DPAPI control-plane service token. **System mode** reads the fixed LocalMachine envelope at C:\ProgramData\Nexowire\hub-boot\control-plane-service-token.machine.dpapi.json.
- System mode requires the actual process SID S-1-5-18, verified non-reparse ancestors, trusted ownership and confidential directory/file ACLs. Ordinary user READ ACEs on machine DPAPI ciphertext are denied.
- Both modes calculate an HMAC-SHA256 using a common fresh 256-bit nonce and fixed context. Equality proves same secret under the two process identities; it does NOT confer authority or establish Hub networking, Broker effects, reboot or rollback acceptance.
- No credential plaintext, envelope, token hash or private key is printed. The script always reports physicalRebootAccepted=false and brokerEffectAccepted=false.

## Physical acceptance procedure

1. Preserve the old Hub, CORE revocation and STOP fences. First finish AI-01 / AI-04 reversible protected SYSTEM cutover including protected state receipt, using the already authorized operator path.
2. In the original user context, identify the CurrentUser control-plane service-token DPAPI path from the persisted Hub launcher without printing its contents.
3. Create a new nonce with PowerShell:

    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $nonce = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
    [Array]::Clear($bytes, 0, $bytes.Length)

4. In the original interactive user session run (substitute only the actual existing file path):

    $src = & 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -NonInteractive -File '.\scripts\ai03-system-dpapi-acceptance.ps1' -Mode Source -Nonce $nonce -SourceFile '<existing-current-user-dpapi-file>' | ConvertFrom-Json

5. After physically completing the controlled cutover, run the same checked-in script **inside a separately authorized SYSTEM session**, with the same nonce and no SourceFile override:

    & 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -NonInteractive -File '<trusted-script-path>' -Mode System -Nonce '<same-nonce>'

6. Compare both proofSha256 values in trusted operator memory. Require exact equality, scopeVerified=true, real S-1-5-18 token, the canonical machine file and protected ACL readback. Missing or mismatched proof is FAIL / NOT_RUN, never PASS.
7. Independently require authenticated Broker effect admission; preserved CORE revoke/STOP fences; installed SYSTEM Hub PID/port; real post-boot service credential use; a controlled Windows reboot and rollback with no duplicate/UNKNOWN replay. Never infer these from the HMAC.

## Work-PC evidence (2026-11-11)

- Work-PC online. Interactive session: DESKTOP-ONDD84S\umut, Elevated=false.
- Nexowire Privileged Broker: Scheduled Task Running, principal umut, Interactive/Highest, LastTaskResult 0x800710E0. Its own authenticated health: version 1.0.8, reachable=true, elevated=true, status=READY, effectAdmissionState=LEGACY_UNKNOWN. Hence effect authorization is unverified.
- User Hub task Running; the earlier unelevated `not installed` report did **not** establish absence of the protected `Nexowire Hub Boot` task. Its actual identity and visibility required an independent Task Scheduler COM inspection. The 2026-11-13 read-only inspection returns `access-denied`; task absence and authority to replace it remain **UNVERIFIED**.
- Local-owner CORE STOP and legacy console STOP both present. Encrypted grant envelope remains present. Do not clear a revoke fence because old ciphertext still exists.
- AI-03 acceptance tests: 4 PASS. Targeted Broker/credential regressions: 47 PASS / 1 SKIP / 0 FAIL. Typecheck + build PASS.
- Real SYSTEM DPAPI verification, physical reboot, protected cutover and Broker effect admission remain NOT_RUN / unverified.

## Security and provenance

The source evidence is diagnostic. The protected receipt, actual installed runtime, live health, full exact-HEAD hosted CI and physical acceptance must be checked separately. Do not weaken ACLs, forge SYSTEM identity, bypass UAC, clear local CORE revocation, print secrets, or manually rerun a workflow already active for an identical SHA and inputs.

## Work-PC addendum: 2026-11-13, source accepted, physical cutover still NO-GO

This addendum supersedes any earlier inference that an unelevated task query proving
"not installed" establishes physical task absence. Never install or replace a task
on the strength of that query.

- Main integration Draft PR #1160: exact GitHub and clean Work-PC commit
  `5efab6c7a96c0115cfb2b07bdb2583854f527040`.
- Exact-commit General CI `43405984858`, Release Readiness `43405985009`,
  and AI-03 Windows Control Plane Authority `43405984991`: **SUCCESS**.
  CI acceptance does not authorize installation, local-owner enrollment or reboot.
- Read-only `Resolve-Nexowire-LegacySystemHubTask.ps1 -Action Inspect`
  returned `taskName=Nexowire Hub Boot`, `visibility=access-denied`.
  This is neither a confirmed absent task nor a task XML/SDDL backup.
- Hub loopback health responded HTTP 200. CORE state is `REVOKED_LOCALLY`
  and `localEnrolled=false`. Broker authenticated probe reported
  `ready=true`, `elevated=true`, but `effectAdmissionState=LEGACY_UNKNOWN`.
  No privileged effect was attested.
- SYSTEM pre-login Agent is not installed and remote recovery before sign-in
  is not verified. Unattended reboot readiness remains false.
- Read-only full user-Hub state fingerprint covered 218 files / 53,966,718 bytes
  with SQLite `quick_check=ok` and 2,861 idempotency records. The first
  fingerprint attempt did not complete; a later attempt succeeded. The successful
  fingerprint is **not** a frozen backup: writer quiescence, protected destination
  ACLs and DPAPI scope transfer are all unverified.
- Exact-commit isolated SYSTEM Hub runtime stage passed independent SHA-256
  tree validation (4,745 files, tree digest
  `e1d9a2733430c9fa283a6769aa8b63b0fc1911d89351c86f8d25f369d563260a`).
  `productionInstalled=false`, `taskChanged=false`, `sqliteChanged=false`.
  The elevated installer still reports `TARGET_EXISTENCE_UNVERIFIED`.

### Operator-only next acceptance gate

After explicit local physical approval, use a **genuinely elevated trusted**
Windows operator session to verify the existing protected task, back up its exact
XML and SDDL, and complete an isolated restore rehearsal using the pinned and
protected runtime. Do not copy or execute maintenance scripts from an ordinary
writable Git worktree with elevated privileges. Preserve the active interactive Hub,
CORE revoke/STOP fences and current SQLite/WAL until recovery is independently armed.
Only then follow the separately approved controlled one-writer migration, SYSTEM
LocalMachine DPAPI attestation and physical reboot/rollback procedure. No health
endpoint, source test or approval dialog alone promotes this gate to GO.
