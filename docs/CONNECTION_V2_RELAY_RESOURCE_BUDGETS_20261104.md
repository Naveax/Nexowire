# Connection v2 | Relay admission and resilience: isolated integration

**Scope:** Local-first first-party WebSocket relay only, based on main `939b4d6beecf996f2750c736c5d4b4beb7b64488`.
**Release status:** DRAFT / NO-GO; no production deployment, DNS, billing or device changes.

## What this change adds

- **Bounded concurrent relay pairs**: default 128, explicitly configurable 1–512 via `NEXOWIRE_RELAY_MAX_CONNECTIONS`. A fully authenticated request beyond the limit receives an HTTP 503 with Retry-After rather than an outbound socket allocation.
- **Bounded upstream handshakes**: default 10 seconds; configurable 250–30,000 ms via `NEXOWIRE_RELAY_UPSTREAM_HANDSHAKE_TIMEOUT_MS`. An unresponsive Hub cannot keep an upstream socket in CONNECTING indefinitely.
- **Bounded shutdown**: default 1.5 seconds; configurable 100–10,000 ms via `NEXOWIRE_RELAY_SHUTDOWN_GRACE_MS`; close is idempotent and tears down both ends. No new native Agent process or automatic mutation retry.
- **Reject unsupported routes**: unknown WebSocket paths/queries and ordinary HTTP GETs receive a bounded 404, without opening an upstream connection.
- **Backpressure improvements**: check the pending send size before forwarding and cap each pre-handshake queue at 2 MiB, regardless of max payload size.
- **Strict integer inputs**: malformed env numbers such as `12suffix` are rejected, not silently coerced.
- **Per-upstream maximum frame length**: matches the relay's configured inbound frame cap. WebSocket compression stays disabled.

## Boundaries and acceptance

These are resource admission limits, **not capacity benchmark results**. They do not establish 101+ real authenticated hosted WSS sessions, 1 GiB cross-PC transfer, 24-hour soak, provider billing limits or public ingress security.

Run `node --test --import tsx test/relay-resource-budgets.test.ts test/relay.test.ts` and exact-head Node22/Node24, Windows and Linux CI. Check WSS 101+ concurrency, p95/p99, CPU, RSS and egress in isolated staging before choosing production defaults.

The relay is a **fallback data plane**. It does not implement WebRTC/STUN/ICE/TURN or directly connect ChatGPT to a user's PC. Owner/device OAuth, revocation at mutation dispatch, external quota reservation and UNKNOWN no-replay remain independent gates. Never automatically reroute pending mutations or use a different owner's device.

## Follow-up architecture backlog

1. Public Connection v2 security fixes: P1-A/B/C/D in #1003/#1044/#1074/#1077, then exact-head adversarial GREEN.
2. Durable connection health classification (authenticated vs TCP-open) and jittered reconnect tests, preserving the current no-replay fence.
3. Streaming data-plane: adaptive chunk sizing, flow control, cancel fencing, resumable verified chunks. Keep small MCP control messages separate from large file/display payloads.
4. Optional ICE/P2P for **first-party** device-to-device streams, with measured relay fraction and hard spend cap; P2P does not eliminate hosted MCP admission.
5. Authenticated two-device reboot, 101+ hosted WSS, 1 GiB transfer and 24h provider-metered soak.

## 2026-11-04 V2-05 measured-gate expansion

### Runtime changes (relay-only)

- Clear queued pre-handshake frames immediately on either peer closing; track aggregate startup queued bytes and frame depth, including high-water marks. Backpressure failure now closes **both** peers rather than leaving a source sending at a dead destination.
- Expose `resourceSnapshot()` (active/connecting connections, queued bytes/frames, buffered socket bytes, 503 counter, downstream disconnect-code histogram). Snapshots intentionally omit identity, credentials and payloads.
- Bound pre-upgrade HTTP header and request timeouts to 10 seconds and keepalive to 1 second; partial-header probes verify no upstream pair is allocated. A full timeout/slowloris soak across network edge infrastructure remains **NOT_RUN**.
- Keep the 128 connection default; do **not** inflate this by assumption. The 2 MiB per-pair queue allows up to 256 MiB pre-handshake buffered payloads at 128 connections before protocol, kernel, TLS and V8 overhead. The default 16 MiB payload and 2× per-destination buffered check can impose further worst-case memory pressure. A hosted memory cap must be set from measured peak/soak evidence.

### Reproducible isolated authenticated WSS benchmark

Command: `node --test --import tsx test/relay-resource-budgets.test.ts test/relay.test.ts`

The dedicated matrix runs Windows/Linux × Node22/24 in an ephemeral runner. This bench generates its own one-day **loopback-only TLS key/certificate in the OS temporary directory** using OpenSSL, validates TLS, then opens actual TCP/WSS clients with a bearer token. Each accepted client performs the Agent HELLO protocol followed by a **real AgentBroker read-only request/response ACK**; merely opening a socket is **not** counted as completed. The upstream Hub remains loopback, not provider-hosted.

Sizes tested: **1, 32, 64, 101, 128, 129, 256 attempted connections**. At 129 and 256, retain 128 authenticated peers while expecting each extra attempt to receive HTTP 503. Synthetic adversarial cases also cover an unresponsive handshake, oversized incoming frames (1009), startup queue overflow (1013), ordinary HTTP/unknown upgrade paths, and partial headers.

Each passing scenario logs one `RELAY_V2_05_BENCH_JSON={...}` record with environment, checked-out commit SHA, PR HEAD SHA (when available), attempted/admitted/completed counts, handshake and Broker ACK p50/p95/p99, process CPU percentage relative to one core, sampled process peak RSS, queued frames/bytes and their peaks, 503, application-layer bytes, disconnect codes, and simple completion fairness ratio. Collect these **actual CI logs** into separate CSV/JSON; do not fabricate a benchmark result when CI is waiting or red.

**Measurement limitations:** process CPU and RSS include test client, Broker, upstream and relay in a single Node process, so these are **whole-process loopback totals**, not isolated central-relay instance cost. Application bytes count decoded Agent request/response bodies, **not TLS/TCP egress or provider billing**. `fairnessCompletedRatio` checks one completed request per admitted synthetic agent, not long-term multi-tenant fairness. Socket close codes are recorded by the relay's downstream listener.

### Not executed and release gates

| Gate | Status | Reason |
| --- | --- | --- |
| 1 GiB authenticated cross-device streaming | **NOT_RUN** | No authorized isolated two-device staging with tested bounded chunk transport |
| SHA256/file-ID resumable chunk + no-double-write under reconnect | **NOT_RUN** | Belongs to a separately versioned transfer protocol; must not spoof successful MCP mutation completion |
| Hosted 101+ public WSS + quota/billing egress measurement | **NOT_RUN** | Current fixture is encrypted loopback with synthetic agents |
| Multi-hour soak / provider p95/p99 / actual cost | **NOT_RUN** | No authorized metered staging or reliable cost baseline |
| WebRTC/STUN/ICE/TURN P2P implementation | **NOT_RUN** | Architecture backlog only |
| Real production endpoints and NAVEAX/Work-PC stress | **NOT_RUN** | Explicitly prohibited |

### Next P2P/streaming prototype backlog (unimplemented)

1. Identify bulk file, screen/video and telemetry blobs as eligible P2P candidates. Leave authenticated MCP command/control and authoritative mutation ACK/revoke in a server-controlled plane.
2. Prototype ICE/STUN peer candidate gathering with opt-in scoped consent and relay/TURN fallback, authenticated device-to-device session binding, NAT traversal metrics and deny-by-default when peer binding mismatches.
3. Define independent `transferId`, authenticated `fileId`, `chunkIndex`, `byteOffset`, `length`, per-chunk SHA256, whole-file SHA256, capped in-flight byte window and resume bitmap. Commit to destination only after atomic verified finalization.
4. Cancellation must close transport, remove partial files without changing authoritative mutation result, and never blindly reissue an unknown mutation. All retries are idempotent by transferId/chunkIndex/fileId and server-side acknowledged offset.
5. Test lost ACK, duplicate chunk, reordered chunk, symlink swap, file-ID mutation, disk full, hash mismatch, mid-transfer revoke, fair scheduling among 101 clients, and bounded RSS on local ephemeral fixtures before any hosted rollout.
6. Compare measured direct/P2P bytes with relay/provider bytes and collect actual price/egress evidence; set a hard user-visible spend cap.

**Release recommendation:** **NO-GO** until exact-checkout CI, actual benchmark logs, hosted soak, streaming protocol integration and separate #1003/#1044 security gates are green. Synthetic loopback throughput is not a zero-cost or unlimited-capacity claim.

## Round 2: global memory reservation / pending handshakes (2026-11-04)

**Source:** existing #1081 Draft, no new PR or production deployment. **Default global accounting budget: 32 MiB** (`NEXOWIRE_RELAY_GLOBAL_MEMORY_BUDGET_BYTES`, valid 256 KiB–512 MiB). Every accepted/upgrading pair reserves 64 KiB until **both** downstream and upstream sockets close. A default 128 connections reserve **8 MiB**, leaving **24 MiB** shared by all startup queues and uncompleted WebSocket send callbacks. The old theoretical `128 × 2 MiB = 256 MiB` startup queue now cannot be fully reserved; global queue plus inflight plus connection reservations must remain ≤ 32 MiB. This is an **accounting cap, not an absolute process RSS cap**: inbound WebSocket parsing, TLS, Node runtime, kernel send buffers and other allocations are not completely covered.

The optional `NEXOWIRE_RELAY_MAX_PENDING_HANDSHAKES` (1–512; defaults to max connections) separately caps outstanding upstream handshakes. Admission checks include already reserved pair slots, pending upgrades, pending handshakes and global budget **before** outbound socket allocation. An authenticated over-capacity upgrade receives HTTP 503 and `Retry-After: 1`. Existing peers that cannot acquire queue/inflight bytes fail closed with code 1013. Startup queues still cap at 2 MiB or 64 frames per pair. Inflight bytes are reserved before `send`; per-send callback or pair disposal releases exactly once. Pair slots are released only after both endpoints' close events.

`resourceSnapshot()` now contains the redacted global current/high-water reservation, per-kind byte buckets, connection/pending counters, global reject count and per-pair queued/inflight high-water. The reservation invariant is:
`totalReservedBytes === connectionReservedBytes + startupQueuedBytes + inflightReservedBytes`.
After controlled close and cleanup all current counters must become zero. A stalled upstream and a healthy second peer are exercised together to prove the slow peer cannot steal all reserved bytes or starve the healthy ACK.

**Benchmark methodology:** GitHub Windows/Linux Node22/24 ephemeral loopback TLS/WSS with authenticated Broker requests in `test/relay-resource-budgets.test.ts`. New records include `globalMemoryBudgetBytes`, `reservedBytes`, `peakReservedBytes`, `connectionReservedBytes`, `inflightReservedBytes`, pending handshake/admission counts, budget rejects and per-connection byte high-water. Each CI job must be mapped to exact run ID, job ID, PR HEAD SHA, checkout SHA, invocation command and exit status before claiming PASS. Metrics are whole Node fixture-process RSS/CPU, not isolated hosted relay cost.

**1 GiB transfer contract only (NOT_RUN):** Before implementing, version a standalone transfer session with owner/device-bound `transferId`, stable authenticated `fileId`, bounded chunk size and in-flight window, `chunkIndex`, offset/length, SHA256 per chunk and final file, explicit cancel ACK and persistent durable resume bitmap. Reject overlapping/conflicting chunks; stage into uniquely named protected temporary storage, require fsync/atomic verified finalization, verify file-ID and revocation at commit, and never replay unknown mutations. No transfer implementation is claimed.

**P2P backlog (NOT_RUN):** evaluate WebRTC/ICE/STUN plus TURN fallback for bulk file, desktop pixels and telemetry streams with consent and device binding; use measured egress and quota spending guards. Authenticated MCP control, owner authorization, revocation and mutation ACK stay authoritative and are **not** replaced by P2P.

**Public hosted Cloudflare 101+ WSS:** NOT_RUN. **Cross-device 1 GiB verified stream:** NOT_RUN. **24-hour soak and actual provider egress/billing:** NOT_RUN. **Production GO:** NO-GO until external security gates, hosted capacity and transfer correctness validation.
