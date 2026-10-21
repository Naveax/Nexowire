# SCALE S5 #15: parser cancellation barrier and tenant-source fairness (21 October 2026)

**DRAFT source-only child of #674, production NO-GO.**

## Exact provenance and pre-existing CI

- Baseline #598 MCP parser: `cf58e6882e44968698f3f548b353287ba1698747`. Envelope cap **9,961,472 bytes (9.5 MiB)**, at most four large/unknown-length parser-stage POSTs. Framed <=100KiB identity-encoded POSTs use small path. Tiny compressed gzip bodies cannot bypass admission when all large parser slots are occupied.
- Parent S5 #674: `9dc676ac793ca16233d98c934c46e08d6ead1401`. Exact-head CI [39632610866](https://github.com/Naveax/Nexowire/actions/runs/39632610866) **overall FAILURE**: 6/7 jobs SUCCESS, only Windows `browser-live` FAIL. Hosted log shows `windows-job-owner.test.ts` fast-exit stdout-before-exited assertion, iteration 10. This is an inherited process-owner issue, not evidence the parser/seeded source test failed.
- Current main at first review: `754cc4364822be5fda528f54042fb22a84f19924`.
- This child branch was **created directly from #674 exact HEAD** and edited via GitHub after the authorized Work PC returned **ENOSPC**. No existing user files, caches or project source paths were deleted to regain disk space. The new child commit and its own hosted workflow have separate exact-head status; do not copy success from any previous run.

## Prior measured real #598 Express localhost evidence

Source SHA `6f5ae657e98ec1bcc06f7b3454b0e4d99dbb69b1`, immutable [small-run JSON](reports/s5-598-real-parser-seeded-256kib-20261021.json). The actual source parser accepted four **256KiB** JSON body POSTs and 20 small identity POSTs with seed `0x5a17c0de`, yielding 1,048,576 HTTP request-body bytes for large POSTs. Four fixed seeded content SHA-256 digests are asserted in the source tests. Tiny gzip wire POST under full parser load got **503**, fifth large got **503**; after slots freed a compliant inflated gzip got **200**; gzip inflation exceeding the 9.5MiB cap got **413**, with a potentially HTML Express error body.

| Single local-source metric | Measured |
| --- | ---: |
| Small p95 / p99 (N=20) | 128.201 / 137.367 ms |
| Large p95 / p99 (N=4) | 325.046 / 325.046 ms |
| TCP drain backpressure | 16 events |
| CPU user/system | 704,000 / 187,000 microseconds |
| Process RSS sampled peak growth | 53,284,864 bytes |
| Authenticated real native tool completions / external WSS | 0 / 0 |

Percentile definition: **nearest rank** `ceil(p*N)-1` over successful requests only, timed by `performance.now()` at localhost HTTP request creation to fully consumed response. Failed 503/413/cancelled operations are not included. For N=4, both p95 and p99 equal the maximum. Seed reproducibility applies to **payload bytes and decision transcripts**, not CPU, RSS or latency, which depend on runtime load. Single local sample is no hosted SLO.

The previous S5 #628 benchmark transferred **4×9.5MiB over localhost into a synthetic HTTP sink**, not the real #598 Express parser. A separate full **4×9.5MiB actual Express parser** test was blocked by a mandatory 2GiB disk preflight. During this continuation the Work PC had ~481MiB free, then an attempt to write a small test hit **ENOSPC**. No full parser 9.5MiB measurement, CPU or p99 was fabricated.

## New independent source contract tests

New S5 test `test/s5-source-cancel-close-budget-20261021.test.ts` is built against the real source imports, but has **no deployed runtime or off-host proof**:

1. **Real #598 parser slot hold vs local close acknowledgement:** Open four incomplete JSON POSTs with an explicit server-side arrival barrier. Send 24 ordinary tiny identity-encoded JSON POSTs while all four are held, plus a fifth >100KiB request and a tiny gzip request. Check small requests return 200, fifth and gzip 503, and a second fifth request still 503 after the local *cancellation intent* but before a source-observed `ServerResponse.close`. Destroy exactly one held client and await its local close event; only then accept a new >100KiB POST. Report local nearest-rank p95/p99 without an SLO threshold.
2. **Actual staging byte-budget contract:** Use the repository's `StagingArtifactByteBudget` class with **in-memory SQLite**. A pending 64KiB chunk remains charged through a simulated cancellation request, unknown write, blind replay, forged commit, or a claimed deletion on an OPEN session. Quiet owner still reserves capacity. Even after authenticated-in-fixture durable commit/finalization, storage stays charged until the adapter-provided deletion witness flag. **That flag is synthetic and no independent storage provider or physical cleanup was checked.**
3. **Synthetic buffer reference lease model:** Hold one **64KiB Buffer** strongly referenced after cancel requested. Wrong owner, stale epoch, missing writer-stop or forged test-HMAC receipt cannot release it. Matching synthetic test-only witness releases the *reference*. This proves a **source fixture state-transition contract**, NOT that Node's GC freed physical memory, or that an actual native worker stopped, or that a production authenticated cancellation authority exists.
4. **Seeded tenant fairness:** A fixed-seed shuffled 55 noisy/30 quiet request transcript is replayed against fresh in-memory `ProposedS5ProtectedTenantAdmission` ledgers with a 60/min strict 30/30 share. Expect 30 noisy reserved, 30 quiet reserved, 25 noisy denied, with identical transcript SHA256 on both runs and no duplicate billing. `authorizesToolExecution=false` throughout. This is NOT wired into real Hub per-tenant provider quota or Cloudflare metering.

## Source-only gates and no false completion

| Acceptance | Disposition |
| --- | --- |
| Prior #674 real #598 4×256KiB parser/gzip, source SHA pinned | PASS (previous local evidence) |
| New child parser close, synthetic buffer receipt, budget and seeded tenant tests | HOSTED CI MUST VERIFY child exact SHA |
| Real #598 four simultaneous 9.5MiB parser POSTs / full-boundary gzip under Work PC | BLOCKED by disk safety preflight |
| Proven physical memory reclamation after authenticated external cancellation receipt | NOT TESTED; only parser-slot and buffer-reference contract |
| Authentic signed native cancellation, owner epoch/CAS, final postcondition | NOT TESTED |
| 101+ concurrent authenticated native public WSS / 1GiB actual two-device file | NOT TESTED |
| Cloudflare Workers/D1/DO actual bill/usage meter | null / NOT TESTED (not $0) |
| 24-hour native soak | NOT TESTED |
| **Production** | **NO-GO** |

**No live Agent/Hub/VM, Cloudflare, user-file or remote authorization mutation.** Keep this child DRAFT. Do not silence inherited Windows Job CI red, or merge unsafe production code.
