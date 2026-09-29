# Nexowire

**AI-native remote computer control for ChatGPT.**

Nexowire is a provider-independent control layer that gives ChatGPT a structured, resumable way to work with remote computers, terminals, files, processes, GUIs, and project workspaces.

> Status: early development. The protocol, security model, and provider APIs are still evolving.

## Goals

- One tool surface across Windows, PowerShell, WSL2, Linux, GUI automation, files, processes, services, networking, and project workspaces.
- Provider adapters for Remote Desktop Commander, SentinelX, native agents, and future transports.
- Persistent workspaces and resumable task state instead of stateless command-by-command control.
- Capability-based routing and safe provider failover.
- Fast AI use through batched operations, compact snapshots, dynamic tool exposure, and structured output.
- Reusable skills for coding, diagnostics, administration, deployment, and recovery.
- Auditability, cancellation, verification, and explicit handling of destructive operations.

## Architecture

```text
ChatGPT
   |
   v
Nexowire MCP
   |
   v
Nexowire Hub
   |-- Core / task engine
   |-- Capability router
   |-- Workspace state
   |-- Skills
   |-- Shell runtime
   |-- GUI control
   |
   +-- Native Agent
   +-- Remote Desktop Commander adapter
   +-- SentinelX adapter
   +-- PowerShell / WSL2
   +-- Future providers
```

The key rule is that providers are transport/execution backends, not the product surface. ChatGPT should see one stable Nexowire capability model regardless of how a target machine is reached.

## Planned capability groups

```text
filesystem   search       shell        process
git          windows      wsl          network
services     registry     tasks        gui
browser      workspace    devices      providers
```

## Repository direction

The first milestone establishes:

1. shared protocol types,
2. provider abstraction and capability registry,
3. normalized execution results,
4. workspace snapshots and resumable task checkpoints,
5. an MCP server for ChatGPT,
6. a local development provider,
7. tests for routing, concurrency, validation, and failure handling.

See `ROADMAP.md` and `HANDOFF.md` as the implementation grows.

## Security

Nexowire is intended to control real computers. Security is therefore part of the architecture rather than a later toggle. The project will use scoped capabilities, explicit target selection, audit events, credential isolation, safe defaults, and verification around destructive or privileged actions.

Do not expose a development instance directly to the public Internet.

## Development

```bash
npm install
npm run check
npm run build
```

Run the hub with `npm run dev:http` and the native agent with `npm run dev:agent`. The default MCP endpoint is `http://127.0.0.1:43110/mcp`; the default agent WebSocket endpoint is `ws://127.0.0.1:43110/agent`.

The current bootstrap already supports shell execution, WSL2 execution, allowlisted file access, machine/workspace snapshots, interactive process sessions, batched reads, SHA-256 conflict-safe patching, bounded text search, operation audit metadata, workspace detection/checks, dependency-aware parallel task graphs, a bounded event feed, structured DNS/TCP/HTTP diagnostics, compact machine health, workspace checkpoints, lazy skills, and provider routing. See `ROADMAP.md` for what is still intentionally unfinished.
