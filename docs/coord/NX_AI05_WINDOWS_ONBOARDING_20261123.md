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

## Windows release-lane test coverage follow-up

After the initial green CI `45188556719` and Release Readiness `45188556694`, inspection of the Windows release logs confirmed that ordinary `install` and `checksum-mismatch` smoke ran, while `upgrade-preserve` and `upgrade-checksum-mismatch` were not invoked. The AI-05-owned smoke driver now invokes **both additional disposable fixture scenarios from its default local-fixture `install` run when the packaged version is later than 1.0.8**, with an explicit child JSON receipt for scenario identity, preservation of five fixtures, and fail-closed checksum behavior. Tagged/stable v1.0.7 bootstrap and `--download-source github` are excluded from this automatic extension. No shared workflow edits or additional CI dispatch were made.

This section describes added source behavior, not a completed OS acceptance. Verify the next exact-head Windows Release Readiness job output before changing `NOT_RUN` to `PASS`. The physical Work-PC and real SQLite/DPAPI migration remain outside this fixture's scope.

## 23 November, native Windows evidence and additional Plan coverage

Exact earlier SHA: `492b3ee02c9bebffdfdd8d99a02e6296a42e2773`. CI `45202515614`: SUCCESS. Release Readiness `45202515649`: FAILURE with Windows package job `137790044498` SUCCESS, Ubuntu package SUCCESS, macOS package CANCELLED. The precise reason for the macOS cancellation is not established; do not attribute the workflow failure to AI-05 or a known code defect without additional evidence. The Windows job JSON receipt includes `"upgradeMatrix": ["upgrade-preserve", "upgrade-checksum-mismatch"]`, confirming both isolated scenarios executed successfully for that SHA. This is **Windows fixture acceptance**, not a real state cutover or physical CORE enrollment.

New AI-05 test `test/ai05/system-stage-plan-windows.test.ts` invokes the actual PS5.1 `-Action Plan` with an exact Git HEAD, derives the user's MyDocuments location from the Windows known-folder API (preserving Unicode via base64), and verifies that neither stage nor provenance files are created. It skips with an explicit reason if the transient runner lacks a provisioned known Documents folder. A second OS-only test parses the stage script under PowerShell 7 when that interpreter is installed, otherwise explicitly SKIP.

The stage script additionally rejects non-Windows platforms, 32-bit Windows and 32-bit PowerShell processes with distinct messages before any build work. These changes affect only source-owned staging and tests, never existing installed runtimes. Recheck exact HEAD CI and Windows job logs before recording PASS for the new Plan and PowerShell 7 checks.

## Known gaps and coordination request

- The actual generated CMD installer body lives in **`scripts/build-windows-user-bundle.ts`**, outside the AI-05 assigned write list. It currently uses side-by-side version directories, but does not implement a complete UX for protected SYSTEM install/uninstall/UAC or a verified data-aware version rollback. Request coordinator ownership for the precise `renderSetupScript` symbol before modifying it.
- `scripts/Install-Nexowire-SystemHubRuntime.ps1` belongs to an unresolved shared AI-01/AI-09 ownership decision. AI-05 did not modify it.
- The existing `test/ai01-system-runtime-stage-builder.test.ts` constructs `%USERPROFILE%\Documents` even when the OS known Documents folder is redirected. Coordinate this test migration with its owner; do not infer a production regression from a mismatch in the old fixture path.
- `scripts/generate-windows-stable-setup.ts` intentionally still pins the published v1.0.7 payload. No new stable installer, tag, artifact, signature or claim of stable 1.0.9 is made.
- New Node runtime ZIP download and checksum extraction implementation is inside `scripts/build-windows-user-bundle.ts`; no changes there without ownership. Existing SHA check is not a signed release acceptance.
- No live system, UAC, DPAPI, task, anti-replay, CORE effect, Windows VM, or 2-PC acceptance was executed.

## Rollback

The AI-05 branch is source-only: revert its three code/test changes, or close the Draft PR without merge. Existing installer payloads, published setup files, and real device state are unchanged. For any future controlled VM stage, use a disposable image snapshot before executing Build. AI-09 must separately approve any real Work-PC operation.

## Evidence and remaining acceptance gates (2026-11-24)

Evidence is scoped to the exact source SHA and test environment; none of the following is proof of production SYSTEM or CORE authority.

| Scope | Exact SHA / run or job | Result |
| --- | --- | --- |
| General CI / Release / Discovery / Portable | `c92f36d6bd526f1b4e4f078a147b7f9322f76bf3`: 45367020979 / 45367021428 / 45367021017 / 45367021027 | SUCCESS (all four, historical) |
| Hosted Windows packaged upgrade matrix | `69abd9374bcb6d2a77e12fbf0d232ac683e63422`: job 138297701825 | PASS for five synthetic file/data sentinels and checksum rejection; no real old runtime/DPAPI/WAL migration |
| Synced PR head | `86f1b9eb269aa9ea66393443d2db143476677c99` against `d2696376aae7a23aa9e0df01c19aa5c9b07f0595` | 0 behind, five scoped files |
| Test Discovery Inventory | 45378526907 | SUCCESS at preparation time |
| AI-03 Windows Control Plane Authority | 45378526901 | SKIPPED at preparation time |
| Portable Root Test Smoke | 45378526904 | SUCCESS at preparation time |
| CI | 45378526968 | IN_PROGRESS at preparation time |
| Release Readiness | 45378526934 | IN_PROGRESS at preparation time |
| Native Windows Plan and PS7 parse | reviewed fixture blob `e5b648e3b4bbbaa71108f5e345bff82d8775b4a9` | NOT_RUN in reviewed mandatory Windows lane; requested in #1252 |
| Independent Stage Build | source blob `612445bfa2bb74037223ee67d03c1150c0e4b622` | NOT_RUN |
| Physical Win10/11, UAC accept/decline, CORE/revoke, actual state migration and rollback | AI-09 / authorized local owner | NOT_RUN |

The stage manifest now supports pinned prerelease package names (for example `1.0.9-exp.0`), while rejecting a mismatched package name/version/filename. The Plan test uses its own temporary Git repository, verifies four scenarios (clean SHA, wrong SHA, unsafe output, dirty tree), and checks no stage or provenance output. Run it on an explicitly reviewed disposable Windows runner:

```powershell
node --test --test-reporter=tap --import tsx --test-concurrency=1 test/ai05/system-stage-plan-windows.test.ts
```

Document absent or PowerShell 7 absent means an explicit test skip, not native acceptance. Coordinate the expected source blobs with AI-08; do not amend an active shared workflow from this branch.

## Checksum smoke follow-up

Source prepared in child commit `766f3b51f4497192dc435ee39c63511cd4bfc9ce`: reject ambiguous checksum manifests (duplicate, missing, malformed or unexpected names) and stream the ZIP digest. The real generated Windows checksum manifests have exactly two canonical entries. Tests import the helpers without executing the installer smoke. The two new regression cases plus an independent checked-in stable manifest case passed in an isolated extracted-helper Node 22.16.0 run (3 tests, 3 pass, 0 fail/skip). A synthetic 128 MiB file produced equal SHA-256 values with readFile and streamed hashing; observed peak Linux RSS was 157680 KiB and 53032 KiB respectively. This is not an installer benchmark, complete-repository CI or Windows acceptance.

Full exact-head CI is still required after publishing the prepared candidate. No claim that the current same-build repair gap is fixed.

## Exact shared-source blocker and handoff

`scripts/build-windows-user-bundle.ts` blob `3f71be3ce204e25b68fdf94d7bc33035e864f58f`, renderSetupScript lines 214–237: the verified download/extract path is skipped when the destination already exists, then only the launcher path is checked before creating a shortcut. The success-only temp cleanup is at line 256. Coordinator #1160 comment 7129735664 asks for a single shared-symbol owner before changing it.

Required acceptance before declaring installer repair complete:

- Incomplete/damaged same-build target is refused or repaired only from verified artifacts; a complete valid retry is idempotent.
- Corruption/interruption or collision never destroys a previous working version or user data; failed install does not claim success.
- Explicit local consent, standard-user install, UAC accept/decline and task identity are verified separately; no disabling OS protections, no plaintext secret export.
- Low disk, redirected Documents, separate volume, junction and unexpected task identity require reviewed disposable VM tests; no physical acceptance inferred.
- AI-09 records real old-version data/identity, rollback and before-login behavior under the approved physical execution protocol. No production mutation by AI-05.

A source rollback is limited to the AI-05 diff or closing the draft without merge; never use it as a substitute for real data rollback. Do not supersede matching active CI.
