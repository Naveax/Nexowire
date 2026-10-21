# SCALE S5 #15 | Real #598 full parser boundary, seeded fairness and cancellation ledger

**DRAFT source-only, production NO-GO.** Independent child of #689. No live Hub/Agent/VM, paid Cloudflare, 101+ native WSS or physical 1GiB transfer.

## Verified input and exact history

- Current reviewed `main`: `754cc4364822be5fda528f54042fb22a84f19924`.
- Real parser baseline #598: exact SHA `cf58e6882e44968698f3f548b353287ba1698747`; accepts JSON body up to **9,961,472 bytes (9.5 MiB)**, guards four large/unknown-size concurrent parser-stage requests, allows framed identity-encoded <=100 KiB small requests to bypass that guarded queue; compressed gzip never qualifies for the tiny bypass.
- Parent source S5 #674 SHA `9dc676ac793ca16233d98c934c46e08d6ead1401`: CI `39632610866` 6/7 successful, Windows Job fast-exit red (stdout lost before exited in iteration 10), unrelated to parser metrics.
- Immediate S5 parent #689 exact SHA `58ebfbf608e91d6163169f8fbd9d0ebf6418adf0`: CI `39644753494` **7/7 SUCCESS** (Node22, Node24, browser-live, WSL2, Linux, macOS and security).
- Existing S5 locally measured actual #598 parser 4×**256 KiB** at source SHA `6f5ae657e98ec1bcc06f7b3454b0e4d99dbb69b1`: small N=20 p95/p99 **128.201/137.367ms**; large N=4 p95/p99 **325.046/325.046ms**; observed RSS peak rise **53,284,864B**, CPU user/system **704,000/187,000μs**, gzip busy **503**, compliant gzip after release **200**, gzip inflation over limit **413**. The full JSON is at `docs/reports/s5-598-real-parser-seeded-256kib-20261021.json`. These numbers are measured facts about that local code/host only.

## New test changes (this child PR)

- The original S5 `runS5RealParserSeeded` source benchmark accepts only a strictly bounded optional `smallRequests:20|64`. Default **20** preserves prior regression semantics and pinned local evidence. Any request to test 101 small or 1GiB body rejects before network activity.
- New `test/s5-598-full-boundary-ci-source-20261021.test.ts` exercises the **actual #598 Express source** on an ephemeral `127.0.0.1` HTTP server, not the earlier synthetic S5 sink. It is **CI-only**: with missing `CI=true`, it SKIPS the full-boundary workload. CI requires ≥3GiB free RAM and ≥2GiB free disk; insufficient capacity leads to a recorded SKIP, never an invented PASS.
- Four simultaneous large requests each contain exactly 9,961,472 JSON body bytes, generated incrementally in **max 64KiB source chunks** from fixed xorshift32 seed `0x5a17c0de` and per-upload index. Before completing the four held bodies, **64 ordinary tiny identity-encoded POSTs** must finish successfully; a fifth large and small gzip wire request must receive **503**. After release, valid gzip (2MiB inflation) must produce **200**; gzip exceeding the 9.5MiB expanded cap must produce **413**. The loopback parser returns each payload's SHA256; the sender independently verifies identical hashes. No external addresses accepted.
- Guardrails: max four large requests, 64 small requests, 256MiB RSS *growth* stop, explicit HTTP body timeout (15s), small/gzip request timeout (7s), bounded parser arrival barrier (4.5s), test deadline 90s. A violation fails or aborts, not reclassifies it green. No disk payload file is written.
- Full-boundary test logs `S5_598_FULL_4X9_5MIB_CI_SOURCE` with **exact `GITHUB_SHA`**, seed, payload digest, observed N=64 tiny and N=4 large, p50/p95/p99, backpressure count, CPU user/system microseconds and peak RSS growth. The output is the hosted run's provenance, **not a pinned deterministic timing** and **not an external SLO**. The actual values must be inspected from the *new exact-head* CI, not guessed or copied from the 256KiB run. The seed is deterministic for payload hashes and logical test schedule, not OS jitter or GC.
- Timing definition: local client `performance.now()` from HTTP request creation to full HTTP response body consumption. Empirical nearest-rank `ceil(p×N)-1` after sorting only successful operations. Rejected 503, gzip 413 and cancellations are **excluded** from successful latency percentiles. N=4 large p95/p99 are identical to the slowest large request.
- Observe that source-only localhost POST successes are **NOT** authenticated production MCP tool completions, Windows HIGH token use, public WSS, or Cloudflare usage. Cloudflare cost remains `null` (unknown, not zero), production **NO-GO**.

## Pending cancellation memory and reservation source truth

Inherited from #689 and continuously covered by its tests:
1. Actual #598 parser: four incomplete large JSON requests hold parser-stage reservations. A mere **cancellation intent** is insufficient to free a slot; after one locally observed `ServerResponse.close`, only then can one new large parser request enter. This is *parser-stage admission*, NOT proof physical RSS was freed or a native side effect was cancelled.
2. `StagingArtifactByteBudget` against **in-memory SQLite**: one 64KiB PENDING chunk retains byte/storage debit on lost/unknown ack, blind replay and fake/foreign receipt. Quiet owner can reserve separately. Even after trusted-in-fixture durable commit, the file's charge persists until a corresponding deletion witness supplied by a trusted fixture. Production #08 store, agent journal and actual authenticated cancellation receipt are not exercised.
3. 64KiB strongly referenced Buffer is released in a separate synthetic *state* fixture only after correct test-HMAC owner/job/epoch/writer-stopped marker. Forged/stale/foreign markers retain the reference. **Buffer reference release is not proof V8 reclaimed heap pages**, and the HMAC is deliberately *not* an independent external native attestation.
4. Tenant admission via isolated in-memory SQLite: deterministic 60/min split 30/30 across 55 noisy and 30 quiet requests; noisy surplus denied, quiet preserved. This does **not** enforce provider billing or Hub runtime quotas.

## Acceptance gates

| Gate | Status |
| --- | --- |
| Prior #689 exact-head hosted CI | **7/7 SUCCESS**, exact SHA verified |
| New child full #598 Express 4×9.5MiB + 64 tiny | **NEW EXACT-HEAD CI REQUIRED**; no claimed measurement before hosted run |
| Deterministic payload SHA and logical tenant transcript | Source implementation + inherited tests; **new hosted CI required** |
| Pending reservation unreleased before independent real native receipt | **Source-only fixture**, production **BLOCKED** |
| Physical RSS reclaimed exactly on cancel receipt | **NOT TESTED**, metrics only measure peak |
| 101+ simultaneous authenticated public native WSS + verified tools | **NOT TESTED** |
| Real 1GiB Agent→Hub→Agent file with final disk digest | **NOT TESTED** |
| Cloudflare Workers/D1/DO authenticated actual spending | **NOT TESTED** |
| Continuous 24h native soak | **NOT TESTED** |
| **Production** | **NO-GO** |

Work PC was ~99.8% full (~474MiB free) when this child was created. The full case is intentionally NOT run on Work PC; GitHub-hosted isolated job is the test environment. No local disk cleanup or background stress, no production deployment.
