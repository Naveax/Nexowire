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
- User Hub task Running; SYSTEM Nexowire Hub Boot task not installed.
- Local-owner CORE STOP and legacy console STOP both present. Encrypted grant envelope remains present. Do not clear a revoke fence because old ciphertext still exists.
- AI-03 acceptance tests: 4 PASS. Targeted Broker/credential regressions: 47 PASS / 1 SKIP / 0 FAIL. Typecheck + build PASS.
- Real SYSTEM DPAPI verification, physical reboot, protected cutover and Broker effect admission remain NOT_RUN / unverified.

## Security and provenance

The source evidence is diagnostic. The protected receipt, actual installed runtime, live health, full exact-HEAD hosted CI and physical acceptance must be checked separately. Do not weaken ACLs, forge SYSTEM identity, bypass UAC, clear local CORE revocation, print secrets, or manually rerun a workflow already active for an identical SHA and inputs.
