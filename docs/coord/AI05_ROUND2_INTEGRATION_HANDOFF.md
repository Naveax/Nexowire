# NEXOWIRE AI-05 Round 2: frozen Windows integration (DRAFT NO-GO)

Frozen base: `37fc9163e2b7ccd93600ee23b63f19d4e44ddb77`. New exact source deltas:
- #1088 `2d2b9e7dd946c91f1ff63d50feab953ef47b464e`: 11 exact Git file blobs
- #1087 `7a580104def439e217fe1facb27334c78c29f3e7`: 7 exact Git file blobs
- #1086 `1b85b2c25d1822e10269bd49188bd667fd225408`: 10 exact Git file blobs
- #1067 `bcfe563cc1ea7f884263c113ad269c1e8f6bcd6e`: 1 exact Git file blobs
- #1077 `6f98aa94b5bc1a217576666317039254ee7e1c09`: 1 exact Git file blobs

`docs/coord/AI05_ROUND2_SOURCE_PRESERVATION.csv` retains 243 historical source rows, 30 exact new source rows, derived integration rows and two explicit MISSING production trust gates. Historical Connection matrix 79 original source rows preserved, with candidate blobs updated. No source code file lost.

CORE 0020/0021 preserved; AI-03 0022 added with server issued monotonic authorization epoch and 30s lease, D1+memory negative QA. No production database migration performed.

AI-04 atomic-mutation contract and socket-bound helper preserved as exact sources. AgentBroker optional trusted coordinator can fence immutable frame enqueue against revoke with protected provider; missing provider denies when required. Native Agent opt-in independently verifies provider reservation and one-time effect consumption. No real durable cross-process shared authority, signed native grant or CORE UUID-to-numeric-epoch mapping exists, so production remote mutations remain NO-GO. Legacy Boolean verifier is not a production atomic fence.

Node22 `src/mcp/http.ts` timeout is now a referenced timer, V2-03 test retained. CI runs real Windows Node22/24 security and new AI03/04/05/06 negative checks, existing S5/57, PostgreSQL CORE/Native ACK, Browser Live, CLEAN-10 and no replay.

AI-06 SQLite WAL/FULL writer and 80-record legacy JSON migration sources are exact; each physical device must have its own Hub journal. After SQLite commits, JSON-only rollback is forbidden. An obsolete separate binary cannot be prohibited by new application code alone; signed launcher+installer policy is MISSING and physical cutover/rollback is BLOCKED. No actual NAVEAX/Work-PC device or service was touched.

Previous #1089 `37fc9163e2b7ccd93600ee23b63f19d4e44ddb77` CI 42109204286 PASS 16/16, Relay 42109204241 PASS 4/4, Readiness 42109204414 SUCCESS. Those runs do not validate the new combined SHA. AI-08 disposable VM, AI-09 Git DAG and AI-10 release review required. Do not merge main, deploy, enable CORE or cloud ingress. **NO-GO**.

## AI-05 Round 2 checkpoint: final source-only support imports (2026-11-06)

Source baseline `c68f90c66490f05a4bd2f0713d3763a54149e014` had full combined CI 16/16 PASS, Windows AI-04 QA 2/2 PASS, Relay QA 4/4 PASS and Release Readiness 3 package PASS (publish gates skipped). Those results apply ONLY to the old baseline SHA.

The four newer exact source blobs copied into this staging branch without modifying the four originals are:
- #1088 `d687181269c11ae913051ed6c75a1a3d139f584b`: `.github/workflows/ai03-windows-authority.yml` (`c73aceca673a8c702e1320634c156e1a56afb386`)
- #1086 `eee335eb4188eb82614c6791c67622d7832646b5`: `docs/NAVEAX_SQLITE_HUB_AI06_ROUND2_ACCEPTANCE_20261106.md` (`b43bd6bf6e5a37efb7b45c9e5c4307357d8b6d22`)
- #1086 `eee335eb4188eb82614c6791c67622d7832646b5`: `scripts/ai06-hub-sqlite-cutover-preflight.ps1` (`46e4108e148ff5979a965d2dc2bc1c7c07faf60f`)
- #1086 `eee335eb4188eb82614c6791c67622d7832646b5`: `test/idempotency/sqlite-windows-cutover-preflight.test.ts` (`ab94718baead4e8867ff708252aa890705087774`)

The Windows AI-03 workflow explicitly runs the four authority/migration negatives under Node 22 and 24. The AI-06 PowerShell preflight is **read-only**, refuses a JSON-only target, and its real Windows negative test is included. The preflight is **not** a mandatory part of the existing Windows updater/rollback execution chain. The SQLite-only rollback production guard is therefore still MISSING, not PASS. A signed native cloudflared launcher/image provenance and independent durable revoke-to-native-effect CAS also remain MISSING. Exact-head CI, independent security review, disposable reboot/rollback and authorized two-PC evidence remain outstanding. Keep #1089 DRAFT / PRODUCTION NO-GO; do not merge main or deploy to physical Windows PCs.
