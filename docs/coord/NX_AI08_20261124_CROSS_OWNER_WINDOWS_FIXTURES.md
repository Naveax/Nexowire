# AI-08 cross-owner Windows source coverage

2026-11-24. #1205. Stacked independently on AI-00's #1263 exact dfb4e8a529a0cc87a502d2a01481799c5fa292e9; no fan-in repeated, no coordinator branch write. Source-only.

| Fixture | Reviewed blob | Minimum cases | Child deadline ms |
| --- | --- | ---: | ---: |
| test/hub-boot-handoff-receipt.test.ts | b43b45de2b6c85177ac7f0e15a66c3d321661d45 | 4 | 180000 |
| test/system-hub-controlled-cutover.test.ts | 494b60fc0bd67fe5832fd72e282e641ab9f072f4 | 11 | 180000 |
| test/ai03/system-dpapi-acceptance.test.ts | aa4f935e814fa05af230383acd9a43e465d6eaa8 | 4 | 360000 |
| test/ai04/transactional-handoff-recovery-required.test.ts | d2ca34974c160c94936a9e0c6697ccde5506cae6 | 3 | 180000 |
| test/ai04/recovery-script-rollback-boundaries.test.ts | 1facff206c85c1bb75cb60b17bc2f27bab89ac63 | 13 | 180000 |
| test/ai05/system-stage-plan-windows.test.ts | e5b648e3b4bbbaa71108f5e345bff82d8775b4a9 | 2 | 300000 |
| test/windows-installer-command-root-trust.test.ts | a1ab244910a6e8df0e5cc61b003c9e7d2136bdc7 | 3 | 180000 |
| test/windows-user-bundle-local-payload.test.ts | 39df7e3cf229b417440e12e8e78a45fe5034bab7 | 2 | 180000 |

Eight files, 42 minimum cases per Node version. Exact source reviewed. AI-01 receipt synthetic source-derived PowerShell contains no task operations; AI-02 controlled cutover uses injected callbacks; AI-03 DPAPI is non-SYSTEM negative plus synthetic CurrentUser envelope/HMAC and parser; AI-04 handoff recovery uses temporary SQLite and injected callbacks, rollback boundary tests inspect source and disposable artifact; AI-05 stage Plan uses a temporary Git repo and no stage creation, Windows PowerShell 7 parser, installer root static checks and isolated local payload prefix (stops before extraction). The critical script blobs are independently pinned, and tracked worktree checked with Git attributes before launch. No real installation, real task registration, native effect, production secret or physical acceptance. DPAPI deadline covers sequential inner 30s calls; stage deadline covers multiple Git and PS calls.

AI-03 authority workflow explicitly references DPAPI but was SKIP on #1263 due to branch condition, not PASS; AI-04 atomic no-replay has its own workflow and is not duplicated here. Other selected paths had no explicit reference in the 14 candidate workflows (indirect execution possible). Conditional skips (Documents folder, PowerShell 7, SYSTEM identity) must fail this strict lane if encountered, not masquerade as completed coverage. Separate failed-file schema-v2 receipts preserve independent later outcomes, nonzero exit. New scope REVIEWED_WINDOWS_CROSS_OWNER_SOURCE_FIXTURES_ONLY requires explicit policy registration in future #1261 combined collector; not a deployed release gate. Four regression tests included.

Deferred: full installer job includes scheduler entrypoint/approval-policy dependence; packaged AI-05 smoke requires built bundle and explicit opt-in; bootstrap missing-bundle assertion needs owner strengthening; installed signer/ACL fixed-path tests require actual provisioned official runtime; full recovery script mutation harness and native effect negative integration require owner-owned isolation. Existing #1260 exact package-version correction is separate; no reimplementation or merge. No main/tag/release, no duplicate dispatch. Actual exact child CI pending.
