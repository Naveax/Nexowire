# Nexowire

**AI-native remote computer control for ChatGPT.**

Nexowire is a self-hosted control plane and native-agent runtime that gives ChatGPT a structured, resumable way to work with computers, terminals, files, processes, GUIs, browsers, and project workspaces.

> Status: early development. The protocol, security model, and native transport are still evolving.

## Runtime rule

Nexowire does not depend on Remote Desktop Commander, SentinelX, Codex, or another third-party remote-control service at runtime.

Those products may be useful during development, but the shipped data path is owned by Nexowire:

```text
ChatGPT
   |
   v
Nexowire MCP / HTTPS
   |
   v
Nexowire Hub
   |
   v
Nexowire Native Agent
   |
   v
Target computer
```

If a useful capability exists elsewhere, Nexowire implements the capability in its own native layer instead of requiring that service.

## Goals

- One stable tool surface across Windows, PowerShell, WSL2, Linux, GUI automation, files, processes, services, networking, browsers, and project workspaces.
- First-party outbound native-agent transport controlled by Nexowire.
- Persistent workspaces and resumable task state instead of stateless command-by-command control.
- Capability-based routing across Nexowire-owned execution backends and devices.
- Fast AI use through batched operations, compact snapshots, dynamic tool exposure, and structured output.
- Reusable skills for coding, diagnostics, administration, deployment, and recovery.
- Auditability, cancellation, verification, and explicit handling of destructive operations.
- No runtime quota or feature dependency on third-party computer-control providers.

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
   |-- GUI / browser control
   |
   +-- Nexowire Native Agent
        |-- Windows / PowerShell
        |-- WSL2
        |-- Linux
        |-- Files / processes / services
        |-- UIA / screenshots / keyboard / pointer
        +-- Browser automation
```

The provider abstraction remains an internal routing boundary. Runtime registration is first-party: the default runtime registers only the Nexowire native-agent backend. Future backends must be Nexowire-owned transports or explicitly added by the operator.

## Planned capability groups

```text
filesystem   search       shell        process
git          windows      wsl          network
services     registry     tasks        gui
browser      workspace    devices      runtime
```

## Repository direction

The first milestones establish shared protocol types, a native execution backend, normalized execution results, workspace snapshots and resumable tasks, the ChatGPT-facing MCP server, multi-device routing, and tests for concurrency, validation, failure handling, and mutation safety.

See `ROADMAP.md` and `HANDOFF.md` as the implementation grows.

## Security

Nexowire is intended to control real computers. Security is therefore part of the architecture rather than a later toggle. The project uses scoped capabilities, explicit target selection, audit events, credential isolation, safe defaults, and verification around destructive or privileged actions.

Do not expose a development instance directly to the public Internet.

For bootstrap remote deployments, MCP and native-agent bearer credentials support comma-separated rotation sets through `NEXOWIRE_MCP_BEARER_TOKENS` and `NEXOWIRE_AGENT_TOKENS`; singular token variables remain compatible. Matching uses constant-time digest comparison. Non-loopback exposure additionally requires direct TLS (`NEXOWIRE_TLS_CERT_FILE` + `NEXOWIRE_TLS_KEY_FILE`) unless the operator explicitly enables the trusted-private-network plaintext override. This is still bootstrap auth, not the final production authorization/revocation layer.

## Development

```bash
npm install
npm run check
npm run build
```

Run the hub with `npm run dev:http` and the native agent with `npm run dev:agent`. The default loopback MCP endpoint is `http://127.0.0.1:43110/mcp`; the default agent WebSocket endpoint is `ws://127.0.0.1:43110/agent`. With direct TLS configured, the same listener serves `https://.../mcp` and `wss://.../agent`.

The current bootstrap already supports shell execution, WSL2 execution, allowlisted file access, machine/workspace snapshots, interactive process sessions, batched reads, SHA-256 conflict-safe patching, bounded text search, operation audit metadata plus bounded persistent audit history queries, explicit payload-free idempotency records for selected replay-safe mutations, workspace detection/checks, dependency-aware parallel task graphs with exact-spec task-graph resume, a bounded event feed, structured DNS/TCP/HTTP diagnostics, compact machine health, exact Windows environment controls, exact HWND window control, inline Windows screenshots, exact-foreground keyboard input and bounded clipboard control, Windows UI Automation tree/actions, exact-HWND pointer fallback, first-party Edge/Chrome CDP automation, workspace checkpoints, persistent device aliases/history with capability-aware route discovery, lazy skills, and native capability routing. See `ROADMAP.md` for what is still intentionally unfinished.
