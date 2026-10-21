# S5 21 October: 4×9.5 MiB bounded HTTP and protected tenant/lease review

**DRAFT source-only. PRODUCTION NO-GO.**

## Source and CI provenance

- Parent S5 #615 exact head: a1c65587730a1eaf331337b9b3422aa93541ee30. Its GitHub Actions run 39598738701 is 7/7 SUCCESS. This result is for the PARENT exact SHA only, not this child PR.
- Main reviewed: 4c5c810134c020cd04a5ef2be5c1138ea1954ad0. Main GitHub Actions run 39596766086 SUCCESS.
- Actual 4×9.5MiB local fixture was executed at source SHA **a1c65587730a1eaf331337b9b3422aa93541ee30**. The source-pinned file is [s5-http-9-5mib-loopback-20261021.json](reports/s5-http-9-5mib-loopback-20261021.json). Later test/documentation commits do not retroactively change this measurement source.
- This child branch touches only S5 test and report paths, not #598 parser, #596 artifact worker, #576 Windows Job, Cloudflare, quotas or installed Agent/Broker.
- Work PC targeted suite: **28/28 PASS**, npm run typecheck PASS. The new lease/tenant/64KiB integration tests also passed as part of **9/9** focused tests. New child exact-head GitHub CI must be verified independently.

## Actually executed: 4×9.5MiB on 127.0.0.1

Explicit opt-in command: node --import tsx scripts/report-s5-http-mcp-isolation.ts --ack-38mib-loopback

This uses a **synthetic** small-MCP HTTP POST route and a bounded SHA-256 sink, not the actual #598 MCP Express parser. The sender emits 64KiB chunks with TCP drain backpressure and at most four concurrently outstanding large POSTs. Only localhost is addressable.

| Measured field | One Work PC local run |
| --- | ---: |
| Large overlapping POSTs | 4 × 9,961,472 B |
| Total real localhost request-body bytes received | **39,845,888 B (38 MiB)** |
| Local large sender/receiver SHA256 equal; completions | 4/4 |
| Small identity-encoded POST responses while large bodies active | 20/20 |
| Small p50 / p95 / p99 | **39.357 / 40.277 / 40.350 ms** |
| Large p50 / p95 / p99 | **1550.924 / 1554.910 / 1554.910 ms** |
| Socket backpressure writes | 608 |
| Fifth large / gzip-compressed tiny POST busy status | **503 / 503** |
| Oversized Content-Length declaration | 413, no oversized body transmitted |
| Peak RSS process growth | **30,478,336 bytes**, ~29.07 MiB |
| Authenticated external WSS / real native effects | **0 / 0** |
| Actual Cloudflare Worker/D1/DO meter and bill | Unknown / not measured |

**p95/p99 provenance:** per-request performance.now() from local client request creation to completed HTTP response. Empirical nearest-rank percentile = sorted position ceil(p * N)-1; N=20 small, N=4 large (hence large p95 and p99 are the same slowest sample). This one localhost run does NOT supply a hosted performance SLO or confidence interval. Actual production parser/decompression and TLS/WSS were not exercised. The real gzip wire probe is denied by the **synthetic** admission gate without decompression. At preflight Work PC disk had roughly 5.44GB free and RAM 5.48GB free. No large disk fixture was written. Memory RSS stop 128MiB; 45s per-run deadline; four-large cap.

## #598 and #608 exact-source comparison

- #598 DRAFT head **cf58e6882e44968698f3f548b353287ba1698747**: original exact-head CI run **39502304557** was red in shared Windows Job fast-exit/browser-live code; do not label the parent as 7/7 success or claim gzip parsing caused this CI failure.
- #608 DRAFT combined #598/#576 head **d34c0d3c85bc508be50c2e5f532aa964d8325106**: GitHub check-run query verified Node22, Node24, Linux, macOS, WSL2, security and browser-live **SUCCESS**. This is isolated source CI compatibility, **not** approved production release.
- Actual #598 parser source enforces 9.5MiB JSON body, four large/unknown parser-stage reservations and a <=100KiB Content-Length identity-only small bypass. Tiny gzip wire requests cannot bypass; when full, HTTP 503 parser busy. A 9.5MiB HTTP envelope is not a 1GiB physical file transfer.

## #596 64KiB, owner scope and lease review (read only)

#596 DRAFT exact head **335046569a38f3a1a3fc82bf851f9b7df7640fdb**.

- cross-device-transfer-job-tools.ts: logical transfer_start/status/cancel use artifactPrincipal to verify matching account for source and target; one start call schedules background work rather than embedding a large file in JSON.
- cross-device-transfer-jobs.ts: CHUNK=65_536; monotonic offset, staged target readback checks, SHA verification, cancel and explicit resume. Each worker uses a local worker.lock filename and host/PID provenance. Foreign-host or invalid lock fails closed. Dead local worker recovery is explicit. **A local filesystem lock is not independent, global atomic multi-Hub CAS proof.**
- New S5 integration test: noisy tenant reserves up to protected 300/600; a quiet tenant still reserves a logical transfer. Ten synthetic 64KiB receipts do **not** add ten logical requests, duplicate invocation does not reserve again. Wrong account, stale epoch, forged SHA and offset jump reject. These are **untrusted metadata**, not a signed native receipt. Admission.authorizesToolExecution=false; receipt auditor.independentlyVerifiedNativeCompletion=false.
- #596 physical 221KiB and 1MiB Work PC-to-Naveax transfers, isolated Hub staging at >256MiB/1GiB, and synthetic 1GiB receipt metadata are different evidence classes. None independently proves deployed 1GiB Agent→Hub→target with a final disk hash.

## Staging and release gates

| Gate | State |
| --- | --- |
| 4×9.5MiB real bytes over **local synthetic** HTTP fixture | SOURCE/LOCAL PASS |
| Local SQLite tenant-share and 64KiB metadata contract | SOURCE PASS |
| Real #598 authorized staging 4×9.5MiB parser saturation, gzip decompression p95/p99 | **NOT TESTED** |
| #596 independently authenticated, cross-Hub durable lease and 1GiB deployed transfer | **BLOCKED** |
| >100 simultaneous authenticated native public WSS + verified tool completions | **BLOCKED** |
| Real Cloudflare Workers/D1/DO metered account spending | **NOT TESTED**. Unknown does not mean $0 |
| Continuous real native 24-hour soak | **NOT TESTED** |
| **Production** | **NO-GO** |

No real customer load, paid Cloudflare, live Agent/Hub service changes, physical 1GiB file, ACL or UAC change.
