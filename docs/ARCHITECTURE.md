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
- first-party isolated Edge/Chrome control through direct loopback Chrome DevTools Protocol, including navigation, DOM snapshots/actions, and bounded screenshots
- interactive process sessions with incremental output, stdin, stop, list, bounded long-poll reads, retained history, and persisted recovery metadata
- WSL2 command execution
- allowlisted file read/write/list plus batched reads, SHA-256 revision identities, conflict-safe exact patching, and bounded text search
- machine and Git workspace snapshots
- compact sampled machine health plus structured DNS, TCP, and HTTP diagnostics
- persistent workspace checkpoints
- structured workspace detection and bounded parallel check execution
- bounded dependency-aware parallel task graphs for heterogeneous shell jobs
- payload-free persisted task-graph checkpoints keyed by graph ID and exact specification hash; completed jobs are reusable and in-flight jobs become explicit unknown state after restart
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

## Next architectural layers

- first-party browser automation and visual action verification
- fully reattachable durable process I/O and artifact tracking beyond task-graph job boundaries
- robust multi-device native routing and stable aliases
- optional Nexowire relay/direct transport selection
- first-party privilege-separated broker/service
- production ChatGPT authentication, TLS, and encrypted credential storage
