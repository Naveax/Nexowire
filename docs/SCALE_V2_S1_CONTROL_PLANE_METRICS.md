# Scale v2 / S1: opt-in HTTP ingress and D1 query-shape counters

> **Implementation on DEV only, NOT deployed.** Parent: [#483](https://github.com/Naveax/Nexowire/issues/483). Master: [#482](https://github.com/Naveax/Nexowire/issues/482). Complements S1 transport metrics [PR #489](https://github.com/Naveax/Nexowire/pull/489). Do not infer P2P efficiency, actual hosting charges or S1 acceptance from these local fixtures.

## Purpose

The hosted Nexowire cost envelope has at least three independent quantities: (1) real HTTP/MCP/authorization ingress requests, (2) D1 calls and rows read/written, and (3) WebSocket/relay bytes. Transport frame metrics alone cannot tell whether the central Cloudflare request budget is adequate. This slice adds DEV-injected HTTP and D1 operation counters without enabling telemetry on production requests.

## New isolated API

`new ScaleControlPlaneMetrics()` stores only a fixed set of numeric counters in memory and five latency buckets (≤5, ≤20, ≤100, ≤500, >500 ms). Counter names are fixed and never include SQL, request methods, credentials, account IDs, device IDs, URLs, paths, tool names or bodies.

- `createControlPlaneHttpHandler(service,{authenticate,scaleMetrics:metrics})`: optional wrapper counts requests, success responses, 4xx, 5xx and thrown handler failures. Existing constructor omitting `scaleMetrics` follows the same original handler path.
- `instrumentD1Database(database,metrics)`: optional `D1DatabaseLike` adapter recording `prepare`, `bind`, `first`, `all`, `run`, `batch`, batch input statement count and failures. It passes through actual bound statements when batching and rethrows the original database error. No SQL string or binding values are captured.
- Both return detached aggregate snapshots. Collection has no export URL, persistent storage or cloud outcall. Measurement exceptions are isolated from the authenticated request and query path.

## Interpreting observed numbers

**D1 API call counts are not the provider's billable D1 row reads, row writes, CPU duration or monetary charges.** A single `first()` or `run()` can scan, read or write many rows; a D1 `batch()` may include multiple statements. Transport bytes separately omit TLS, WebSocket framing and TCP overhead. The HTTP wrapper counts only the handler to which it is explicitly attached, not the complete worker's OAuth/static/health route traffic, and not the hosted ChatGPT MCP ingress until instrumented in that specific server.

**No production Cloudflare metrics were gathered.** This commit does not add production deployment flags or instantiate these test metrics in `cloudflare/worker.js`. To estimate real capacity, first validate a privacy-reviewed opt-in staging-only aggregation/export contract at the real Worker/MCP ingress and compare against sanitized Cloudflare request + D1 row metering. Do not expose raw dynamic route labels, headers, SQL or identities.

## Proof / checks

```sh
npm run typecheck
npm run build
node --test --import tsx test/scale-control-plane-metrics.test.ts test/control-plane-http.test.ts test/quota-subject-d1.test.ts
npm run ai-screen:launch-audit
```

The dedicated test uses a real local SQLite database implementing the D1 adapter for a real Free quota charge, plus handler responses and failed SQL/mock batches. No production devices are connected or restarted. Existing quotas and billing remain intact.

## Next work to complete S1

- [ ] Add a resource-safe, authenticated staging-only, non-identifying metrics export with fixed cardinality and retention.
- [ ] Count **all** hosted Worker ingress classes and actual hosted MCP tool invocations without extra Worker requests per tool call.
- [ ] Cross-check D1 statement counts against provider-supplied rows read/written and billed execution time.
- [ ] Connect aggregate heartbeat/reconnect and relay bytes to the same test session, without preserving tenant/user labels.
- [ ] Measure p50/p95 and failure class for controlled load and network/NAT scenarios, verify two pre-existing agent connections remain unaffected.
- [ ] Prove capped free-tier denial, fallback, and no owner-paid infrastructure overage before any rollout.
