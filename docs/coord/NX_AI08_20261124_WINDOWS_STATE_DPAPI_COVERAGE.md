# AI-08 | Windows protected state, ACL, uninstall and DPAPI fixture coverage

2026-11-24, #1205. Source-only Draft. No physical Windows changes.

Base #1160: d2696376aae7a23aa9e0df01c19aa5c9b07f0595. Previous AI-08 #1248 and #1249 integrated; exact base runs 45369721307, 45369721552, 45369721144, 45369721152, 45369721229, 45369721371 SUCCESS. Coordinator candidate #1250 at 1a837b0069b3d8c91401b1c454f62eba2babd6b9 includes the AI-01 startup profile. Its Release Readiness 45368843413 also succeeded for both Windows fixture jobs. This change does not mutate that candidate.

## Reviewed coverage gap

Inspected all eleven workflow files and found no explicit invocation of these four tracked root TypeScript files. This observation is not proof that no indirect job ever ran them. Each complete file was inspected on the integration SHA, and the same Git blob was verified on candidate #1250:

| File | Git blob SHA | Reviewed scope |
| --- | --- | --- |
| test/hub-boot-protected-state-gate.test.ts | 40994c7a1178b20946b4432c7ff2716f5a074dd1 | Pure root and persisted environment validation, source ordering |
| test/hub-boot-shared-ancestor-trust.test.ts | 5ef2a796bd617c10130ad44ebd88bed22f6f2466 | Source assertions and real read-only ACL verification of Windows system ancestors |
| test/hub-boot-uninstall-task-absence.test.ts | 00457b3720774254d62b0cc378286e17bcbd30f2 | Source ordering, synthetic PowerShell COM error and task objects; no unregister or deletion |
| test/windows-dpapi-shell-trust.test.ts | 638804ff36f66555d220bb0757ce189354703775 | Environment validation, isolated synthetic user/machine DPAPI round trips, wrong-purpose denial, temporary fake executable and cleanup |

## Implementation

The already-required exact-head Windows fixture job now includes four shared, explicitly pinned files regardless of the coherent boot profile. The baseline profile expands from four to eight files, startup profile from five to nine files. Shared/profile duplicate paths fail closed. Every file is verified against the Git inventory and actual checkout before execution; the existing positive TAP floor and zero FAIL/SKIP/TODO/cancelled requirements remain mandatory. The receipt adds a named reviewExtension; existing reviewProfile and physicalWindowsAcceptance fields are retained. Four new exact PR path triggers and a regression contract pin the shared set and prevent removing its review/execution wiring.

The Windows ACL probe is read-only and environment-dependent: if the hosted runner fails the ancestor ACL contract, report that failure rather than relaxing or skipping it. DPAPI uses synthetic secrets and an isolated temporary directory only; this is not production SYSTEM-token or cross-identity acceptance.

## Acceptance

New child Node 22/24 hosted execution is PENDING until its own CI logs are checked. Do not inherit parent results. Full 654-file execution, SYSTEM boot before login, production DPAPI transfer, actual task mutation/rollback, SQLite and stable publication remain unproven. No production Work-PC use, no main merge/tag/release, no duplicate dispatch. Coordinator must reevaluate current base and combined candidate before promotion.

Rollback: revert only the three changed AI-08 files.


## Exact first-child failure and bounded retry correction

Child 90fb99b2e3d5a40c45c9bf63254ba9f4131ad8ec, Release Readiness 45378688284: Windows jobs 138391685596 (Node22) and 138391686020 (Node24) failed. Both logs show complete TAP success for protected state (3), ancestor ACL (5), and uninstall absence (2), followed by three DPAPI shell-trust tests passing. The final real DPAPI round-trip test produced no complete TAP footer before the 90-second outer fixture timeout. Package and publication were blocked.

This does not establish whether an underlying DPAPI call would have succeeded or failed. The existing production implementation already bounds each PowerShell call at 180000 ms, and the fixture has seven sequential calls. Give only this fixture a 1320000 ms outer budget (7 x 180000 + 60000), with a 40-minute finite job ceiling to accommodate the remaining bounded fixtures and setup. All other fixture deadlines stay 90000 ms. Record sanitized child error code, exit code, signal and elapsed/budget values on failure, and elapsed/budget on successful receipts. Zero-SKIP and complete TAP acceptance remain unchanged. No production DPAPI implementation or reviewed fixture bytes modified. The new exact child SHA needs independent CI; no retry of an unchanged SHA or weakening of a test to conceal the failure.
