# Scale v2 S1 — Opt-in transport instrumentation, iteration 1

> Implementation-only DEV branch. Not a production rollout, quota migration, paid plan activation or P2P implementation. Tracking: [#483](https://github.com/Naveax/Nexowire/issues/483), [master #482](https://github.com/Naveax/Nexowire/issues/482).

## Scope and contracts

`src/ops/scale-transport-metrics.ts` contains an **in-memory and unlabelled** recorder. Pass `new ScaleTransportMetrics()` into `new AgentBroker({metrics})` or `startRelayServer(config, {metrics})` only on an explicitly opted-in process. Normal constructors/start commands leave the recorder undefined: **no default metrics collection** and no change to installed services.

Captured aggregate counter categories:

| Key | Meaning |
| --- | --- |
| `agent.connections`, `agent.disconnections` | Broker registration and removal of the current connected instance. A replacement is a new connection; stale closing sockets are not counted as current disconnects. |
| `agent.rx_frames`, `agent.tx_frames` | Number of accepted WebSocket message events and **application-level UTF-8 payload bytes**, including protocol envelopes. Tx counts frames offered to the WebSocket send method, not confirmed peer delivery. |
| `agent.resumed_requests`, `agent.rejected_requests` | Pending reconnect decisions, counted as number of attempted resume/rejection decisions, not bytes. |
| `relay.connections` | Authorized downstream sockets connected to the first-party relay. |
| `relay.upstream_frames`, `relay.downstream_frames` | WebSocket payloads submitted to forwarding and their application-level bytes in each direction. Not TCP/TLS overhead or cloud egress billing bytes. |
| `relay.auth_denials` | Unauthorized relay WebSocket upgrades that were refused. |

The snapshot has only fixed counter names and `{ events, bytes }` numbers; **no username, IP, device ID, capability name, command content, access token, URL, frame payload or tenant identifier is stored**. Snapshots are detached copies, and counters are bounded to JavaScript safe integers. Optional recording failures are swallowed so transport work cannot be interrupted by instrumentation.

## Limitations / before cost claims

- Not deployed. This code does **not** infer Cloudflare Worker ingress requests, D1 reads/writes, TURN traffic, NAT class, active unique user count, p95 latency, or dollar cost.
- Only observes flows when the owning Hub/relay is explicitly instantiated with this metrics object. Counters are process-local and reset on restart; no persistence, telemetry export or default endpoint.
- Application payload byte counts are not network wire bytes. WebSocket framing, heartbeat pings/pongs and TLS/TCP/IP overhead are excluded.
- Counts cannot replace a server-authoritative per-user usage ledger. User subjects are deliberately absent to avoid cardinality/privacy leaks. AuthN/AuthZ and quota charge remain mandatory.
- There is no direct peer transport implementation or real network trial in this PR; `P2P` and hosted MCP ingress stay separate.

## Validation

```sh
npm run typecheck
npm run build
node --test --import tsx test/scale-transport-metrics.test.ts test/relay.test.ts test/native-session-continuity.test.ts test/agent-broker.e2e.test.ts
npm run ai-screen:launch-audit
```

Tests prove numeric contract, no payloads stored, invalid input bounds, relay authorization denial count, a real local relay bidirectional byte path, broker direct request byte path, and same-instance request recovery metrics. Windows DEV tests use only loopback fixtures; they **do not start or restart the currently connected Native Agents**.

## Next S1 work

- [ ] Separate hosted HTTP/MCP ingress and D1 atomic charging instrumentation behind an explicitly opt-in **redacted/aggregated** test flag.
- [ ] Add opt-in latency histogram and connection-attempt/error-class histogram with fixed bounded buckets; never log endpoints or secrets.
- [ ] Mock NAT/cap failure tests; decide transport adapters only after ingress and byte baseline is measured.
- [ ] Reproduce fixed-sha CI and ensure two existing live Agent v1.0.5 routes remain healthy without any live cutover.
- [ ] Document measured actual request/bandwidth/cost with conservative uncertainty; S1 issue remains open until full staging gate.
