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
