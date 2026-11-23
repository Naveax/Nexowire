# NX AI-05 | Windows setup / CORE onboarding source handoff

Date: 2026-11-23
Integration reference: PR #1160, base HEAD `83c8b651106ecd1244fb9d982cf94fd390c15b6b`
Agent branch: `agent/nx-05-windows-onboarding-20261123`
Physical executor: **AI-09 only**. This branch has not touched a production Windows task, protected state, DPAPI credential, database, or service.

## Implemented within AI-05 source ownership

1. `scripts/Build-Nexowire-SystemHubStage.ps1` resolves the Windows **MyDocuments known folder** instead of assuming `%USERPROFILE%\Documents`; this supports renamed accounts / OneDrive-redirected Documents while requiring the exact expected stage leaf name, an existing Documents parent, a nonexisting output, no ancestor reparse points, and an exact clean source SHA. The Windows 5.1 PowerShell and tar paths are resolved from the OS Windows directory rather than `C:\Windows`. Staging is still Plan/Build-only and does **not** install protected tasks.
2. `scripts/smoke-windows-user-setup.ts` adds `upgrade-preserve` and `upgrade-checksum-mismatch` fixture scenarios. They seed an isolated fake previous 1.0.8 version, perform the regular checksum-pinned installer run (or corrupt the fixture response before extraction), and verify byte-for-byte preservation of the old sentinel. This proves only isolated **side-by-side installer preservation**, not a full user state migration, CORE authorization, unattended reboot, actual disk exhaustion handling, or uninstall.
3. `test/ai05/windows-setup-regressions.test.ts` adds source contracts, native PowerShell 5.1 parse coverage, and opt-in packaged Windows fixture execution. Physical tests are deliberately NOT_RUN when no Windows/bundle exists.

## Exact test commands

Portable source tests (Node 22 or 24, from clean checkout):

```sh
node --test --import tsx test/ai05/windows-setup-regressions.test.ts
npm run typecheck
```

Real **disposable Windows runner** with locally built `release-windows` artifacts only, after a separate approved bundle build:

```powershell
$env:NEXOWIRE_AI05_RUN_BUNDLE_SMOKE='1'
node --test --import tsx test/ai05/windows-setup-regressions.test.ts
Remove-Item Env:NEXOWIRE_AI05_RUN_BUNDLE_SMOKE
```

Direct smoke commands (no production task registration; updater, shortcut launch, and browser are intercepted by fixture):

```powershell
node --import tsx scripts/smoke-windows-user-setup.ts --bundle-dir release-windows --download-source fixture --profile unicode --scenario upgrade-preserve
node --import tsx scripts/smoke-windows-user-setup.ts --bundle-dir release-windows --download-source fixture --profile unicode --scenario upgrade-checksum-mismatch
```

## Required VM acceptance matrix (NOT_RUN until observed)

| Environment | Scenario | Acceptance |
| --- | --- | --- |
| Clean Windows 10 19045, standard user | 1.0.9 experimental install + Unicode profile | bundled Node executes without ambient Node/npm; protected task remains consent-gated |
| Clean Windows 11, standard user | Fresh install + UAC accept/decline | elevation only on explicit local user action; decline never reports CORE READY |
| Windows 10/11, admin | Protected SYSTEM stage Plan, Build, trusted runtime identity | Windows known-folder resolution and PowerShell 5.1/7 syntax; no task mutation at Stage time |
| Windows 10/11 | Existing 1.0.8 + experimental build | old binaries, personal data, Hub SQLite/WAL and identity retained |
| Windows 10/11 | Interrupted download, corrupt Node/payload ZIP | SHA-256 reject before extraction; previous working version untouched |
| Windows 10/11 | Relocated Documents, Turkish/Unicode account, OneDrive, alternate Windows root | no hard-coded user or C: paths |
| Windows 10/11 | Low disk, symlink/junction parent, destination collision | reject before changing installed state |
| Windows 10/11 | Missing/wrong principal existing task | identity check and explicit conflict, never overwrite |
| Windows 10/11 | Uninstall/rollback | preserve encrypted owner data unless explicit local deletion |
| Windows 10/11 | Reboot before login, CORE enrollment / revoke | only AI-09 may record physical SYSTEM and Broker/CORE effect acceptance |

## Known gaps and coordination request

- The actual generated CMD installer body lives in **`scripts/build-windows-user-bundle.ts`**, outside the AI-05 assigned write list. It currently uses side-by-side version directories, but does not implement a complete UX for protected SYSTEM install/uninstall/UAC or a verified data-aware version rollback. Request coordinator ownership for the precise `renderSetupScript` symbol before modifying it.
- `scripts/Install-Nexowire-SystemHubRuntime.ps1` belongs to an unresolved shared AI-01/AI-09 ownership decision. AI-05 did not modify it.
- The existing `test/ai01-system-runtime-stage-builder.test.ts` constructs `%USERPROFILE%\Documents` even when the OS known Documents folder is redirected. Coordinate this test migration with its owner; do not infer a production regression from a mismatch in the old fixture path.
- `scripts/generate-windows-stable-setup.ts` intentionally still pins the published v1.0.7 payload. No new stable installer, tag, artifact, signature or claim of stable 1.0.9 is made.
- New Node runtime ZIP download and checksum extraction implementation is inside `scripts/build-windows-user-bundle.ts`; no changes there without ownership. Existing SHA check is not a signed release acceptance.
- No live system, UAC, DPAPI, task, anti-replay, CORE effect, Windows VM, or 2-PC acceptance was executed.

## Rollback

The AI-05 branch is source-only: revert its three code/test changes, or close the Draft PR without merge. Existing installer payloads, published setup files, and real device state are unchanged. For any future controlled VM stage, use a disposable image snapshot before executing Build. AI-09 must separately approve any real Work-PC operation.

## Current evidence

- Source contract inspection: 8/8 checks PASS in a read-only check; this does **not** mean Windows/TypeScript compilation PASS.
- PowerShell 5.1 parse: NOT_RUN (non-Windows execution context).
- Native Windows side-by-side bundle smoke: NOT_RUN (no Windows runner and vetted bundle in this environment).
- TypeScript/Node CI: pending exact-head PR checks, do not claim success until GitHub reports it.
