# AI-05 Test evidence

**Scope:** isolated source and synthetic network/SQL callbacks only; all tests must be tied to an exact Git SHA.

- Repository: `Naveax/Nexowire`; branch: `ai/05-cas-executor`; Draft PR #992
- Stacked base: `7e4093c30c1ead3cd22888184450c34aef4737da`
- Source + tests tip immediately before documentation commit: `2f53b5a923a413a10bb2f054dbfa93469869c9c4`
- CI for that source tip: run `41200171318`, **queued when last checked**, no PASS claim. Final doc-inclusive SHA must be read from GitHub and checked independently.
- Test cases added: `test/ai05-cas-scope-snapshot.test.ts` **10**, `test/ai05-cas-http-outcome.test.ts` **6**, `test/ai05-cas-remote-settings.test.ts` **3**. Total **19 synthetic regression cases**.
- Regression focus: original nested owner/session and UUID substitution, lost ACK/UNKNOWN, previously reserved UUID without local insert, forged `created:false` receipt flip, no accessor/proxy side effects, polluted/non-enumerable fields, 408/425/429/5xx behavior across 3 mutation endpoints, exact JSON bytes despite credential await, authority/provider/credential retargeting after constructor.
- Required commands (when applicable): `node --test --import tsx test/ai05-cas-scope-snapshot.test.ts`; `node --test --import tsx test/ai05-cas-http-outcome.test.ts`; `node --test --import tsx test/ai05-cas-remote-settings.test.ts`; `node --test --import tsx test/agent-remote-cas.test.ts`; `node --test --import tsx test/core-windows-mutation-dispatch.test.ts`; `node --test --import tsx test/qa-fence-request-mutation-p11.test.ts`; `npm run typecheck`; `npm run build`.
- Local runner exit codes: **NOT RUN** (this chat's execution environment did not check out a complete repository with dependencies). GitHub Actions is the source of actual CI exit status, never a simulated run.

## Historic exact-SHA evidence (not transitive)

- `bc29cdc3a777e5c689b38c984626b4cf2becf2cd` CI `41197355153`: Node 22 summary **2,748 tests / 2,394 PASS / 0 FAIL / 352 SKIP / 2 TODO**, prior 9 AI-05 tests observed green. Six jobs SUCCESS; the remaining shared Windows browser-live job was unfinished at that observation. That is not current source proof.
- `9a1081cc9224eb2150c81eda4ebd7392e028f26f` CI `41199874280`: TS2564 (`RemoteMutationCasClient.url` constructor definite assignment). Replaced in a later commit with fail-closed `casHttpsEndpoint` plus direct readonly property assignment.
- `71b861a22b1cc410863112ff3c18ba42ccd35686` CI `41200009642`: TS2564 persisted when assignment was inside try/catch. Corrected in `2f53b5a923a413a10bb2f054dbfa93469869c9c4`; **no claim of current CI PASS until exact run completes**.
- Earlier TS2345 and TS2322 were also caught by hosted CI and corrected without weakening negative tests.

## Physical proof boundary

No independently hosted rollback-resistant CAS or production PostgreSQL, real owner credential, signed protected Broker receipts, true Windows HIGH token/ACL, machine enrollment, revocation/drain or two-PC reboot acceptance was performed. Source-only HTTP/SQL fixtures are NOT native physical evidence. CORE remains NO_GO.

## PostgreSQL Proxy negative
The added synthetic test rejects a Proxy original request, authenticated scope and external receipt before any reflection trap is invoked. Request/scope denial occurs before SQL or external CAS; Proxy receipt denial rolls back and inserts no local tombstone. New exact-head CI is not yet proven; no real OS/CAS authority executed.

## Executor canonicalization and callback negative cases
Source+test tip `33bb714bc158e118ce363f4e17ed39cb864605a0`, CI [41201461962](https://github.com/Naveax/Nexowire/actions/runs/41201461962) in progress at documentation time:
- `test/ai05-cas-executor-snapshot.test.ts`: 4 source-only tests cover nested input Proxy trap denial, frozen accessor-backed Broker callback rejection without evaluating getters, top-level and nested Proxy callback rejection without trap execution, and positive canonical fingerprint/JSON wire binding under the hard-disabled CORE default.
- Previous candidate `38d1f8b7282dd4762e9aa27452e74db992eae660`, CI 41201350578, failed TypeScript `TS18048` (optional approved callback); later source tip adds an explicit terminal absence check without weakening negative cases.
- Updated total AI-05 authored regression suite: **23 tests**, all synthetic. A TypeScript success is not a full Node test suite success, and a Node job success is not an independent Windows/Broker physical acceptance.
- **Final exact HEAD** is the commit after documentation; look up its run ID and exact node/platform logs, do not inherit prior CI.

## Executor request snapshot regression evidence (latest source)
- Source/test tip immediately before this handoff: `a4b81cd13bd9fdceb5e7195f0ede83ad7df3c9bc`.
- CI [41204241838](https://github.com/Naveax/Nexowire/actions/runs/41204241838) on that exact source SHA: Node22 and Node24 typecheck, Node tests and build SUCCESS. Node22 summary: **2,768 total / 2,414 PASS / 0 FAIL / 352 SKIP / 2 TODO**. All **27 AI-05 new tests** were seen green in hosted Node22 and Node24 logs. Linux, WSL2, macOS and security jobs SUCCESS; browser-live was not yet terminal at this observation.
- Four new cases: (i) originally approved mutable nested owner/session/UUID cannot affect frozen request; (ii) original request or nested owner getters not invoked; (iii) Proxy, symbol, extra key rejected without traps; (iv) standalone approved-comparator expected identity with accessor rejected before any getter read. Test files remain `test/ai05-cas-*.test.ts`.
- First code candidate `2fcf9670071f8f564f628a869d24a8b12de0b63a` had test-only TS2322 due to literal-narrowed fixture; `a4b81cd13bd9fdceb5e7195f0ede83ad7df3c9bc` widens only the mutable test variable and preserves all negative checks.
- A new docs-inclusive HEAD requires its own exact-SHA CI, even though it changes no source. No local checkout or physical OS validation occurred.

## Denial list mutability negative test (latest source candidate)
One extra AI-05 executor test rejects runtime clearing/deleting of CORE sandbox/native-effect denial lists, then verifies both forbidden CORE routes still fail closed and the global CORE dispatch flag stays false. The new source branch HEAD and its CI must be verified after this patch, and this test is synthetic source-only, not physical evidence.

## Audited source test count and exact-SHA CI evidence (2026-10-31)
Source-only SHA `ca5f851ddcb5488ab14782ce154247786467cd49`, run [41211445617](https://github.com/Naveax/Nexowire/actions/runs/41211445617): Node22 and Node24 strict typecheck, full test suite, build all SUCCESS. Hosted Node22 log gives **2,769 total, 2,415 pass, 0 fail, 352 skipped, 2 todo**. All **30 AI-05-labelled regression tests** were PASS in each Node22/Node24 log, independently verified against `test/ai05-cas-scope-snapshot.test.ts` (12), `test/ai05-cas-executor-snapshot.test.ts` (9), `test/ai05-cas-http-outcome.test.ts` (6) and `test/ai05-cas-remote-settings.test.ts` (3). Linux, WSL2, macOS and security jobs were SUCCESS; Windows browser-live still running at the point this document was written. In particular, the latest executor negative confirms immutable runtime CORE denial collections resist `Set.prototype.clear/delete` and deny CORE-routed shell/files effects. The historical counts 19/23/27/28 reflect earlier development snapshots or miscounts; authoritative current count is 30. No attached physical Windows/Broker/CAS service was operated, and all new cases are synthetic. This documentation commit changes exact HEAD; CI proof for the final new SHA must be obtained separately.

## Hidden nested JSON descriptor negatives
Two additional source-only executor regressions ensure a hidden nested object property and a hidden array element are denied as `CORE_DISPATCH_INPUT_NOT_CANONICAL` at snapshot preparation. Neither invokes OS/Broker effects. On this new source candidate the AI-05 synthetic test file count is **32** (12 PostgreSQL, 11 executor, 6 HTTPS, 3 remote witness), pending exact-HEAD CI typecheck/test/build confirmation. Do not transfer earlier 30/30 results to this SHA.

## HTTPS endpoint/config runtime retargeting regression candidate
Two new AI-05 source-only negative cases assert `Reflect.set` cannot replace the validated external authority URL or witness credentials after instantiation. Mock fetch checks HTTPS reserve/revoke/re-pair still target the original authority; a separate witness reserve checks its original token. Added guarded source binding locks; all unrelated fail-closed paths retained. **34 authored AI-05 tests** (12 PG, 11 executor, 7 HTTPS, 4 remote) pending this new exact-head CI. Previous 32/32 on `2c2da9206842894d7d1ca5c006612ec61f1baa3f` remains valid only for that source SHA.

## Adversarial constructor config snapshots

Three additional source-only negative tests reject Proxy/getter/hidden/extra constructor configuration for RemoteMutationCasClient, HttpsMonotonicTrustRoot, HttpsExternalGrantCas and PostgresBoundGrantCas before any getter/trap or credential callback executes. Expected new AI-05 authored count: **37 (13 PostgreSQL, 11 executor, 8 HTTPS, 5 remote)**. New source SHA and exact CI TypeScript/test/build must be verified; prior 34-case PASS at SHA `7e402e4efc3d82166a9f26721983b7bb61aa01aa` does not apply to this patch. Linux PostgreSQL 57P03 and Windows WAL 30s worker timeout remain coordinator-owned red results from prior CI.
