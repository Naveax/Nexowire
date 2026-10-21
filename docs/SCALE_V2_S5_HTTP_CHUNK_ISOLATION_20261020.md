# Nexowire S5 #15 | Bounded HTTP parser/Small-MCP fairness and 64 KiB stream receipt audit

**2026-10-20, SOURCE ONLY / STAGING BLOCKED / PRODUCTION NO-GO.** Scope: #487, parent #482; HTTP 9.5 MiB #598 (owner outside S5); resumable chunks #596 (Artifact Bridge #08) / QA #597 / issue #588 (Agent File API #05). Previous S5 PRs #583 and #592 have merged. This PR touches **only S5 test, report, and independent load metrics files**.

## Truthful starting evidence

- #583 and #592 source CI succeeded, but the October 18 local **360 cumulative reconnects had peak only 21 concurrent plain local WS sockets**, not 101+ simultaneously authenticated **native WSS**.
- S5 real native tool completion receipts: **not accepted**, still 0 verified in S5. A separate #596 owner reports a physical 221 KiB and 1 MiB *two-PC* file transfer, but that is not a verified S5 100+ WSS native throughput or 24-hour soak acceptance.
- Independent authorized isolated public WSS environment, enrolled customers and device sessions, provider-wide 600/minute upstream usage metrics, Cloudflare Workers/D1/DO account-specific billing readings **not found**. No external WebSocket/HTTP traffic or production cloud resources were used.
- Production exact artifacts in #596/#598 are still DRAFT. The only deployed Agent version observed in the earlier read-only inventory was 1.0.5; source from DRAFT PRs cannot be labeled deployed.
- Work PC at preflight: 12 logical cores, CPU approximately 55%, RAM 68%, disk 96% full. During work CPU 77%, disk 97.2%; therefore **the 4 × 9.5 MiB optional full-body benchmark was not started**. Never make a 1 GiB temp file on this disk.

## New bounded real-local fixture, not production parser

`scripts/bench-s5-http-mcp-isolation.ts` creates an ephemeral `127.0.0.1` **HTTP** server with `/mcp/large` and `/mcp/small`. The latter sends a tiny synthetic JSON reply, **not a genuine MCP session**. The fixture computes an incremental SHA256 digest while receiving actual HTTP request body bytes, imposes a synthetic **9,961,472-byte** (9.5 MiB) limit and accepts at most **four** simultaneous large operations. Excess length gets 413, fifth active large gets 429. The producer sends **64 KiB chunks**, waits for socket drain and monitors process RSS.

- Code cannot dial an external hostname and does not import or modify `src/mcp/http.ts` or `http-app.ts` (#598 owner's code).
- Per run: 1–4 large requests, 1–32 small, each large body up to 9.5 MiB, 0–3 ms per-chunk scheduled pause, ≤60-second deadline, RSS-growth budget 32–256 MiB.
- Records peak overlapping large handlers, small requests **received while large handlers active**, accepted/rejected status counts, incremental bytes/digests, HTTP stream backpressure, p50/p95/p99 for large/small responses and memory growth.
- Tests actually ran **4 concurrent 1 MiB real local HTTP payloads**, 16 tiny synthetic MCP requests, a denied fifth large request and a 413 **over-length Content-Length declaration** (this 413 probe does not transmit 9.5 MiB+1). Exact test pass and p95/p99 metrics come from CI's `S5_LOCAL_HTTP_MEASURED` output, **not hosted production measurement**.
- The opt-in report runner has **two** explicit modes: `--ack-4mib-loopback` (4 × 1 MiB for a small, source-pinned report), and `--ack-38mib-loopback` (4 × 9.5 MiB = 38 MiB, **NOT EXECUTED** because Work PC storage is >96% full and its CPU was at 77%). Both modes are loopback-only, cap RSS growth to 128 MiB, use a 45s deadline and require at least 3 GiB free RAM. Neither mode is included in GitHub CI. The 4 MiB mode's result is saved separately as `docs/reports/s5-http-4mib-loopback-20261020.json`; it remains a synthetic MCP *fixture*, not a true Hub parser measurement.
- This cannot by itself prove that actual Hub #598 parser shares fair ingress with MCP small requests or handles a 9.5 MiB JSON request safely. After #598 source and operator-approved **isolated** staging endpoint are available, an independently reviewed test adapter should target that real endpoint using first-party auth, small MCP and bounded saturation with a strict explicit canary budget. **Never use customer traffic.**

## Actual measured bounded local HTTP sample (code-pinned)

Source commit **`e975c77effc3e3d5d07b442a1cb59dbbe69f928a`**; immutable JSON: [S5 4-MiB local HTTP sample](reports/s5-http-4mib-loopback-20261020.json).

| Field | One Work PC measurement |
| --- | ---: |
| Concurrent large HTTP handlers, each 1 MiB | 4 |
| Real loopback bytes received | 4,194,304 |
| Small synthetic MCP route successes during large transfers | 20 / 20 |
| Small response p50 / p95 / p99 | 26.401 / 27.187 / 27.491 ms |
| Large response p50 / p95 / p99 | 82.334 / 87.340 / 87.340 ms |
| Socket backpressure write events | 64 |
| Fifth large rejected / over-length Content-Length rejected | 429 × 1 / 413 × 1 |
| Peak process RSS growth | 8,462,336 bytes |
| Authenticated public WSS / independently verified native completions | 0 / 0 |
| Actual Cloudflare Worker/D1/DO meter and bill | **Not measured** |

All four receiver SHA-256 digests were equal to the corresponding sender digests, but requests intentionally used identical test content. This is a single **synthetic MCP fixture** run with genuine local HTTP byte transport, not a meaningful production p99 SLO. It does not demonstrate four real 9.5 MiB parsers being exercised at once.

## #596 64 KiB transfer metadata audit

`src/ops/scale-s5-chunk-receipt-audit.ts` is an independent rolling **metadata-only** QA adapter. It checks owner/account, transfer, source and destination device, epoch, monotonic exact offset, 1–65,536-byte chunks, declared sender/receiver chunk digest equality, duplicate-last idempotency, oversized/out-of-order/cross-scope rejection and bounded p95/p99 sample-memory. It never modifies the #08 Artifact Bridge store, #05 Agent executor or #06 Connection Core.

The tests verify four 64 KiB-or-smaller receipts totaling **221 KiB** and **16,384 synthetic receipts** representing **1 GiB**. The latter demonstrates 64-bit-safe (JS safe integer) chunk-index bookkeeping, not a 1 GiB file transfer. Source/target SHA digests are **self-provided metadata**, not independently computed from target disk or signed Agent receipts; even if all offset receipts are present, `independentlyVerifiedDiskHash=false`, `independentlyVerifiedNativeCompletion=false`, and `actuallyTransferredBytesByThisAudit=0`. The previously merged S5 #592 has its own **real localhost TCP** 221 KiB / 256 MiB+1 / 1 GiB byte streaming sample, which is not the Artifact Store data path.

After #596/#597 are reviewed and deployed safely, require **real** Agent/Hub/Artifact Bridge receipts with exact requestId, source/target ownership, session epoch, CAS offset, actual bytes, per-chunk SHA, full-disk SHA, cancellation/replay proof, 64-bit offsets, bounded memory and disk-free proof before physical transfer acceptance. Do not blindly replay mutating UNKNOWN transfers.

## Global and tenant fairness/latency/backpressure acceptance

Previously merged, and reusable in this PR:
- `test/s5-ingress-concurrent-rate.test.ts`: four SQLite workers, 600/min global scope. A noisy tenant can consume the full budget before a quiet tenant, illustrating non-fair first-come admission.
- `test/scale-s5-protected-admission.test.ts` and `test/s5-protected-concurrent-writers.test.ts`: strict **300/300** equal or **570/30** 95:5 synthetic per-tenant shares prevent reserved-slot stealing; no provider quota behavior asserted.
- `test/s5-loopback-reconnect-storm.test.ts`: real local plain WS sockets with replay/backpressure, **not public WSS**, real owner enrollment or native tools.
- `test/scale-s5-provider-meter-evidence.test.ts`: accepts source-labelled counter arithmetic only, Cloudflare usage and cost **not authenticated**.
- `test/scale-s5-staging-acceptance.test.ts`: self-asserted 101+ WSS and arbitrary receipt hashes cannot promote their own acceptance to PASS.

## Release gates

| Gate | Outcome at this HEAD |
| --- | --- |
| Source HTTP fixture, bounded small/large concurrency | Tested locally 4 × 1 MiB, test suite PASS |
| HTTP 4 × actual 9.5 MiB payload | **NOT_TESTED** on Work PC due host load; opt-in harness only |
| Actual #598 production MCP 9.5 MiB parser | **NOT_TESTED**; PR still DRAFT |
| Real #596 64 KiB native chunk transfer | **NOT ACCEPTED** by S5; #08 owns E2E source |
| 101+ authenticated simultaneous public WSS | **BLOCKED** |
| Verified native tool completions through authorized staging | **BLOCKED** |
| Actual Cloudflare Workers/D1/DO billing | **BLOCKED**, null rather than invented $0 |
| Uninterrupted 24-hour real native soak | **NOT_TESTED** |
| Production | **NO-GO** |

### Bounded source tests

```powershell
npm run typecheck
node --test --test-concurrency=1 --import tsx test/s5-http-mcp-isolation.test.ts test/scale-s5-chunk-receipt-audit.test.ts
node --test --test-concurrency=1 --import tsx test/s5-ingress-concurrent-rate.test.ts test/scale-s5-protected-admission.test.ts test/s5-loopback-reconnect-storm.test.ts test/scale-s5-provider-meter-evidence.test.ts test/scale-s5-staging-acceptance.test.ts
```

No connection limits, paid cloud quotas, live Agent/Hub process or platform per-message caps were modified. A **600/minute admission ceiling is not a guarantee of 850,000 successfully completed native tools/day**.
