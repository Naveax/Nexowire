# Nexowire Architecture

Nexowire is an AI-facing control plane with a first-party remote execution runtime.

## Data path

```text
ChatGPT
  -> MCP / HTTPS
Nexowire Hub
  -> capability router
  -> Nexowire native-agent backend
  -> outbound Nexowire agent transport
Target computer
```

For a new reader: ChatGPT calls an MCP **tool** on the Hub; the Hub chooses an
authorized online target and routes an operation to a native Agent connected
from the target computer. A tool being discoverable does **not** mean it is
authorized, available on every machine, or already executed. The local `stdio`
development entry point is separate from the HTTP entry point. Neither is a
substitute for proving an end-to-end authenticated deployment.

| Boundary | Implemented source | What it establishes |
| --- | --- | --- |
| MCP tool registration and filtered discovery | [`src/mcp/create-server.ts`](../src/mcp/create-server.ts) | Tool schema/handlers; authorization and advertised-capability filtering |
| HTTP MCP endpoint | [`src/mcp/http.ts`](../src/mcp/http.ts) | Streamable HTTP server integration |
| Local development MCP | [`src/mcp/stdio.ts`](../src/mcp/stdio.ts) | stdio transport |
| Hub-to-Agent WebSocket | [`src/hub/agent-websocket.ts`](../src/hub/agent-websocket.ts) | Server-side socket connection |
| Native Agent outbound connection | [`src/agent/native-agent.ts`](../src/agent/native-agent.ts) | Agent-side connection and execution wiring |
| Tool name and read-only classification | [MCP surface contract](MCP_SURFACE.md#tool-names-read-only-capabilities-and-permissions) | V1 tool name vs. capability vs. read-only distinction |

This is a source map, not a claim that any specific browser, Windows device,
authenticated user, remote tunnel, or production service has passed a live test.

## Endpoint identity (not a public deployment address)

| Route or transport | Source | Meaning |
| --- | --- | --- |
| `POST /mcp` | [`src/mcp/http.ts`](../src/mcp/http.ts) | ChatGPT-facing Streamable HTTP MCP messages, subject to configured authentication and tool policy |
| `GET /mcp`, `DELETE /mcp` | [`src/mcp/http.ts`](../src/mcp/http.ts) | Explicitly return HTTP `405`; **not** a browser dashboard or MCP health check |
| `GET /health` | [`src/mcp/http.ts`](../src/mcp/http.ts) | Hub service health metadata; **not** proof a target computer or a mutation succeeded |
| WebSocket upgrade `/agent` | [`src/hub/agent-websocket.ts`](../src/hub/agent-websocket.ts) | Native Agent transport; **not** the ChatGPT MCP URL |
| stdio | [`src/mcp/stdio.ts`](../src/mcp/stdio.ts) | Local development transport, not an HTTP endpoint |

The configured host, TLS certificate, authentication, routing and external
reachability determine the actual address. Do not paste a local control panel,
`/health`, or `/agent` URL into a ChatGPT MCP connector field and assume it is
equivalent to an authenticated `POST /mcp` service.

The default runtime registers only the first-party `native-agent` backend. Remote Desktop Commander, SentinelX, Codex, and other third-party computer-control services are not runtime dependencies.

The internal backend/provider interface remains as an architectural seam for Nexowire-owned transports such as direct agent connections, relays, local execution, testing backends, and future platform-specific agents.

## Current bootstrap

- stateless Streamable HTTP MCP endpoint
- stdio MCP mode for local development
- outbound native-agent WebSocket transport
- persistent device aliases resolved to stable native IDs before execution
- persistent native device directory plus capability-aware, ambiguity-safe route discovery across multiple connected machines
- internal backend registry with health/latency ranking, read-only failover semantics, and mutation replay protection
- PowerShell/cmd/bash shell execution
- structured Windows process, service, network, registry, scheduled-task, event-log, and firewall inspection plus verified mutations where implemented
- exact Windows process/user/machine environment discovery, selective reads, and verified mutations
- structured Windows top-level window enumeration and exact HWND foreground focus with verification
- bounded inline PNG capture for virtual desktop, primary screen, or exact HWND rectangle without changing focus
- structured Windows clipboard access plus exact-foreground Unicode typing/hotkeys with foreground verification
- bounded Windows UI Automation tree/search plus exact unique-selector InvokePattern and verified ValuePattern mutations
- exact-foreground HWND pointer position/move/click/scroll with client-bound and hit-target verification as a final GUI fallback
- first-party isolated Edge/Chrome/Chromium control through direct loopback Chrome DevTools Protocol, including navigation, DOM snapshots/actions, and bounded screenshots; executable detection is platform-aware and browser capabilities are omitted from agent hello when no supported local browser is available
- interactive process sessions with incremental output, stdin, stop, list, bounded long-poll reads, retained history, and persisted recovery metadata
- WSL2 command execution
- allowlisted file read/write/list plus batched reads, SHA-256 revision identities, conflict-safe exact patching, and bounded text search
- machine and Git workspace snapshots
- compact sampled machine health plus structured DNS, TCP, and HTTP diagnostics
- persistent workspace checkpoints
- structured workspace detection and bounded parallel check execution
- bounded dependency-aware parallel task graphs for heterogeneous shell jobs
- payload-free persisted task-graph checkpoints keyed by graph ID and exact specification hash; completed jobs are reusable and in-flight jobs become explicit unknown state after restart
- persisted artifact path/size/SHA-256/mtime metadata plus bounded read-only list/re-verification; artifact bytes are not copied into durable state
- bounded in-memory agent/process event feed with cursor-based long polling, topic/device filters, and cursor-expiry detection
- operation IDs and persistent payload-free audit metadata
- lazy skill discovery

## Design rules

1. Core capabilities must work through Nexowire-owned runtime components.
2. External computer-control products are never required for normal operation.
3. Structured APIs beat GUI automation; GUI automation beats raw coordinate control.
4. Unknown-state mutations require verification before replay.
5. Long-lived project context belongs in workspace checkpoints, not assumptions.
6. Tool output is bounded.
7. The native agent initiates outbound connectivity so target PCs do not need inbound public ports.
8. Generic backend abstractions may exist internally, but first-party capability ownership is the default.

## State and error vocabulary

- **Read-only classification:** an Agent capability listed as read-only in
  `READ_ONLY_CAPABILITIES`, not a grant of tool or device access.
- **Mutation:** an action that may change Hub, Agent, machine, or application
  state. A disconnected transport does not prove the action failed to run.
- **UNKNOWN:** execution or side-effect status cannot be proven from available
  evidence. It must not be automatically treated as success, failure, or safe
  permission to repeat a mutation.
- **NOT_RUN:** a test or physical scenario was not executed; never a PASS.
- **Hub-local:** a tool whose handler can operate on Hub state without mapping
  to a remote Agent capability. Hub-local does not necessarily mean read-only.

For compatibility and tool name details, see
[`MCP_SURFACE.md`](MCP_SURFACE.md). For the versioned structured error
classification, see
[`src/protocol/error-contract-v2.ts`](../src/protocol/error-contract-v2.ts).

## Next architectural layers

- first-party browser automation and visual action verification
- higher-level resumable workflow orchestration above durable process sessions, task graphs, and artifact verification
- robust multi-device native routing and stable aliases
- optional Nexowire relay/direct transport selection
- first-party privilege-separated broker/service
- production ChatGPT authentication, TLS, and encrypted credential storage
