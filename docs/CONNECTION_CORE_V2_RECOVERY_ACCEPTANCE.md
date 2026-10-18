# Connection Core v2: Reconnect and acceptance evidence

**Scope:** S1 #483 under #482.
**Branch:** fix/parallel-06-connection-recovery-20261018.
**Base main:** 8bf7ce10972e78268e3cac945e833781b8d6846c.
**Rollout:** NONE. Draft implementation, not a production cutover.

## Source-derived connection map

1. ChatGPT/MCP -> hosted HTTP(S) /mcp ingress -> Hub. Cloudflare Worker (cloudflare/worker.js) owns separate control-plane functions and authorization. The ChatGPT MCP path is not claimed to support P2P.
2. Hub -> authenticated WebSocket /agent endpoint (src/hub/agent-websocket.ts) -> exact device route (src/core/agent-broker.ts) -> outbound Native Agent (src/agent/native-agent.ts). Requests correlate by requestId and authenticated device ID. The current path is a Hub-relayed WebSocket, not peer transport.
3. Agent NEXOWIRE_HUB_WS_URL and NEXOWIRE_HUB_WS_URLS rotate using bounded jitter, per-process instanceId and persistent device identity. Hub and Agent both send ping/pong, with termination of stale sockets.
4. Tailscale discovery/exposure (src/agent/tailscale-discovery.ts, src/tailscale-exposure.ts) optionally advertises encrypted owner-managed endpoints. This PR does not modify an existing tailnet.
5. First-party relay (src/relay/server.ts) is separate from P2P. This branch does not enable direct transfer, NAT/STUN/TURN, Cloudflare billing, new endpoints or any privileged restart.

## Reconnect invariants

- Hub-local epoch increments on each registered socket for the same exact device ID. An Agent instanceId identifies a process, not a unique WebSocket; old sockets lose all ACK/event authority immediately after replacement.
- Read-only capabilities may replay using the original requestId and overall request deadline, with a hard maximum of two reconnect replays by default (configurable 0..5). Missing capability and exhausted budgets fail closed; no cross-device fallback.
- Mutations are NEVER sent again after a socket replacement, including same-instance reconnect. Same-instance failure gives MUTATION_STATE_UNKNOWN; changed instance gives AGENT_INSTANCE_CHANGED; ACK or reconnect timeout gives MUTATION_STATE_UNKNOWN. These outcomes must be reconciled by operation ID with the existing durable Agent journal rather than assumed failed or repeated.
- Unexpected fresh authorization failure remains an HTTP 401, mismatched device identity remains WS 1008. Revocation enforcement on already-open WSS is separate S2 work; this branch does not claim it has been solved.
- This patch does not spawn duplicate Agents, restart user processes, make physical network changes or override OAuth/ownership policy.

## Redacted observability

AgentBroker.getConnectionHealth(exactDeviceId) returns hub-local connection epoch, online, transport=websocket, reconnectCount, pingCount, pongCount, lastAgentAckAt, lastSuccessfulAgentAckAt, lastAgentAckOk, connection/disconnection times and enumerated disconnect reason. AgentProvider target metadata carries that snapshot. ScaleTransportMetrics adds payload-free counters for reconnect, heartbeat ping/pong and acknowledged responses. All are memory-only and reset on Hub restart.

The telemetry intentionally excludes bearer secrets, URLs, IPs, command text, request payload, output, file content and all raw OAuth credentials. It cannot establish end-to-end P2P or encryption from the transport field alone.

## Simulated fault matrix

| Fault | Expected result | Test |
| --- | --- | --- |
| Simultaneous Naveax/Work PC synthetic device IDs | Cross-device ACK cannot resolve another target | connection-recovery-faults |
| Delayed ACK / mutation timeout | Unknown, late response ignored | connection-recovery-faults |
| Same instance two WebSockets | Mutation not replayed, epoch increments | connection-recovery-faults |
| New process instance while mutation pending | AGENT_INSTANCE_CHANGED, no replay | native-session-continuity |
| Read-only process restart | Same requestId, response accepted | native-session-continuity |
| Too many read-only reconnects | AGENT_RETRY_LIMIT | connection-recovery-faults |
| Offline after dispatch | MUTATION_STATE_UNKNOWN after grace | connection-recovery-faults |
| Heartbeat, ACK and data redaction | Counters/last ACK, no payload leak | connection-recovery-faults |
| Fresh revoked token or wrong device identity | Unauthorized connection rejected | agent-broker.e2e |

## Acceptance gates still open

- Tests use isolated localhost WebSocket endpoints, fake device IDs and no physical cable/Wi-Fi interruption. Separate harmless live read-only checks may confirm current connection availability but are NOT a proof of repeated real failure/recovery.
- Full live two-PC sustained reconnect, deployed Hub build provenance, active-session owner revocation, authenticated ingress resilience, quotas and relay cost ceilings remain unaccepted. S2/07/13 owns Public WSS and OAuth.
- Typecheck, unit tests and GitHub CI must all be traced to the PR HEAD. Green CI does not prove live deployment. No production rollout, new paid infrastructure, privilege changes, firewall edits, DNS edits or Tailscale modifications are authorized by this draft.
