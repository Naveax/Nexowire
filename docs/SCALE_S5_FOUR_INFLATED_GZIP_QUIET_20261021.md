# S5 #15 | 4×9.5 MiB *inflated gzip* vs quiet small HTTP and pending receipt

**DRAFT, source-only; production NO-GO.** Separate S5-owned child of PR #711. No production parser changes, no Agent/Broker/VM, no Cloudflare, no real 101+ public WSS or physical 1 GiB transfer.

## Source and exact CI history

- #598 parser source `cf58e6882e44968698f3f548b353287ba1698747`, `src/mcp/http-app.ts`: maximum **9,961,472-byte JSON envelope**; four concurrent *large/unknown* parser-stage requests. A framed ≤100 KiB identity-encoded small request is allowed independently. A **gzip-encoded small wire request does not qualify** for this small-request bypass. Held slots return HTTP **503 MCP_JSON_PARSER_BUSY** to further large/compressed POSTs; decoded over-limit gzip yields 413.
- #711 head `38dfb89a9a756c42a75ccea9d4a0160067b39110` / exact run [39659054823](https://github.com/Naveax/Nexowire/actions/runs/39659054823): **7/7 SUCCESS**; two hosted Node runs really executed (NOT SKIPPED) four **identity-encoded uncompressed** 9.5 MiB POSTs in parallel plus 64 small POSTs. This is evidence for full-size *identity* JSON parsing, not four full-size gzip inflations.
- #724 independent worker30 QA head `f730943fb2392cbc9b55c11e41750c43802c3482` / run [39659574218](https://github.com/Naveax/Nexowire/actions/runs/39659574218): **6/7 SUCCESS, Windows browser-live FAIL**, specifically `windows-job-owner.test.ts` fast-exit stdout-before-exited regression. Node 22/24 and other platform jobs succeeded. A red inherited Windows Job is not a gzip parser failure and cannot be hidden.
- Latest reviewed main `754cc4364822be5fda528f54042fb22a84f19924`.
- This PR's own exact HEAD/run must be checked independently. A GitHub PR workflow's `GITHUB_SHA` in logs can be the GitHub *synthetic merge checkout SHA*, **not** its Git head SHA; record both. Do not treat hosted checkout SHA as proof of PR branch tip without verifying the event/ref.

### Actually measured #711 full-size identity-body results, single hosted run each

| Measure | Node 22 | Node 24 |
| --- | ---: | ---: |
| 4×9.5 MiB HTTP request-body bytes received | 39,845,888 | 39,845,888 |
| Tiny successful POSTs | 64 | 64 |
| Tiny p50 / p95 / p99 (ms) | 212.759 / 324.254 / 333.556 | 118.040 / 144.798 / 146.657 |
| Large p50 / p95 / p99 (ms) | 857.535 / 919.375 / 919.375 | 880.825 / 920.751 / 920.751 |
| Backpressure drain events | 604 | 604 |
| Peak process RSS growth (bytes) | 208,838,656 | 187,392,000 |
| CPU user/system (µs) | 803,929 / 174,994 | 815,366 / 153,137 |
| Busy fifth large / busy gzip / recovered gzip / over-inflated gzip | 503 / 503 / 200 / 413 | 503 / 503 / 200 / 413 |
| Actual public native WSS, native tool completion and paid Cloudflare use | 0 / 0 / unknown | 0 / 0 / unknown |

**Percentile provenance:** local client `performance.now()` request initiation through complete HTTP response body; *successful responses only*, nearest rank `ceil(p×N)-1`. Tiny N=64, large N=4; for N=4 p95 and p99 both equal the slowest observation. This is a *single hosted loopback sample* per Node version, not a reliable production SLO, and not decompressed gzip concurrency evidence.

**Fixed-seed fingerprint correction:** prior #711 `contentDigest` mistakenly joined receiver hashes in arrival/completion order; Node22 and Node24 logs showed different digests even though individual sender/receiver checks passed. This child now assembles SHA-256 in fixed writer-index order, so the fingerprint has stable ordering across scheduling differences. No deterministic CPU/RSS/latency claims. The 256 KiB original source-pinned measurement is immutable.

## New targeted *decoded* gzip + quiet fairness CI fixture

New `test/s5-598-four-inflated-gzip-quiet-20261021.test.ts` imports the *real* #598 Express parser, binds an ephemeral `127.0.0.1` port, and is **hosted-CI-only**. Four HTTP POSTs have *small compressed wire sizes* but each expands to precisely **9,961,472 JSON bytes**. Gzip payloads are generated from fixed seed `0x5a17c0de` with source-defined unique upload-index patterns; the four expanded payload SHA-256 values are hardcoded and must agree with parser response hashes. One common canonical fingerprint is calculated in fixed index order.

After all four gzip requests enter the parser-stage gate, their wire streams remain intentionally incomplete. **64 simultaneous framed identity-encoded quiet requests** must succeed before any of the four large gzip streams completes. Fifth >100KiB identity POST, a second gzip POST, and a large POST after simulated cancellation intent must return 503, not seize a phantom free slot. Only after all four gzip bodies finish, each must return 200 and the correct source/receiver SHA. This fixture deliberately does not treat an HTTP 200 as a native tool receipt.

**Backpressure/memory:** max four large gzip requests and 64 small, maximum *decoded* size 9.5MiB each, finite socket/request timeouts, 120s test budget, 256MiB process RSS growth guard, 2GiB free disk and 3GiB free RAM precheck. If CI cannot meet preflight, the full case SKIPS; a green overall workflow with a SKIP **does not establish full gzip admission acceptance**. No payload file is written. Since the underlying gzip wire data is compressed, low transmitted wire-byte count must NOT be labeled 38MiB physically transferred over HTTP; **38MiB is decoded/parser content**.

**Cancellation/budget:** A separate local `StagingArtifactByteBudget` with in-memory SQLite has a 64KiB `PENDING` write for the noisy tenant. Cancel *intent*, blind replay and a claimed deletion marker on the OPEN session must not release the charge or unlock the pending write. The independent quiet tenant must still reserve a 64KiB session, and the noisy pending chunk must remain PENDING **even after all four local gzip requests return HTTP 200**. This is source-only ledger and parser admission evidence, **not independently authenticated native cancellation or physical heap reclamation**. An independent `ProposedS5ProtectedTenantAdmission` 40/min strictly partitions 20 noisy / 20 quiet logical reservations; the 64 HTTP quiet requests are *untrusted fixture labels*, not verified authenticated tenant principals.

## Acceptance

| Criterion | Disposition |
| --- | --- |
| #711 real four 9.5MiB **identity** payload parser; 64 quiet-sized calls | **PASS**, exact SHA/run, previously verified |
| Four **gzip** POSTs each decoding to 9.5MiB with quiet HTTP and 503 admission | **NEW CI REQUIRED**. Must inspect actual log, no SKIP |
| Canonical per-upload seeded digest identical across Node22/24 | **NEW CI REQUIRED** |
| Pending reservation retained despite unverified cancellation/HTTP parse | **SOURCE TEST**, independent signed native receipt still BLOCKED |
| Physical memory freed after real authenticated cancel receipt | **NOT TESTED**; peak RSS is an observation only |
| 101+ simultaneous authorized native WSS and verified native tool effects | **NOT TESTED** |
| Physical 1GiB two-device transfer and independently verified final disk digest | **NOT TESTED** |
| Cloudflare Workers/D1/DO actual invoice/meters and 24-hour soak | **NOT TESTED** |
| **Production** | **NO-GO** |

Only test/benchmark/documentation paths under S5 ownership are changed. No production files or paid network resources are modified.
