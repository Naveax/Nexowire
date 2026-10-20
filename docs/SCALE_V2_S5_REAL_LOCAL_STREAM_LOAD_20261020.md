# S5/#588: bounded stream load, memory and fairness acceptance, 20 October 2026

**Owner:** Scale v2 S5 (#487/#482), coordination only with #588; #08 owns Artifact Bridge store/stream and #05 owns Agent file API. This branch only changes `scripts/bench-s5-bounded-stream-transfer.ts`, its runner, focused S5 tests and this S5 document/report.

**Production acceptance: NO-GO. Real public staging WSS 100+ concurrent, native completion receipts, Cloudflare provider usage and 24-hour native soak: BLOCKED / NOT_TESTED.**

## Reproducible physical LOCAL TCP byte-stream measurement

Source commit `7c0d69e7f8c7b625ad05f0ea20ae5b21379f8ba7`; Work PC Windows 10 Node v24, exact values in [code-pinned measured JSON](reports/s5-stream-loopback-20261020.json). Test invocation:

```powershell
# This is opt-in, local-only. It physically streams ~1.25 GiB via 127.0.0.1:
node --import tsx scripts/report-s5-bounded-stream.ts --ack-local-large-streams
```

| Scenario | Actual bytes received | End-to-end sender/receiver SHA256 | Observed MiB/s | Duration | Peak process RSS growth | Backpressure writes |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| 221 KiB | 226,304 | Identical | 4.378 | 49.294 ms | 4,022,272 bytes | 0 |
| 256 MiB + 1 byte | 268,435,457 | Identical | 117.490 | 2,178.906 ms | 73,605,120 bytes | 4,053 |
| 1 GiB | 1,073,741,824 | Identical | 184.288 | 5,556.513 ms | 88,096,768 bytes | 16,341 |

All **real bytes traveled** from a Node `net.Socket` client to an independent loopback `net.Server` receiver, with incremental SHA-256 on each endpoint and exact-length verification. The receiver is an in-memory hash sink, **not a physical file or Nexowire Artifact Store**. A reusable 64 KiB source buffer, per-socket backpressure/drain, 60s per-stream deadline, 128 MiB process RSS growth stop, and 2-transfer maximum bound work. `peakActiveTransfers=2`. There is no 1 GiB temp-file or disk write; report creation is only ~4 KiB of JSON. The source was measured against the single code commit above and was not refactored into production upload code.

**CRITICAL:** This is proof that S5's independent local TCP *benchmark fixture* handles actual 1 GiB of transferred bytes without accumulating that many bytes in user-space memory. It is **NOT** proof that Nexowire Agent 1.0.5, WSS Hub, Artifact Bridge, Cloudflare, ChatGPT attachments or customer files can currently transfer files above 256 MiB. No authentication, resume/cancel, disk quota, artifact commit, user-specific fairness or native tool-completion operation was executed. These must be tested with the real API once #08/#05 owners land and signed distribution is authorized.

### Current production/source bounds, main observed during test

- `src/agent/executors.ts` per-call `file_read` max 16 MiB and positioned offsets max 256 MiB; one tool call is intentionally bounded.
- `src/mcp/artifact-bridge-device-ingest.ts`: source file max 256 MiB; chunk read size 65,536 bytes with up to 32 chunks/ingest call.
- `src/workspace/artifact-bridge.ts`: object size max 256 MiB and 4,096 maximum 64-KiB chunks.
- A reported ~220-KB ChatGPT UI/connector attachment or MCP response limit may be **outside Nexowire backend's ability to change**. It must be diagnosed by each layer, not assumed lifted.
- #08 and #05 are sole owners for API, store, resumability, filesystem authorization and real file E2E work; this PR intentionally does not touch those files.

### Host and fairness isolation

Work PC free disk at preflight ~14.7 GB, with 93.84% used; idle CPU sample ~35%, RAM used 65.6%. Rather than create 1GiB disk fixtures or block Work PC with unbounded load, the test emitted sequential bounded buffers through real local TCP, at most two parallel streams. The **large-file transfer is not a download/persisted-storage benchmark**. 1 GiB throughput is one local sample, *not a guaranteed sustained provider rate*.

Previously merged and re-run focused admission/fairness tests confirm:
- Four SQLite workers enforce shared **600 requests/minute** scope, while first-come 600 consumes the budget and can completely deny a late second tenant.
- Isolated strict 300/300 and 95:5 weighted 570/30 protected shares prevent cross-tenant starvation **in the local SQLite proposal only**. Strict shares are not work-conserving and are not the deployed upstream OpenAI / MCP limiter.
- Transfer chunk count must not be confused with logical tool requests, native completed effects, Cloudflare Worker HTTP requests or actual customer charging; no per-chunk production billing is enabled.

## Remote staging and billing gate

Actual 100+ **simultaneously authenticated** public WSS sessions, reconnect storm, p95/p99 for completed native tools, real Agent journal receipt/owner/device binding, 600/min upstream and per-tenant isolation, and Cloudflare Worker HTTP + CPU, D1 read/write rows and DO requests/GB-seconds remain **BLOCKED** because independently authorized nonproduction staging and authenticated provider cost counters were not supplied. The prior 360 cumulative local WS opens had peak concurrent 21 and native effects 0.

The prior S5 external readiness gate `scripts/report-s5-staging-readiness.ts` remains fail-closed; this S5 benchmark does not override it. Without an actual provider account export, billed usage remains **unknown**, not zero. 850,000/day is not a guaranteed successful work capacity. No real 24-hour native soak occurred, so **production NO-GO**.

## Source-level tests and performance acceptance

```powershell
npm run typecheck
node --test --test-concurrency=1 --import tsx test/s5-bounded-stream-transfer.test.ts test/s5-ingress-concurrent-rate.test.ts test/scale-s5-protected-admission.test.ts
```

**14/14 source tests PASS** in bounded, serial test execution; `npm run typecheck` PASS. The large 1GiB performance workload is deliberately not part of the normal CI test suite and is guarded by `--ack-local-large-streams`; the JSON is a real one-run measurement with source SHA, actual bytes and sender/receiver hashes. The test code has **no non-loopback network address input**, no paid-resource action, no Agent restart/update and no storage mutation.
