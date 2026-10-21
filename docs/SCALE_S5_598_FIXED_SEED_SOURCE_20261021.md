# Nexowire S5 #15 | Fixed-seed real #598 parser admission audit (21 October)

**Test/docs-only child of DRAFT #598; production NO-GO.** This branch adds only S5 source testing, a seeded localhost benchmark, an immutable result and documentation. It does not alter `src/mcp/http-app.ts`, #649 worker30 tests, Windows Job, Artifact Bridge, Agent, OAuth, VM, quotas or Cloudflare.

## Exact heads and CI baseline

- Base **#598 head**: `cf58e6882e44968698f3f548b353287ba1698747`. This DRAFT parser PR previously had a shared hosted Windows Job `browser-live` CI failure; do not call parent 7/7 PASS.
- Independent QA **#649 head** `955cf289b4b0375ab37c4bcda82cd8706a414135`, run `39628451245`: **six successful hosted jobs, Windows browser-live FAIL**. Node22 and Node24 PASS. This QA was reviewed for overlap but its test files are untouched by #15.
- Older S5 **#628 head** `a0ebd60117fb79bfe41c14bbf134efdf15309256`, run `39608864172`: **7/7 SUCCESS**, but this tests the older synthetic HTTP/metadata contracts and is NOT exact CI for this child.
- Latest inspected main `754cc4364822be5fda528f54042fb22a84f19924`. New child exact HEAD and GitHub Actions run must be checked independently.
- **Measured executable source SHA** `6f5ae657e98ec1bcc06f7b3454b0e4d99dbb69b1`. See immutable [s5-598-real-parser-seeded-256kib-20261021.json](reports/s5-598-real-parser-seeded-256kib-20261021.json). Later documentation commits do not change this measurement's code provenance.

## Actual physical localhost Express parser and fixed seed

`scripts/bench-s5-real-598-seeded.ts` **imports the real source** `createNexowireMcpExpressApp` from DRAFT #598. It uses an ephemeral 127.0.0.1 HTTP listener, no external host argument, auth token, Cloudflare, Hub, native Agent or privileged process.

- Four simultaneous *partially held* parser-stage POSTs, then 20 ordinary framed identity-encoded small POSTs while those four parser requests are still held. Each ordinary POST received HTTP 200.
- Real gzip wire request expands from a compressed small body to 2MiB, gets parser-busy HTTP 503 while the four parser slots are reserved. A fifth large POST also gets 503. After the four finish, gzip 2MiB is accepted (200); gzip inflation beyond the 9.5MiB JSON limit is rejected 413. Current #598 Express error response on that overflow can be **HTML**, not JSON; the test accounts for this rather than interpreting the HTML as a parser failure.
- Four deterministic payloads use seed `0x5a17c0de` (decimal **1,511,506,142**), xorshift32, 64KiB producer chunks and independent incremental sender SHA-256. The parser route independently hashes each complete JSON payload. Each source stream's digest is asserted against a source-pinned fixed digest; the four differ by upload number. This proves **content reproducibility**, not clock/CPU determinism.
- The real-parser small CI fixture sends 4 × 262,144-byte requests = 1,048,576 total HTTP bytes. All four returned 200 and passed sender/receiver digest comparison.
- Actual measured local CPU and memory are **observational**, not seeded or guaranteed. Run-level CPU is `process.cpuUsage` delta, including user/system; peak RSS is sampled every 10ms plus per-chunk checkpoints. The benchmark fails closed if RSS growth exceeds 256MiB.
- The production #598 ingress route is **not** a native MCP authenticated or tool-dispatch session; no native tool completion is implied by a 200 synthetic local JSON handler.

### Measured bounded real-parser sample

| Field | Single local run, source SHA 6f5ae657... |
| --- | ---: |
| Source body size | 4 × 262,144 bytes |
| 20 framed small MCP-shaped requests during four parser slots | **20/20 accepted** |
| Small p50 / p95 / p99 | **117.718 / 128.201 / 137.367 ms** |
| Large p50 / p95 / p99 | **319.988 / 325.046 / 325.046 ms** |
| Busy fifth request / gzip-inflated wire under load | **503 / 503** |
| gzip 2MiB after releases / gzip inflation over limit | **200 / 413** |
| Client TCP backpressure events | **16** |
| Peak RSS growth | **53,284,864 B** (~50.82 MiB) |
| CPU user / system | **704,000 / 187,000 μs** |
| Wall time | **641.935 ms** |
| Public native WSS / verified native completion / live cost | **0 / 0 / unknown (null)** |

**Quantile provenance:** `performance.now()` from creation of each localhost HTTP request to reading its complete response. Percentiles use **nearest-rank**, sorted `ceil(p × N)-1`: N=20 successful small responses and N=4 successful large responses. The 503 and 413 requests are excluded from successful request latency distributions. With only four large samples, p95 and p99 are both the maximum. Single run, no confidence interval or public hosted SLA inference.

## 4×9.5MiB real-parser safety gate, BLOCKED

The explicit opt-in command is `node --import tsx scripts/report-s5-real-598-seeded.ts --ack-local-4x9_5mib-source-only`. It is implemented **but not executed at large-body size** on this Work PC. At verification the workstation had only ~573MiB free on C: and intermittently high CPU, so the source reporter's **minimum 2GiB available disk** guard returned `S5_DISK_PRECHECK_BLOCKED_MIN_2GIB` (exit 2) without creating a full-size measurement JSON. Source also requires ≥3GiB free RAM, max four 9.5MiB requests, max 64KiB incremental send buffers, 256MiB peak-RSS growth stop, finite network timeouts and a localhost-only server.

The prior #628 source-only benchmark **did transmit** 4×9.5MiB HTTP over loopback into a **synthetic sink**, but did not import #598's Express parser. **Do not relabel it as four successful real parser requests.** Full-boundary production source result remains **BLOCKED**, not PASS.

## Fairness and expense provenance

The S5 test uses the real local `ProposedS5ProtectedTenantAdmission` class against an **in-memory SQLite** fixture: 40/min global budget split 20/20. A noisy tenant gets 20 successful reservations and 20 rejections; a quiet tenant still gets 20 reserved calls. Duplicate requestId and forged tenant are denied/idempotent; `authorizesToolExecution=false`. This is **separate** from the real #598 parser and does not prove HTTP request charges are integrated into the production Hub, a remote lease, or provider billing.

#649 independently covers staging byte-reservation cancellation. Its failing hosted Windows Job regression remains an inherited **separate CI gate**. This branch does not change QA owner files or hide red jobs.

| Acceptance | Status |
| --- | --- |
| Four simultaneous 256KiB real #598 localhost parser requests; identity-small + gzip admission | **SOURCE TEST PASS** |
| Fixed seed digest reproducibility and p95/p99/CPU/RSS local metrics | **SOURCE PASS**, one sample |
| Four simultaneous full 9.5MiB requests on actual #598 parser | **BLOCKED by disk preflight** |
| Tenant provider budget and actual cross-Hub lease enforcement | **SOURCE-only model; live unknown** |
| 101+ concurrent authenticated native WSS and verified tool effects | **NOT TESTED** |
| Real Cloudflare Workers/D1/DO authenticated counters and money spent | **NOT TESTED**; null, not zero |
| Physical 1GiB file completion with independent source and destination disk hashes | **NOT TESTED** |
| 24-hour native soak | **NOT TESTED** |
| Production | **NO-GO** |

No live Agent, Broker, VM, Cloudflare, customer data, physical large files or external stress was touched.
