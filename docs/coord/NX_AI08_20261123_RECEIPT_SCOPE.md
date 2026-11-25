# NX AI-08 | Exact-head CI coverage reconciliation | 2026-11-23

## Ground-truth source and scope

- Integration PR: #1160 (Draft; NO-GO).
- Parent commit used for this isolated branch: `83c8b651106ecd1244fb9d982cf94fd390c15b6b`.
- Issue: #1205.
- Test Discovery run #45178024898, Node 24 job #137704251458: **SUCCESS**, bound to the parent commit.
- SHA-bound tracked test inventory: **654** TS test files; 575 root, 46 one directory, 33 deeper.
- Without Bash globstar, `test/**/*.test.ts` matches only the 46 one-directory files; **608 paths are omitted** from this particular command. Other explicit CI steps cover some omitted tests, but comprehensive execution has not been measured.
- Portable root allowlist: 35 files with reviewed Git blob IDs. Other 619 files are **NOT REVIEWED by that allowlist** (this is not proof that those files were never run by other jobs).
- Source manifest SHA-256: `1f06592d2f0abd25f275601e5f934c3a09316b457b88423ff97f90fadc2167b9`.

## This branch changes

1. `scripts/ci/test-execution-coverage.mjs`: a receipt claiming `ONLY_EXPLICIT_APPROVED_ROOT_TEST_FILES` now fails if any receipt path is missing from the 35-file immutable allowlist or its Git blob differs from the independently reviewed blob. A valid Git-tracked path and matching commit manifest *alone* cannot prove review or execution.
2. `test/ci/test-execution-coverage.test.mjs`: use three reviewed-file fixtures; add negatives for a tracked but unreviewed file masquerading as approved, and a forged full-inventory PASS claim; test that the complete reviewed allowlist still leaves unreviewed files NOT_RUN.
3. `.github/workflows/ci.yml` is restored byte-for-byte to the parent Git blob `e0d0ce2dabfc306a2daf5c1931701d23491b204b`. The first implementation altered that source and caused three legitimate provenance gate failures. Shared preservation matrices remain untouched.
4. `.github/workflows/release-readiness.yml`: test inventory, plan, coverage, receipt and pure-import provenance changes, their target MJS tests, and the CI workflow are explicit PR trigger inputs; isolated Node 22/24 exact-head jobs run the receipt denial tests. The package matrix depends on the AI-08 lane; tag `attest` depends on package, and tag `publish` depends on package + attest, preserving the existing pinned release-policy contracts.
5. `test/ci/release-path-coverage.test.mjs`: enforce those trigger paths and the AI-08 → package → attest → publish prerequisite chain, preventing bypass.

**Limits:** The coverage reconciler does not independently authenticate a test executor. It validates the claimed reviewed-only scope and separates PASS receipt reconciliation from unmeasured execution. The 654-file full-suite assertion is **NOT_RUN**, not PASS. Browser, native Windows effects, SYSTEM/CORE, reboot, user profile state and release signing are outside this source-only PR.

## Acceptance and promotion matrix

| Gate | Parent integration evidence / requirement |
| --- | --- |
| Test path inventory, source SHA and manifest | PASS in #45178024898; does not imply execution |
| Reviewed portable-root tests | PASS in #45178025043; applies only to 35 reviewed files |
| General CI Node 22/24 | Jobs PASS in #45178026197, but overall run still in progress at first review |
| Release Readiness Linux/macOS | Package jobs PASS in #45178024621; Windows still running at first review |
| AI-03 / AI-04 source CI | PASS in #45178024847 / #45178025175 |
| New AI-08 exact-head Node 22/24 receipt denials | Earlier child CI c99a8784: 8/8 PASS on each Node 22 and Node 24; recheck on final SHA |
| All 654 tracked TS files actual execution | NOT_RUN / not measured as a comprehensive suite |
| Disposable Windows 10/11, PowerShell 5.1/7 setup and native DPAPI/Broker effect | NOT_RUN as full physical acceptance; AI-05/AI-09 owners |
| SQLite/WAL no-replay, interrupted rollback, before-login SYSTEM and revoke effect | NOT_RUN physical; AI-01/02/03/04 and AI-09 owners |
| Linux/Windows/macOS release-package smoke | Parent package job evidence may be scoped to each platform; collect exact child SHA jobs separately |
| Checksums, source provenance, signed artifact, stable tag/publication | Stable NO-GO pending signed artifacts, physical acceptance and coordinator decision |

## Safe rollback

Do not touch live Windows tasks, services, DPAPI, SQLite or installation state. Revert only this branch's changes (coverage reconciler, test fixture, isolated Release Readiness CI lane, and this report) if child exact-head validation fails. Keep #1160 and all original active CI runs intact.

## Coordination

No `main` commit or merge, no release or tag, and no PR #1160 mutation. PR base remains `integration/ai01-ai06-candidate-20261109`. If the integration head changes, refresh test inventory and exact reviewed blobs before any shared workflow/provenance updates.

## Reconciliation of discovered CI failure

On child SHA `c99a8784b8604b0cae23be48dcaf2d213b9f6f53`, release Ubuntu package job #137717286788 and CI Node24 job #137717300446 both failed **three unchanged source-preservation assertions** because the experimental new AI-08 lane was placed in provenance-pinned `.github/workflows/ci.yml`. Confirmed expected old blob: `e0d0ce2dabfc306a2daf5c1931701d23491b204b`; actual modified blob: `55efafd42295991eb1a3f01f185e64f98552bd9d`. The three matrices are `docs/connection-v2/source-preservation-matrix.csv` (79 rows), `docs/coord/AI05_ROUND2_SOURCE_PRESERVATION.csv` (290 rows), and `docs/coord/AI05_CORE_CONNECTION_V2_PRESERVATION.csv` (243 rows). Rather than silently rewriting historical matrices or falsely labeling source equality, the CI file was restored exactly; the AI-08 test job moved to the unpinned release workflow and was made a prerequisite for package jobs, thus transitively for tagged attestation/publication. One intermediate attempt changed tag attestation/publication `needs` lists and caused an existing approved portable-root release policy test to fail; those lists were restored and package alone now declares the extra dependency. This does not imply a stable release is authorized. The new exact SHA must pass independently.
