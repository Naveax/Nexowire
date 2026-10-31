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
