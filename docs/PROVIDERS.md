# Execution Backend Model

Nexowire keeps a small backend/provider abstraction internally, but the runtime is first-party.

A backend answers two questions: which Nexowire targets are online with which capabilities, and can it execute one normalized capability request for a target?

## Runtime invariant

The default runtime registers only `native-agent`.

Remote Desktop Commander, SentinelX, Codex, and other third-party computer-control products are not required execution backends. Nexowire implements needed capabilities in its own Hub + Native Agent stack.

## First-party backends

### Native Agent

The reference and default backend. It uses an outbound Nexowire WebSocket connection and carries shell, filesystem, process, Windows, GUI, WSL2, browser, workspace, and future hardware capabilities.

### Direct / Relay

Future Nexowire-owned transports can use the same normalized capability contracts. A direct connection, relay connection, or platform-specific native transport should remain invisible to the ChatGPT-facing tool names.

### Local / WSL / Linux workers

Where useful, Nexowire may expose first-party local or platform workers through the same internal interface. They are implementation details, not separate products or external dependencies.

## Why keep the abstraction?

The registry still provides useful engineering boundaries for multi-device routing, health checks, latency-aware selection, test doubles, direct-vs-relay selection, and safe failure handling.

It is not an invitation to route core functionality through quota-limited third-party services.

## Routing

The registry filters by target/capability, checks backend health before execution, and may rank equivalent first-party paths by latency. Retryable read-only work can fail over between equivalent Nexowire-owned paths.

Once a mutation has been sent, an ambiguous disconnect or backend exception becomes `MUTATION_STATE_UNKNOWN`; Nexowire deliberately refuses to replay it until state is verified or an explicit idempotency rule permits replay.
