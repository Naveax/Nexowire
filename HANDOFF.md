# Nexowire Handoff

Updated: 2026-09-28

## Goal

Build a ChatGPT plugin/MCP-style computer-control system broader than Remote Desktop Commander or SentinelX alone. Codex is not a runtime dependency. Nexowire provides the tools, workspace state, skills, routing, and native agent.

## Repository state

Active branch: `feat/windows-control`

Implemented:
- TypeScript project and strict type checking
- normalized provider interfaces
- deterministic provider registry with failover after provider exceptions
- native agent protocol over outbound WebSocket
- stable native-agent device identity
- shell execution for pwsh / Windows PowerShell / cmd / bash / sh
- WSL2 execution capability
- interactive process sessions with incremental stdout/stderr, stdin, stop, and list
- allowlisted file read/write/list
- machine snapshot and Git workspace snapshot
- Streamable HTTP MCP and stdio MCP
- persistent workspace checkpoints
- lazy skill registry
- batch file reads and bounded text search
- safe file stat/mkdir/copy/move/delete/exact-patch primitives with real-path symlink escape checks
- operation IDs plus persistent payload-free audit metadata
- full MCP -> provider -> WebSocket native-agent integration coverage
- structured Windows process/service/network inspection and service control
- structured Windows registry, scheduled-task, event-log, and firewall queries
- initial security/docs/tests/CI

## Current security behavior

Hub default: `127.0.0.1:43110`. Non-loopback binding is refused unless both `NEXOWIRE_MCP_BEARER_TOKEN` and `NEXOWIRE_AGENT_TOKEN` are configured.

Native-agent file tools default to the current user's home directory. `NEXOWIRE_ALLOWED_ROOTS=*` intentionally grants unrestricted user-level filesystem paths.

## Immediate next work

1. Keep Windows typecheck/test/build green after each capability slice.
2. Add process-session retention/recovery policy and event subscriptions.
3. Add verified Windows registry/task/firewall mutation controls and richer event subscriptions.
4. Expand file metadata and conflict-safe patch semantics where useful.
5. Add provider health/latency scoring and mutation-aware failover policy.
6. Design production ChatGPT authentication before public deployment.
7. Add GUI accessibility/screenshot/browser layers after structured OS control is mature.

## Known machine note

The current development PC has WSL2 support enabled, but at the last check no Linux distribution was installed. `wsl.exec` is implemented but a real distro integration test still requires an installed distro.

## Architecture rule

Do not embed Nexowire inside the DesktopCommanderMCP fork. Remote Desktop Commander and SentinelX are providers/adapters. Nexowire owns the stable AI-facing interface.
