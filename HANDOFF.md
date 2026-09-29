# Nexowire Handoff

Updated: 2026-09-28

## Goal

Build a ChatGPT plugin/MCP-style computer-control system broader than Remote Desktop Commander or SentinelX alone. Codex is not a runtime dependency. Nexowire provides the tools, workspace state, skills, routing, and native agent.

## Repository state

Active branch: `feat/windows-screenshot-v2`

Implemented:
- TypeScript project and strict type checking
- normalized provider interfaces
- provider registry with health/latency ranking, read-only failover, and mutation replay protection
- native agent protocol over outbound WebSocket
- stable native-agent device identity
- shell execution for pwsh / Windows PowerShell / cmd / bash / sh
- WSL2 execution capability
- interactive process sessions with incremental stdout/stderr, stdin, stop, and list
- persisted process-session metadata, retention/prune, and orphan/lost recovery classification without persisting command/output payloads
- allowlisted file read/write/list
- machine snapshot and Git workspace snapshot
- compact sampled CPU/memory/disk health plus structured DNS/TCP/HTTP probes
- structured workspace detection plus bounded parallel build/test/lint/typecheck execution
- bounded dependency-aware parallel task graphs with failure blocking and total timeout
- persisted payload-free task-graph checkpoints with exact-spec resume, succeeded-job reuse, unknown-state recovery, and explicit retry controls
- bounded in-memory agent/process event feed with topic/device filters, cursors, long-poll waits, and cursor-expiry detection
- Streamable HTTP MCP and stdio MCP
- persistent workspace checkpoints
- lazy skill registry
- batch file reads and bounded text search
- safe file stat/mkdir/copy/move/delete/exact-patch primitives with real-path symlink escape checks
- SHA-256 file revisions plus conflict-safe exact patching with `FILE_CONFLICT` stale-read detection
- operation IDs plus persistent payload-free audit metadata
- full MCP -> provider -> WebSocket native-agent integration coverage
- structured Windows process/service/network inspection and service control
- structured Windows registry, scheduled-task, event-log, and firewall queries
- verified exact Windows registry/task/firewall mutation controls
- exact Windows environment name discovery, selective redacted reads, and verified process/user/machine set/delete
- structured top-level Windows window enumeration plus exact HWND focus with foreground verification
- bounded inline PNG capture for virtual desktop, primary screen, and exact HWND rectangles with SHA-256 metadata
- provider health checks, equal-priority latency ranking, read-only retry failover, and mutation replay protection
- initial security/docs/tests/CI

## Current security behavior

Hub default: `127.0.0.1:43110`. Non-loopback binding is refused unless both `NEXOWIRE_MCP_BEARER_TOKEN` and `NEXOWIRE_AGENT_TOKEN` are configured.

Native-agent file tools default to the current user's home directory. `NEXOWIRE_ALLOWED_ROOTS=*` intentionally grants unrestricted user-level filesystem paths.

## Immediate next work

1. Keep Windows typecheck/test/build green after each capability slice.
2. Add fully reattachable durable process I/O; current restart recovery is metadata/state-safe, not pipe reattachment.
3. Add additional Windows mutation primitives only where final state can be verified safely.
4. Extend durable execution beyond task-graph job boundaries: durable process I/O and artifact tracking remain open.
5. Add explicit idempotency keys/operation records for selected replay-safe mutations.
6. Design production ChatGPT authentication before public deployment.
7. Add GUI accessibility, keyboard/clipboard, browser automation, and visual action verification on top of the now-available window/screenshot primitives.

## Known machine note

The current development PC has WSL2 support enabled, but at the last check no Linux distribution was installed. `wsl.exec` is implemented but a real distro integration test still requires an installed distro.

## Architecture rule

Do not embed Nexowire inside the DesktopCommanderMCP fork. Remote Desktop Commander and SentinelX are providers/adapters. Nexowire owns the stable AI-facing interface.
