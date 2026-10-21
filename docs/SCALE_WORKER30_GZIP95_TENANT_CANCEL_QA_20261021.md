# Nexowire Worker #30 | Full 4 × 9.5 MiB gzip and per-tenant pending-receipt QA

**2026-10-21 | Independent QA-only child of PR #660 | DRAFT / PRODUCTION NO-GO**

## Pinned provenance

- Base #660 (source QA, exact head): `554528df1dd2be0c265571ac8a1233fade78da13`; verified workflow `39630981024` **SUCCESS** for that exact HEAD, not transferable to this new branch.
- Proposed #598 parser source SHA `cf58e6882e44968698f3f548b353287ba1698747`. Branch inherits `src/mcp/http-app.ts` from that commit and imports it directly; no HTTP owner implementation edits.
- #15 owner #674 source head `9dc676ac793ca16233d98c934c46e08d6ead1401`, exact CI `39632610866`: Node22/24 + five other jobs SUCCESS, Windows browser-live **FAIL** (native Job step). #674 measured four 256 KiB real parser streams; explicitly kept its four full 9.5 MiB path BLOCKED by a source runner disk guard. This distinct #30 acceptance uses gzip-compressed **9.5 MiB decoded** data via localhost only, not the same 4×9.5 MiB uncompressed wire traffic or its disk/memory throughput evidence.
- Child SHA and associated GitHub run must be read from this PR's *own* GitHub checks, after upload. Any `GITHUB_SHA` in PR workflow logs is a **merge checkout SHA**, not the exact source PR head. Source SHA and QA parent SHA are explicit in log markers.

## Real parser source fixture (bounded)

`test/worker30-gzip95-tenant-isolation.test.ts` imports the actual DRAFT `createNexowireMcpExpressApp`.

- Four gzip requests contain **exactly 9,961,472 decoded JSON bytes apiece**. The total nominal decoded payload is 39,845,888 bytes. A preconstructed bounded gzip buffer is re-used; no disk files, external sockets or native tool effects.
- Four HTTP requests send only a partial compressed member to occupy the four source parser slots. A server `request` event barrier confirms arrivals; no fixed-duration sleep decides occupancy. A fifth gzip request returns parser-busy HTTP 503. Once 90 small requests finish, the four gzip streams complete. Each must return HTTP 200 and exactly the source-side expected SHA-256 of decoded JSON.
- While those large gzip requests are unfinished, 90 framed **tiny identity POSTs** run via eight bounded localhost clients using seeded permutation: 60 noisy and 30 quiet. A *separately installed staging-only SQLite strict-share ledger* with a 60/min logical budget deliberately reserves 30 for each. Exactly 60 accepted, 30 noisy rejected; the quiet 30/30 must succeed. A test header selects a **synthetic fixture tenant**, not real OAuth/owner authorization. The parser itself **does not enforce per-tenant quotas**, and the test does not claim it does.
- `process.memoryUsage().rss` peak delta is **observational**, not an asserted production allocation limit. Full gzip expansion consumes in-process test memory; this is not a physical 4×9.5 MiB wire-upload throughput result. No real 101+ WSS, no 1 GiB file and no paid service tests.

## Pending cancellation memory source contract

`test/worker30-pending-memory-fence.test.ts` drives the existing `StagingArtifactByteBudget` against an ephemeral **in-memory SQLite** DB to confirm two source chunk requests remain `PENDING` and their storage reservation is not double-refunded. Independently, a **test-only resource lease simulator** models 65,536-byte per-chunk memory and 131,072-byte owner budget:

- Cancel requested and lost ACK become `CANCEL_PENDING / MUTATION_UNKNOWN`: the memory charge remains.
- A forged client receipt, wrong owner, old owner epoch/re-pair, invalid SHA or proof without both stopped-writer and verified source readback cannot release memory.
- An opaque simulator-minted witness released after **both test-controlled writer stop and digest readback** unlocks precisely one memory slot; replay does not unlock another. The other owner retains independent reserved bytes.
- Crucially, source SQLite still has two pending durable chunks and 262,144 bytes of reserved staged *storage* after simulated memory release. Storage credit does **not** follow test-only memory credit.
- **NOT production proof:** #598 has no hooked-up authenticated per-tenant memory ledger, no external durable fence and no real signed independent witness. Test-only observers are not security attestations. Actual cancellation/readback integration remains BLOCKED.

## Percentile and reproducibility contract

- Fixed seed `0x30ca5e21` (decimal 818568737), xorshift32 for the 90-request input order. The gzip decoded contents are reproducible, with sender/completed-handler hashes checked.
- The elapsed clock is `performance.now()` from creation of each `fetch` to **complete response JSON consumption**. Successful HTTP 200 and rejected HTTP 429 are reported as separate samples.
- `nearest-rank`: sort nonnegative finite values, then select array index `ceil(N×p)-1` for p50/p95/p99; N=60 success and N=30 denied. The four large parser cases report **counts and exact SHA-256 only**, not fictional p95/p99 timing. Seed controls inputs, **not** OS scheduling, memory, CPU or latency. One GitHub runner sample is **not a provider SLO**.
- Log markers `QA30_GZIP95_FAIRNESS` and `QA30_PENDING_MEMORY` include classification, SHA metadata, seed, sample counts and critical negative-state outcomes. Reproduce with:

```sh
node --test --import tsx test/worker30-gzip95-tenant-isolation.test.ts test/worker30-pending-memory-fence.test.ts
npm run typecheck
```

## Merge blockers

- Parent #660 has exact-head GREEN; #674 and original #598 have **real hosted Windows Job failures**, not acceptable to skip or relabel. New child must be evaluated on **its own** exact commit and named job outcomes; no same-SHA duplicate CI.
- No edit to owner-owned HTTP, memory, Artifact Bridge or workflow files. No Agent, Hub, Broker, UAC, VM, ReVoltVPN-Ubuntu-Lab or paid Cloudflare control plane/D1/billing. None of the tests authorizes native operations.
- True authenticated remote tenant scheduling, independent writer-stopped and deletion readback, genuine full-wire 4×9.5 MiB transport, production RSS budget, 101+ concurrent public native WSS, cross-device 1 GiB with independent disk hash and money spent remain **NOT TESTED / NO-GO**.
