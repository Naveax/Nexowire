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
