# AI-03 | TEST_EVIDENCE

## Reproducible identity and ancestry
- Main observed 2026-10-31: `a19a228dc6f19fd484cf935e941a00ea625233f8`.
- #970 HEAD `5e09c01a1f43b25eaa6b2833dfa191bfdea56b4c` is an ancestor of #981 base `7e4093c30c1ead3cd22888184450c34aef4737da` (ahead 31; behind 0).
- #981 HEAD `b4d6e57053cce6738087e8cecf932fab3492f3c3` is #982 base.
- #982 HEAD/base for this Draft PR: `5e52b756cc6959ffacb7bcd25f2fc1ad2beccc39`; parent-only SUCCESS CI `41139860087`, not applicable to AI-03 changes.
- Draft PR #988: https://github.com/Naveax/Nexowire/pull/988, branch `ai/03-native-verifier-20261031`.
- Previous AI-03 exact HEAD `6834137294da72a981df90d1164019a1e3faee7e`: CI run [41194736068](https://github.com/Naveax/Nexowire/actions/runs/41194736068) (workflow 369213208, run #2311). At inspection six jobs were SUCCESS; browser-live was `in_progress`. No duplicate rerun/dispatch.
- Node 22 job `124518528980` completed SUCCESS with TAP `pass 2397; fail 0; skipped 352; todo 2`. Specific disposable-socket subtests `expired client certificate cannot authenticate or reach authority`, `server certificate rotation requires an explicit new SPKI pin`, and `mTLS adapter bounds response bytes and absolute time, refuses redirects and never retries` reported `ok`.
- Linux native job `124518529065` completed SUCCESS; seven `real PostgreSQL enrollment:` handoff/replay/revoke/expiry tests reported success. The database is a disposable test PostgreSQL instance. Rejection ERROR messages in its logs are expected for negative privilege/rewrite tests and are not a physical acceptance.
- This document/negative-test follow-up constitutes a **new commit**. Its final SHA and exact-head CI must be read from live PR metadata after publication. Earlier runs do not prove this revision.

## Focused negative/positive behavior
- Actual disposable TLS1.3 loopback/mTLS tests retain certificate absence, TLS downgrade, expired client certificate, wrong credential/role/owner/session, replay, stale pin after server key rotation, nonce/hash/signature mismatch, slow and oversized bodies, lost ACK and revoke-after-consumption.
- Last validated candidate `6834137294da72a981df90d1164019a1e3faee7e` tested response `Content-Type`: absent, text/html, duplicated; HTTP redirect/large/trickled response and no automatic retry.
- This revision **adds** HTTP 200 `Content-Encoding: gzip` and duplicated identity encoding rejection, and legitimate `Content-Type: application/json; charset=utf-8` and `Content-Encoding: identity` acceptance. These additions require a new exact-head CI before PASS may be claimed.
- Real PostgreSQL ledger tests verify permanent consumption under replay, concurrent verifier claims, expiry, late/lost ACK and post-COMMIT revoke with synthetic native/signing/identity fixtures.

## Local command execution and evidence boundary
- `node --test --import tsx test/core-native-verifier-server.test.ts`: NOT RUN locally, exit N/A.
- `node --test --import tsx test/core-native-enrollment-verifier-handler.test.ts`: NOT RUN locally, exit N/A.
- `node --test --import tsx test/postgres-core-approval-ledger.test.ts`: NOT RUN locally, exit N/A (real disposable PostgreSQL requires explicit opt-in).
- `node --test --import tsx test/core-native-consent-transport.test.ts`: NOT RUN locally, exit N/A.
- `npm run typecheck`: NOT RUN locally, exit N/A.
- GitHub hosted CI results are separate and identified by exact SHA above. No verified local clone/dependencies; no local test execution claimed.
- Synthetic CAs, software signing keys, test native witnesses and disposable PostgreSQL are **not** real human approval, Windows SCM, TPM/CNG/DPAPI custody, independent restore witness or production PKI. Physical CORE remains `NO_GO`.

## Additional follow-up source tests (NEW HEAD: await exact-SHA CI)
- Modified `test/core-native-enrollment-verifier-handler.test.ts` to generate two more disposable signed X.509 leaf certificates (alternate valid client and expired server). The test verifier's in-memory credential resolver now checks the *actual mTLS peer* SHA-256 in addition to its bearer credential.
- Negative A: an alternate valid client certificate under the same CA with the original bearer reaches the resolver but must be denied 403 with **zero ledger reads/consumes**.
- Negative B: an expired server certificate with a correctly configured SPKI pin must be rejected at TLS client validation before verifier authentication or ledger consume.
- These tests are NOT a locally observed PASS; final SHA and fresh CI to be confirmed after publication. Existing Node 22/24 and disposable PostgreSQL success on prior exact HEAD `dbf3fa213e2e634479f86a95b241d2d68a6c0453` cannot be inherited by this follow-up commit.

## Follow-up: common authority transport fail-closed guard (source pending new CI)
- Last exact SHA before change: `a1cea7e58a853d9e598477e0f2efd64a65c361f5`, workflow `CI` run [41197111450](https://github.com/Naveax/Nexowire/actions/runs/41197111450). At inspection Node 22/24, WSL2, macOS, security and Linux native jobs SUCCESS; browser-live pending. Each Node suite reported 2,399 PASS, 0 FAIL, 352 SKIP, 2 TODO, including new same-CA certificate-bearing and expired pinned server certificate socket negatives. The seven disposable PostgreSQL enrollment tests passed in Linux-native job. None of these results is a PASS for this *new* follow-up commit.
- New `callProtectedCoreNativeAuthority` rejects missing `fetchImpl` instead of using global `fetch`; fails before request/credential transmission. Adds strict common JSON `Content-Type` and `Content-Encoding` metadata checks as defense in depth beyond the concrete Node mTLS adapter.
- New dedicated test cases: no configured transport returns `CORE_NATIVE_PROTECTED_TRANSPORT_REQUIRED` and remote verifier fails closed; reject signed yet malformed / mixed / duplicate JSON media type, wrong charset, compressed or duplicate encoding; accept legitimate JSON and UTF-8/identity.
- New exact-head GitHub CI to be verified after publication; local repository tests remain NOT RUN, exit code N/A. Test-only mock `fetchImpl` does not constitute protected production transport acceptance.
