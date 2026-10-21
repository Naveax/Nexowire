# SCALE S5 | 21 October 2026 source-only main-rebase / gzip admission / one-call review

**Release decision: PRODUCTION NO-GO.** This is a **bounded Work PC SOURCE/localhost-only** review and execution record, not staging acceptance or live-cloud pricing evidence. Tracking #487 / #482, DRAFT S5 PR #606, DRAFT parser #598, DRAFT artifact one-call #596 and merged QA #597 (#588).

## Git and CI provenance

- Reviewed remote `main` SHA: `37d68d938b9c94b8647b92fb592a2b30c075427c`. This S5-only branch was rebased onto that exact commit. Main also includes #601's cancellation byte-budget fencing and #603's noncanonical signature rejection; no code in their ownership areas was changed.
- Original **#606 exact-head** `d99e617f1799426b04da99deb12ce96ca5325b42` => GitHub Actions run [39493273929](https://github.com/Naveax/Nexowire/actions/runs/39493273929) **7/7 SUCCESS**. This is the OLD HEAD before rebase. Do **not** propagate its success claim to the new rebased HEAD.
- Real 21 October Work PC local HTTP measurement ran against source commit **`e71b89dfebdc7362d270534c976307b9d4a47342`**. See immutable JSON [s5-http-4mib-loopback-20261021.json](reports/s5-http-4mib-loopback-20261021.json). The later documentation-only commit changes the PR HEAD; source SHA remains pinned separately.
- After rebase, 33/33 focused tests PASS + `npm run typecheck` PASS on actual checked-out rebased source. Includes the five current-main `scale-v2-artifact-cancel-fencing-staging` tests. GitHub CI against the **new** PR HEAD must be separately verified after push; old 7/7 does not count.

## #598 current gzip admission security review (DRAFT source, NOT deployed)

Reviewed PR #598 source HEAD `cf58e6882e44968698f3f548b353287ba1698747` (`src/mcp/http-app.ts`, `test/mcp-http-json-limit.test.ts`). It proposes:

- Maximum per JSON HTTP MCP body **9,961,472 bytes = 9.5 MiB** and finite response cap. Parser-stage max **four concurrent large/unknown-length POST requests** with slots released after JSON parsing completes, rather than waiting for long-running tool effects.
- Small `POST /mcp` requests with explicit `Content-Length <=100 KiB` can avoid the large-parser busy queue **only** when `Content-Encoding` is identity or absent. Actual compressed `gzip` wire body under 100 KiB may inflate to >100 KiB; it **cannot bypass** the four-parser gate.
- When four parser slots are occupied, PR #598 source returns **HTTP 503 `MCP_JSON_PARSER_BUSY`** for a fifth large request or compressed unknown-size parser. Ordinary framed identity small POST still gets a fast path. This fixes the old S5 local *synthetic fixture* divergence that returned 429; the new fixture mimics 503, but does not test actual source parser.
- PR #598 test includes a **real gzipSync-compressed JSON** regression while four large parsing requests are stalled; it asserts gzip HTTP 503, identity small POST HTTP 200 and fifth parser HTTP 503. Source review is **not** a physical staging result or independently verified PR #598 CI acceptance.
- The S5 fixture's own gzip probe transmits a compressed wire request; it **intentionally does not decompress or parse** the body. The synthetic failure rule aligns the entry admission policy but cannot validate inflation limits, actual Express middleware ordering, SSE limits, DNS rebinding, installed SDK or production ingress.

## Real bounded current-source local measurement

Source SHA `e71b89dfebdc7362d270534c976307b9d4a47342`. Executed one bounded opt-in run `node --import tsx scripts/report-s5-http-mcp-isolation.ts --ack-4mib-loopback`, with loopback-only HTTP server, no external addresses, no real MCP tool dispatch.

| Measured field | Local fixture observation |
| --- | ---: |
| Large active HTTP requests | 4, each 1 MiB |
| Real HTTP request-body bytes received | 4,194,304 |
| Identity-encoded small synthetic MCP POST during large load | 20 / 20 HTTP 200 |
| Small response p50 / p95 / p99 | 30.700 / 31.396 / 31.575 ms |
| Large response p50 / p95 / p99 | 107.317 / 111.036 / 111.036 ms |
| Fifth large request | HTTP 503 × 1 |
| Tiny gzip-encoded request under saturated admission | HTTP 503 × 1 |
| Oversized Content-Length declaration | HTTP 413 × 1 (body not actually transmitted) |
| Backpressure writes | 64 |
| Process RSS peak growth | 13,225,984 bytes (~12.61 MiB) |
| External authenticated native WSS | 0 |
| Verified native tool completions | 0 |
| Cloudflare account bill/Worker/D1/DO measurements | null, NOT_TESTED |

**Quantile provenance:** timings measured with `performance.now()` from local client HTTP request creation to end of corresponding response; they include loopback TCP/Node scheduling, synthetic handler and request-body hash but NOT production MCP work, TLS/WSS, real tool effects or provider network. The S5 implementation uses the **nearest-rank empirical percentile**: sort each array, take `ceil(p*N)-1`. `N=20` for small requests, `N=4` for large requests; with four observations, p95 and p99 are the same maximum. Single Work PC run, no confidence interval or SLO claim; older [20 October JSON](reports/s5-http-4mib-loopback-20261020.json) remains immutable and must not be represented as a current-source metric.

**Work PC safety:** the host was measured approximately 96–97.5% disk-full across the session. Only 4 MiB of ephemeral localhost HTTP bodies was sent and 64 KiB chunks were used; there was no 38 MiB full-boundary saturation, 1 GiB disk allocation, physical network stress, system service change or paid Cloudflare experiment.

## #596 source review (DRAFT) and main / #597 distinction

PR #596 source HEAD reviewed: `335046569a38f3a1a3fc82bf851f9b7df7640fdb`. Its DRAFT branch advertises `artifact_bridge_transfer_start`, `artifact_bridge_transfer_status`, and `artifact_bridge_transfer_cancel` in `src/mcp/cross-device-transfer-job-tools.ts`. They manage a durable, owner/target-scoped background job using bounded 64 KiB native calls; one tool call **starts** a logical transfer and is NOT a 1 GiB JSON/tool response.

In reviewed **main `37d68d9`**, `artifact_bridge_transfer_start` was **not present** in source grep. #597 QA tests are MERGED, but that does not establish the #596 API is merged or deployed. #596's own separate evidence reports **physical 221 KiB and 1 MiB Work PC→Naveax** and **isolated local Hub store 256 MiB+/1 GiB**. These remain **different environments**, and none demonstrates 1 GiB end-to-end live native transfer or independently verified native tool completions under 101+ hosted WSS sessions. The S5 `S5RollingChunkReceiptAudit` verifies only ***claimed metadata*** (1 GiB = 16,384 × 64 KiB synthetic chunk receipts); `independentlyVerifiedDiskHash=false`, `independentlyVerifiedNativeCompletion=false`, `actuallyTransferredBytesByThisAudit=0`.

## Remaining blocker matrix

| Acceptance | Status |
| --- | --- |
| Current source / local bounded small-MCP and gzip admission fixture | **PASS** (33/33 focused source tests; typecheck PASS) |
| #598 real parser full 9.5 MiB ×4, throughput / memory / fairness, authorized staging | **NOT_TESTED** |
| #596 one-call real authenticated deployed cross-device 1 GiB job | **BLOCKED** |
| Authenticated 101+ *simultaneous* native WSS and real completed tool receipts | **BLOCKED** (prior 360 cumulative reconnects, peak 21, native tool completion 0) |
| Provider 600/min and per-tenant fair admission | **SOURCE only**, deployed upstream behavior **NOT_VERIFIED** |
| Cloudflare actual Workers/D1/DO spend/invoice and provider counter deltas | **NOT_TESTED** |
| Continuous 24h native soak with real receipts | **NOT_TESTED** |
| Production | **NO-GO** |

This S5 branch changes **only** `scripts/bench-s5-http-mcp-isolation.ts`, `scripts/report-s5-http-mcp-isolation.ts`, `test/s5-http-mcp-isolation.test.ts` and S5 documentation/evidence after its source-only rebase. No writes to #596 store, #598 parser, #05 Agent File API, account quota, DNS, paid Cloudflare, Hub/Agent services or user data.
