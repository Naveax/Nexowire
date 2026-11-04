# CLEAN-13 | Cloudflared binary and credential custody (source-only)

**Base:** #1044 independent AI-11 negatives, itself stacked on #1003. **Scope:** P1-A, P1-B, P1-D. **No production rollout authorization.**

## Security decision

- **P1-A Linux x64: CONDITIONAL SOURCE PASS for pathname-swap adversary** only when executing from inherited `/proc/self/fd/3`, staging exactly the reviewed official bytes into mode 0500 and an owner-private 0700 directory, then unlinking the filename so production execution uses the open inode alone. `test/clean13-cloudflared-custody.test.ts` atomically replaces the staged filename after its FD was opened and checks the original process executes. This is not a guarantee against an attacker *already running with the exact same UID*, who can potentially change an inode through repermissioning or debugger/memory control. A sealed `memfd` or protected OS identity would be needed for that stronger model. Never assert full P1-A GO from synthetic tests.
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
| Production trusted Linux stage unlinked before exec | No pathname/hardlink alias; FD-backed execution still succeeds | CLEAN-13 deleted-image negative | Source guarded; hosted pending |
| Official downloaded Cloudflare 2026.10.1 Linux x64 image, no tunnel | SHA must match pinned official digest; execute --version from unlinked FD | CLEAN-13 official-launch test on Node22/24 hosted runners | Hosted acceptance pending |
| Source symlink, hardlink, reparse | Reject | CLEAN-13 path tests; Windows OS still needs independent test | POSIX source guarded |
| Unsigned/self-signed/wrong publisher | No execution, even with matching profile SHA | Independent official digest pin + Windows Authenticode status | Windows launch NO-GO |
| Credential POSIX 0640, 0644 or world-readable | Reject with custody-specific error | AI-11 unmodified + CLEAN-13 | Source guarded |
| Credential hardlink, symlink or group-writable parent | Reject | CLEAN-13 custody negatives | Source guarded |
| Credential replacement after read | Cloudflared never opens original path | Private byte-copy admission | Source guarded; same-UID threat not solved |
| Windows inherited Everyone/Users/Auth Users file read or parent write | Reject | SID/DACL/ACE guard | Needs hosted/native negative |
| Temporary credential inode replaced before cleanup | Never unlink replacement, return custody drift | CLEAN-13 cleanup replacement negative | New regression; exact-HEAD CI pending |
| Runtime directory swapped for symlink to foreign credential tree | Never follow symlink or delete foreign contents | CLEAN-13 cleanup parent-swap negative | New regression; exact-HEAD CI pending |
| Temporary config/credential owned and unchanged | Delete only recorded inodes via open Linux directory FD; remove empty original directory | CLEAN-13 positive identity-bound cleanup test | New regression; exact-HEAD CI pending |
| Credential cleanup interrupted or process/child orphaned | Never assert safe teardown until process exits; do not recursively remove untrusted path | Existing #1003 lifecycle test still RED | NO-GO |

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

## Hosted run evidence and incremental remediation (2026-11-04)

- Starting PR #1077 SHA: `c1dd252180404e6afbe9527ed34b00c720cf5e41`; base #1044: `4d8f215f36de7fe05e85a9c19fc40cc35716d705`.
- CI run **41812885695**, Node 22 job **126516759381** and Node 24 job **126516759620** both executed official Cloudflare 2026.10.1 x64 unlinked-FD `--version` positive with exit 0. All original AI-11 **P1-A/B/D** and CLEAN-13 Linux source tests reported PASS. Five separate **P1-C** tests were FAIL; that stays assigned to V2-02.
- Windows `browser-live` job **126516759824** FAIL: the read-only PowerShell publisher/credential audit returned fail-closed after ~25s (no Windows positive proof); also **task stop must stop the managed parent** failed in #1003's lifecycle test. These are NOT passed or suppressed.
- A later V2-01 incremental patch replaces `fs.rm(directory,{recursive:true})` with a narrow cleanup method that first checks original directory/file identity, refuses unknown files or substituted inodes, and on Linux uses an opened directory FD for unlinking known entries. This is defense-in-depth for the **cross-user path-swap** threat model, not a same-UID or elevated-attacker guarantee. If drift is detected it refuses deletion and reports custody failure; operational cleanup may then be required by a trusted owner.
- An additional change places the Windows immutable-image deny **before** any runtime credential copy is staged. The Windows release remains **NO-GO**, not a regression waiver.
- New cleanup tests live only in `test/clean13-cloudflared-custody.test.ts`; the three #1044 AI-11 negative source files remain unmodified. Await the later exact-HEAD run before claiming these additions passed.

### Current gate (strict)

| Control | Linux x64 source gate | Windows native gate | Production |
|---|---|---|---|
| P1-A immutable executed image | Conditional pass for cross-UID path swap; same-UID sealed-memfd proof missing | **NO-GO**, native signed held-section custodian absent | **NO-GO** |
| P1-B publisher provenance | Source-pinned official 2026.10.1 hash and positive official executable test | Official 2026.10.1 SHA256 + Authenticode Valid + Cloudflare signer checked on disposable Windows CI; native held-image binding **NO-GO** | **NO-GO** |
| P1-D original credential custody | Conditional pass, owner/mode/inode/no-follow | **DISPOSABLE WINDOWS PASS** exact owner SID positive, foreign owner, explicit/inherited ACE, parent mutation negatives; native file-ID/rename proof **NO-GO** | **NO-GO** |
| P1-D temporary cleanup | Identity-bound cleanup plus adversarial regressions pending exact-HEAD CI | No credential staging until native image acceptance; runtime cleanup not physically accepted | **NO-GO** |

## V2-01 Round 2: Windows PowerShell, owner SID and ACE closure

**Precise source gate:** #1077 remains Draft; original #1044 negative Git blobs unchanged. Windows tunnel launch remains disabled, because verifying a signed file through a pathname is not a held verified Windows image section.

### Root causes (hosted disposable Windows runner)

1. The runner's temporary fixture initially had an Administrators-group owner. Granting the logged-on user `(F)` was insufficient: ACL permissions do not replace the NTFS owner SID. The fixture now sets the actual logged-on SID as owner of its own temporary directory and file only; production ACL policy is unchanged.
2. Windows PowerShell 5.1 subprocess verification was slow/unstable: earlier official image audit missed a 25,000 ms deadline; a subsequent owner-only ACL invocation returned classified `POWERSHELL_51_TIMEOUT` at **45,026 ms**. The fixed, system-wide PowerShell 7 executable under `C:\Program Files\PowerShell\7\pwsh.exe` executes the same strict checks on hosted Windows in about one second; Windows PowerShell 5.1 is still the fixed, fail-closed fallback where PS7 is absent. Both callsites use isolated child environments, fixed executable locations, and bounded output; no arbitrary `PATH` override.
3. Even under an isolated user-profile fixture, a parent ACE was rejected as `PARENT_REPLACE_ACE`. The read-only diagnostic proved **depth 4, inheritance=3, propagation=2 (InheritOnly), inherited=false**. An `InheritOnly` entry is a template for descendants, not an effective permission on the parent object itself. The audit now ignores only that non-effective ACE **on the object being inspected**, while still traversing every descendant DACL and rejecting actual inherited rights. This was not a waiver for foreign access.
4. The prior credential mismatch negative inadvertently depended on first accepting a nonofficial binary. It now exercises the pure bounded credential identity validator directly; the public launch path continues to reject the fake executable at independent provenance admission. No real tunnel secret, network endpoint, owner device, Cloudflare account or DNS was touched.

### Confirmed hosted tests

- GitHub Actions **41903957718**, exact source SHA `76fe54ac27796736313f16261968dd6edc4c23c8`, Windows browser-live job **126833516445**, source command `node --test --import tsx test/clean13-cloudflared-windows-custody.test.ts test/local-first-cloudflare.test.ts test/cloudflare-connection-lifecycle.test.ts test/cloudflare-agent-upgrade.test.ts test/connection-active-authorization.test.ts test/control-plane-agent-auth.test.ts test/agent-broker.e2e.test.ts`:
  - **PASS**: `CLEAN-13 P1-D Windows exact SID, inherited ACE and parent replacement rights` (7.68s). Confirms positive owner-only fixture, explicit foreign read ACE rejection, **actual inherited** foreign read ACE rejection, foreign NTFS owner rejection, and parent `Users:(M)` rejection. No failed assertion skipped.
  - **PASS**: `CLEAN-13 P1-B Windows official image requires native immutable launch guard` (1.28s). Official SHA256+valid Authenticode reaches the intentional native custodian denial instead of a wrong-publisher rejection.
  - **PASS**: independent PowerShell 7 signer baseline (1.18s), official `Valid`, Cloudflare signer, SHA pin, public certificate thumbprint `0B6C68C4BAD79F9AC39E07FE84223FB796D4D0BC`.
  - **PASS**: `checksum and tunnel identity are checked before any network exposure`, with credential-format mismatch checked independently of publisher gate.
  - **FAIL**, outside this file ownership: `Windows connection task stop terminates its real disposable process tree` (`task stop must stop the managed parent`), owned by V2-04. Windows browser-live job exit 1, not green.
- Same SHA Linux Node24 job **126833516771**, `npm run check` exit 1 from **8 independent inherited red tests** (five AI-11 P1-C, two V2-06 HTTP 307 redirect tests, one V2-06 revocation-at-dispatch). **PASS**: official 2026.10.1 Linux sealed-FD `--version`; all original AI-11 P1-A/B/D and CLEAN-13 Linux path-swap, hardlink, symlink, credential owner/mode, and cleanup regressions. Do not relabel aggregate CI as success.
- Earlier Windows CI **41901471345**, job **126824724474**, P1-D `POWERSHELL_51_TIMEOUT` at 45,026 ms; CI **41902337991** job **126828412983**, `PARENT_REPLACE_ACE` on runner shared temp; CI **41903367391** job **126832250243**, depth/propagation evidence reproduced under user profile before the effective-ACE fix.

### Remaining strict security gates

- Windows **P1-A NO-GO**: no native, signed, immutable executable section/held-handle custodian linked to process creation and final process image identity. Do not permit `spawn(profile.binary)` even after Authenticode PASS.
- Windows **P1-B** official artifact/source-stage signed provenance confirmed on disposable runner, but final execute-image provenance remains **NO-GO**.
- Windows **P1-D** owner/ACE/parent policy validated on disposable files, but native file-ID/rename/reparse/cleanup under multi-SID adversarial races and actual tunnel launch remain **NOT_RUN / NO-GO**.
- Linux same-UID mutation of an already-held executable inode is not sealed; Linux P1-A is conditional for the cross-UID/path-swap model only.
- Cross-owner regressions P1-C, revocation and Windows lifecycle remain red in the source-stacked PR and must be resolved by their owners or verified in the integration candidate separately.

**Overall release decision: NO-GO** until native Windows image identity, off-network authenticated Cloudflare acceptance, and all integration gates are satisfied. Windows native launch remains fail-closed.
