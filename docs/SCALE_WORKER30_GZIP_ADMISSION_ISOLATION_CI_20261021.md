# Worker #30 | CI-measured 4×9.5MiB gzip review and missing isolation negatives

**2026-10-21 · Independent source QA only · DRAFT · production NO-GO**

## Immutable parent evidence

- #693 head **`8b08ede8db29fd9a95abb762b238601def07082d`**, exact GitHub Actions CI **`39644977870`**, completed **7/7 SUCCESS**, including Windows browser-live native Job. Earlier #674 run `39632610866` still failed its own Windows Job. Different SHA/run outcomes must never be conflated.
- Parser owner DRAFT #598 pinned SHA **`cf58e6882e44968698f3f548b353287ba1698747`**. New child inherits parser unchanged and imports the *real source app*, not a substitute fake parser.
- GitHub CI emitted checkout/merge SHA `30e9ecf71a899a4abd200b23cb93c22dffbfc758`, **NOT** #693 PR head. New child head SHA and run must be verified separately.
- Parent fixture seed **`0x30ca5e21`** = 818568737; four gzip body bytes **9,733** each, each decompressing to exactly **9,961,472 JSON bytes**; aggregate **39,845,888 decoded bytes**. Each source route verified SHA-256 `8be76c6b88f5e09456fa2ca99d3011ce64e398e3d9839dd0583c8aa55f3a72a1`. All four completed **200**; fifth concurrent gzip rejected **503**. This is a **local compressed wire experiment**, **not** four uncompressed 9.5 MiB network uploads or 1 GiB file tests.

### Quantiles from successful #693 exact-head runner logs

| Measure | Node22 | Node24 | Population/method |
| --- | ---: | ---: | --- |
| HTTP 200 tiny p50 | 25.679 ms | 17.715 ms | N=60, all tenants |
| HTTP 200 tiny p95 | **100.057 ms** | **56.263 ms** | N=60 |
| HTTP 200 tiny p99 | **147.169 ms** | **76.274 ms** | N=60 |
| HTTP 429 p50 | 15.832 ms | 14.908 ms | N=30, noisy quota-rejected |
| HTTP 429 p95 | **24.918 ms** | **20.894 ms** | N=30 |
| HTTP 429 p99 | **33.498 ms** | **27.702 ms** | N=30 |
| Peak observed process RSS growth | 181,444,608 bytes | 223,703,040 bytes | Observational only, not allocated-byte claim |

**Provenance**: `performance.now()` taken before each localhost `fetch`, ending after full response JSON body read. Success and denied latencies have separate populations. Nearest-rank selection `sorted[ceil(p*N)-1]`. N=60 success p99 is the maximum; N=30 rejection p99 is also the maximum. The seed fixes the shuffled arrival order and gzip body content; it does **not** pin CPU scheduling, RSS, latency or p95/p99. **No throughput SLO or production memory cap** follows from these two runners.

## Missing source QA, now isolated in this child

### 1. Global parser admission is not authenticated tenant fairness

`test/worker30-quiet-gzip-starvation-negative.test.ts` holds four **incomplete noisy-owner gzip members** on actual #598 Express via server request-arrival barrier (no sleeps). Before release, it requires:
- The quiet tenant's **tiny gzip** request to be rejected HTTP **503**, *even though its compressed wire body is tiny* and its staging quota is free.
- The quiet tenant's **tiny identity-encoded chunked/unknown-length** request also gets **503**: only properly framed small identity requests bypass the shared 4-slot pool.
- Seeded 40 noisy + 20 quiet **framed identity** tiny requests, eight client workers: quiet must succeed **20/20**, noisy **24** reserved + **16** denied by a **separate, test-only strict-share SQLite ledger** (48 global, 24/24 protected). Verify blocked gzip/chunked requests never reach the ledger.
- After the four held uploads close, quiet gzip must enter and reserve its still-available 21st quota token (HTTP 200). Count and route evidence must be exact.
- Report **per-tenant**, not merely pooled, p50/p95/p99: quiet admitted N=20; noisy admitted N=24; noisy rejected N=16. Timing uses the same monotonic request-to-consumed-response clock and nearest-rank method. No wall-clock SLA assertions.
- The header is **untrusted test fixture routing**; production has no evidence of an authenticated tenant-aware parser scheduler. The expected pre-release 503 is an explicitly **documented global fairness gap**, not a desired protected-tenant capability or a production PASS.

### 2. Re-pair invalidates even previously minted fixture-only completion evidence

`test/worker30-epoch-repair-pending-regression.test.ts` uses the actual proposed in-memory staging `StagingArtifactByteBudget` for two PENDING 64KiB chunks, plus an explicitly named **test-only epoch fencer**:
- A staged pending chunk cannot be replayed, committed with a mismatching digest, finalized early, or freed by a premature fabricated deletion receipt.
- Cancel + lost ACK -> UNKNOWN reserves owner A's memory budget. New request remains THROTTLED while owner B still has isolated admission capacity.
- Crucially, an **old opaque token minted before owner re-pair** is invalidated by the new epoch, even if it previously claimed stopped writer + digest readback. A stale epoch cannot release A's memory while an externally authoritative reconciliation is missing. Source has no actual CAS service/attestation.
- Storage source state stays **2 PENDING** chunks and **262,144 bytes reserved**, independent of test-only memory. No duplicate refund, no assumed remote durable completion, no native re-execution.
- The fencer is a **reference model** and not proof of a deployed signed immutable writer-stop postcondition.

## Reproduce, exact SHA/CI gate

```sh
node --test --import tsx test/worker30-quiet-gzip-starvation-negative.test.ts test/worker30-epoch-repair-pending-regression.test.ts
npm run typecheck
```

All actual GitHub CI statuses must be tied to the **new child head SHA**; a workflow checkout's temporary merge SHA is not the branch HEAD. No skip/mocking existing hosted Windows Job red. A second run for the same SHA is prohibited without changed inputs and an explicit need.

No edits to `src/mcp/http-app.ts`, #15 parser tests, owner Artifact files, billing or workflow files. No paid Cloudflare, D1, native Broker, Agent, Windows ACL/UAC, live Hub, VM or ReVoltVPN-Ubuntu-Lab. **Real 101+ authenticated public WSS, physical 1 GiB native transfer, paid resource costs and cross-Hub rollback safety remain NOT TESTED / NO-GO.**
