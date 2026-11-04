# CLEAN-13 | Cloudflared binary and credential custody (source-only)

**Base:** #1044 independent AI-11 negatives, itself stacked on #1003. **Scope:** P1-A, P1-B, P1-D. **No production rollout authorization.**

## Security decision

- **P1-A Linux x64: CONDITIONAL SOURCE PASS for pathname-swap adversary** only when executing from inherited `/proc/self/fd/3`, staging exactly the reviewed official bytes into mode 0500 and an owner-private 0700 directory. `test/clean13-cloudflared-custody.test.ts` atomically replaces the staged filename after its FD was opened and checks the original process executes. This is not a guarantee against an attacker *already running with the exact same UID*, who can potentially change an inode through repermissioning or debugger/memory control. A sealed `memfd` or protected OS identity would be needed for that stronger model. Never assert full P1-A GO from synthetic tests.
- **P1-A Windows: NO-GO.** PowerShell Authenticode and user-visible filesystem ACL checks do not bind `CreateProcessW` to a verified kernel file/section handle. The Windows path explicitly denies launch until a reviewed native, signed immutable-image custodian exists with verified final file ID, protected DACL and process image readback. Do not silently fall back to `spawn(profile.binary)`.
- **P1-B: CONDITIONAL SOURCE PASS** for Linux/Windows x64 Cloudflare 2026.10.1 artifact byte identity, locked in source rather than the owner-editable profile. The source digest alone cannot authenticate a *new* release; updates need independent release review and signature/attestation verification. On Windows an Authenticode `Valid` state and Cloudflare certificate subject are additionally required before the separate native-launch NO-GO. No trust of unsigned, self-signed or wrong-publisher arbitrary bytes. This is not a claims of certificate-chain tests on a real Windows device.
- **P1-D POSIX: CONDITIONAL SOURCE PASS** for normal cross-user threat model. Enforces open-once `O_NOFOLLOW`, owner UID, mode 0600 (or stricter), regular single-link inode, all-parent owner/write checks with root-owned sticky temp exception, descriptor-versus-path identity before/after read, and owner-private staged credential **bytes**. `cloudflared` reads that private copy, not the original mutable pathname.
- **P1-D Windows: NO-GO pending hosted SID/DACL/ACE tests and real device acceptance.** Fixed System32 PowerShell SID/DACL/reparse read-only check denies foreign file read rights and unsafe parent replacement rights; the open descriptor is compared to pathname identity. No write/ACL correction is attempted. Windows identity/rename and sharing-handle guarantees need a native tester and credential-copy custody proof on an isolated Windows VM.

## Independent provenance anchors

Reviewed official `cloudflare/cloudflared` tag `2026.10.1`:
- Linux amd64 `cloudflared-linux-amd64`: `3bfc539f45d2620c71debb7a86be0efa737ed5ccbad9eb85c787116900e5c586`
- Windows amd64 `cloudflared-windows-amd64.exe`: `4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6`

Source of release evidence: https://github.com/cloudflare/cloudflared/releases/tag/2026.10.1 . The owner-selected profile checksum is checked **in addition** to these source-controlled digests, not instead of them.

## Attack / regression matrix

| Attack | Negative expectation | Test/evidence | Status |
|---|---|---|---|
| Profile checksum valid, wrong binary/publisher | Reject before public origin or spawn | CLEAN-13 P1-B; unchanged AI-11 P1-B | Source guarded; hosted pending |
| Valid prior SHA, source pathname atomically replaced | No malicious process | AI-11 P1-A unchanged; hardened preflight | Source guarded; hosted pending |
| Sealed Linux execution pathname replaced after FD open | Execute original verified inode | CLEAN-13 descriptor-swap negative | Source guarded; hosted pending |
| Source symlink, hardlink, reparse | Reject | CLEAN-13 path tests; Windows OS still needs independent test | POSIX source guarded |
| Unsigned/self-signed/wrong publisher | No execution, even with matching profile SHA | Independent official digest pin + Windows Authenticode status | Windows launch NO-GO |
| Credential POSIX 0640, 0644 or world-readable | Reject with custody-specific error | AI-11 unmodified + CLEAN-13 | Source guarded |
| Credential hardlink, symlink or group-writable parent | Reject | CLEAN-13 custody negatives | Source guarded |
| Credential replacement after read | Cloudflared never opens original path | Private byte-copy admission | Source guarded; same-UID threat not solved |
| Windows inherited Everyone/Users/Auth Users file read or parent write | Reject | SID/DACL/ACE guard | Needs hosted/native negative |
| Credential cleanup interrupted or process/child orphaned | Never assert safe teardown until process exits | Existing #1003 lifecycle test still RED | NO-GO |

## Preserved negative tests

**Do not modify** any of the three #1044 files:
`test/ai11-cloudflared-path-race-negative.test.ts`,
`test/ai11-cloudflare-address-and-credential-custody.test.ts`, or
`test/ai11-connection-v2-negative.test.ts`.

The P1-C public-origin failures and separate Windows task parent/descendant lifecycle failure are **not part of CLEAN-13**. They are expected to remain RED until their respective owners fix them. CI overall red must not be dismissed as a CLEAN-13 pass. A full end-to-end Cloudflare tunnel, credentials, real user token, real task or physical Agent was not touched.

## Remaining acceptance before GO

1. Independent Windows native held-handle/image-section signing and process creation identity, including rename/reparse/hardlink races under different SIDs; known real signing certificate, chain, timestamp and revocation proof.
2. Real Windows SID/ACE negative tests (inherited allow, deny/allow order, generic rights, file-ID, directory replacement), protected credential copy, cleanup after crash and reparse.
3. A stricter Linux same-UID adversary solution if the same account is in the threat model, ideally memfd sealing with no writeable alias.
4. Unchanged #1044 RED -> GREEN for A/B/D on exact SHA, plus explicit tests for positive official executable. P1-C belongs to CLEAN-14.
5. #1003 Windows parent-and-descendant task stop and off-network two-PC/revocation acceptance must independently pass.

**Release gate: NO-GO**. This candidate changes no CORE/Broker, Hub control-plane, production credentials, DNS, tunnel, device, CI execution or release.
