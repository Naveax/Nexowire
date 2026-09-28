# Nexowire Handoff

Updated: 2026-09-28

## Goal

Build a ChatGPT plugin/MCP-style computer-control system broader than Remote Desktop Commander or SentinelX alone. Codex is not a runtime dependency. Nexowire provides the tools, workspace state, skills, routing, and native agent.

## Repository state

Active bootstrap branch: `feat/bootstrap-core`

Implemented:
- TypeScript project and strict type checking
- normalized provider interfaces
- deterministic provider registry with failover after provider exceptions
- native agent protocol over outbound WebSocket
- stable native-agent device identity
- shell execution for pwsh / Windows PowerShell / cmd / bash / sh
- WSL2 execution capability
- allowlisted file read/write/list
- machine snapshot and Git workspace snapshot
- Streamable HTTP MCP and stdio MCP
- persistent workspace checkpoints
- lazy skill registry
- initial security/docs/tests/CI

## Current security behavior

Hub default: `127.0.0.1:43110`. Non-loopback binding is refused unless both `NEXOWIRE_MCP_BEARER_TOKEN` and `NEXOWIRE_AGENT_TOKEN` are configured.

Native-agent file tools default to the current user's home directory. `NEXOWIRE_ALLOWED_ROOTS=*` intentionally grants unrestricted user-level filesystem paths.

## Immediate next work

1. Run and fix the full typecheck/test/build suite on Windows.
2. Add an end-to-end hub + native-agent integration test.
3. Add durable process sessions: start, output pagination, input, cancel, status.
4. Add structured audit events and operation IDs.
5. Add batch reads/search to reduce AI round trips.
6. Add structured Windows process/service/network capabilities.
7. Design production ChatGPT authentication before public deployment.

## Known machine note

The current development PC has WSL2 support enabled, but at the last check no Linux distribution was installed. `wsl.exec` is implemented but a real distro integration test still requires an installed distro.

## Architecture rule

Do not embed Nexowire inside the DesktopCommanderMCP fork. Remote Desktop Commander and SentinelX are providers/adapters. Nexowire owns the stable AI-facing interface.
