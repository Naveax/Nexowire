# AI-05 handoff | provisional

- **Decision:** source candidate IN_PROGRESS / awaiting exact-head CI; **production NO_GO**
- Branch: `ai/05-cas-executor`
- Draft PR: https://github.com/Naveax/Nexowire/pull/992
- Base: `integration/core-after-v108-20261030`
- Base SHA: `7e4093c30c1ead3cd22888184450c34aef4737da`
- Latest code SHA immediately prior to handoff update: `2f53b5a923a413a10bb2f054dbfa93469869c9c4`
- **Final exact PR HEAD:** obtain from PR after documentation commit. It cannot be self-referenced from a document within that commit.
- Changed files: `src/agent/postgres-bound-grant-cas.ts`, `src/agent/https-external-grant-cas.ts`, `src/agent/remote-mutation-cas.ts`, 3 new `test/ai05-cas-*.test.ts` and 5 `docs/ai-handoff/AI-05/*.md`. No shared or other-agent source.
- New negative regressions: **19 synthetic cases** (10 PostgreSQL, 6 HTTPS, 3 remote witness). Exact final-head CI verdict, original tests, TS/build and platform run statuses must be independently confirmed before READY_FOR_REVIEW.
- CI run seen for code tip: `41200171318`, queued before this documentation-only commit.
- No local exit codes: tests were not run from a full local clone. See `TEST_EVIDENCE.md`.
- Native/physical evidence: **NOT RUN / NOT PROVEN**. Only source and mocked HTTP/SQL assertions. No installed service, real device enrollment, UAC/ACL, credential or broker changes.
- Flag: `CORE_EXECUTOR_DISPATCH_ENABLED=false`. No merge, deploy or main push.
- Outstanding blocker: independent trusted CAS custody and release/revoke monotonicity, protected Broker receipt/native source, real OS sandbox, coordinator integration, two-PC physical restart and revoke/readback.
- Next: track exact-head CI, make owner-only CI fixes if necessary, and send evidence/required API handoff to coordinator. Treat CI SKIP/TODO as not physically validated.

Follow-up: one Proxy-trap negative regression increases new AI-05 synthetic coverage to 19 tests. Verify on final PR exact HEAD; production remains NO_GO.

## Latest source candidate delta
The executor canonicalization rejects nested Proxy inputs and frozen accessor-bearing/Proxy approved callback objects with 4 new AI-05 regression cases. **23 authored synthetic tests in total.** Code tip before this documentation commit: `33bb714bc158e118ce363f4e17ed39cb864605a0`, CI run `41201461962` had Node 22/24 typecheck success but full CI was in progress at last inspection. Final exact HEAD must be verified from PR metadata and its own workflow. Independent protected Broker, rollback-resistant CAS custody, OS sandbox and two-PC enrollment remain NOT PROVEN. Draft/production CORE NO_GO persists.

## Latest source evidence / reviewer decision
- Source tip before final handoff update: `a4b81cd13bd9fdceb5e7195f0ede83ad7df3c9bc`. Latest PR HEAD must be queried from GitHub after this document commit.
- **27 new synthetic AI-05 tests**: 10 PostgreSQL scope, 6 HTTPS uncertainty, 3 remote witness, 8 executor. All 27 passed on source tip in Node22/Node24 hosted logs; Node22 overall 2,768 tests, 2,414 PASS, 0 FAIL, 352 SKIP, 2 TODO. Four recent cases prevent mutable/or accessor-backed nested Broker scope from substituting the request before the CAS await.
- Source CI [41204241838](https://github.com/Naveax/Nexowire/actions/runs/41204241838): Node22/24/Linux/WSL2/macOS/Security SUCCESS, Windows browser-live was still running at the latest observation. **Full CI and docs-inclusive exact HEAD need fresh verification.**
- Prior exact SHA 1b3f78d… had Windows #974 journal worker 30s IPC timeout; handoff routed to coordinator, without touching its code or weakening tests. The later source CI passed the WAL step, but intermittent worker hangs need investigation.
- **Decision: READY_FOR_SOURCE_REVIEW only where CI confirms; PRODUCTION CORE NO_GO.** Independent CAS anti-rollback custody, signed native Broker OS admission/ACL, sandbox, physical owner enrollment and two-PC restart/revoke acceptance remain NOT PROVEN. CORE default false, no merge or deploy.

## Fail-closed defence-in-depth follow-up
The exported CORE sandbox/native-effect denial lists now use a genuinely immutable façade rather than a runtime mutable Set with a compile-time readonly annotation. Added a negative test for .clear/.delete and preserved CORE source default false. A new exact-SHA CI result is required; earlier 7/7 pertains only to the earlier SHA.

## Verified source-run evidence and final inventory correction
Immediate source tip `ca5f851ddcb5488ab14782ce154247786467cd49`: [CI 41211445617](https://github.com/Naveax/Nexowire/actions/runs/41211445617), six successful jobs and one Windows job in progress at handoff creation. The Node 22/24 test jobs were both SUCCESS with **30/30 AI-05 source-only tests PASS**; Node22 whole suite **2,769 total / 2,415 PASS / 0 FAIL / 352 SKIP / 2 TODO**. Exact file count: 12 PostgreSQL + 9 executor + 6 HTTPS + 3 remote witness. Runtime immutable CORE deny lists close a code-only mutation bypass; `CORE_EXECUTOR_DISPATCH_ENABLED=false` stays. All docs-inclusive exact HEAD CI checks are mandatory; do not transfer PASS across SHA. Draft PR #992, no merge/deploy/native OS action. Physical enrollment, independent monotonic CAS custody, signed native Broker receipt, low privilege sandbox and two-device acceptance remain **NOT PROVEN / production NO_GO**.

## Additional executor canonical input closure
Rejected hidden nested JSON object fields and hidden array indices instead of promoting them to newly enumerable wire payload fields. Added 2 negative source regressions (AI-05 total 32 authored tests). The new exact HEAD must pass CI; CORE remains disabled and all physical/production acceptance remains NO_GO.

## Remote authority retargeting follow-up
Validated HTTPS CAS authorities are now fixed immutable string routes and runtime config/credential resolver bindings are non-reassignable, closing an in-process post-validation URL retargeting gap. Two source-only adversarial tests increase the authored AI-05 total to 34 (12 PG, 11 executor, 7 HTTPS, 4 remote). This update requires its own exact-HEAD CI result; no source test substitutes for live OS/Broker or physically independent antirollback CAS evidence. Draft / CORE NO-GO.
