# Nexowire Handoff

Updated: 2026-09-29

## Goal

Build a ChatGPT plugin/MCP-style computer-control system whose runtime is fully owned by Nexowire. Codex, Remote Desktop Commander, SentinelX, and other third-party computer-control services are not runtime dependencies. Useful capabilities are implemented directly in the Nexowire Hub + Native Agent stack.

## Repository state

Active branch: `refactor/native-only-runtime`

Implemented:
- TypeScript project and strict type checking
- normalized internal execution-backend interfaces
- first-party `native-agent` backend registered by the runtime
- internal capability registry with health/latency ranking, read-only failover semantics, and mutation replay protection
- native agent protocol over outbound WebSocket
- stable native-agent device identity
- persistent case-normalized device aliases with alias-based MCP routing and offline-target rejection
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
- persistent payload-free idempotency records for selected replay-safe mutations, with key/fingerprint mismatch rejection and restart-safe unknown-state blocking
- full MCP -> native-agent integration coverage
- structured Windows process/service/network inspection and service control
- structured Windows registry, scheduled-task, event-log, and firewall queries
- verified exact Windows registry/task/firewall mutation controls
- exact Windows environment name discovery, selective redacted reads, and verified process/user/machine set/delete
- structured top-level Windows window enumeration plus exact HWND focus with foreground verification
- bounded inline PNG capture for virtual desktop, primary screen, and exact HWND rectangles with SHA-256 metadata
- bounded clipboard read/write/clear plus exact-foreground Unicode typing/hotkeys; window focus has an attached-thread exact-HWND fallback before verification
- bounded Windows UI Automation tree/find plus exact unique-selector InvokePattern and verified ValuePattern mutations with password-value suppression
- exact foreground-HWND pointer position/move/click/scroll with client bounds, occlusion/hit checks, and cursor verification
- first-party isolated Edge/Chrome CDP sessions with navigation, bounded DOM snapshots, exact selector click/value actions, inline screenshots, and exact-element visual verification with cropped PNG evidence
- rotating MCP/native-agent bootstrap bearer token sets with constant-time digest matching
- initial security/docs/tests/CI

## Current security behavior

Hub default: `127.0.0.1:43110`. Non-loopback binding is refused unless MCP and native-agent bearer credentials are configured; singular tokens and comma-separated rotation sets are supported.

Native-agent file tools default to the current user's home directory. `NEXOWIRE_ALLOWED_ROOTS=*` intentionally grants unrestricted user-level filesystem paths.

## Runtime ownership rule

The default Nexowire runtime registers only the first-party `native-agent` backend. Third-party computer-control providers are not part of the product runtime and must not be required for any core capability.

The generic backend registry remains because it is useful for Nexowire-owned transports, multiple device paths, relay/direct routing, tests, and future first-party backends. It is not a plan to depend on external quota-limited services.

## Immediate next work

1. Keep Windows typecheck/test/build green after each capability slice.
2. Extend visual verification beyond browser elements into reusable postcondition/assertion workflows; exact-element browser verification is implemented.
3. Add fully reattachable durable process I/O; current restart recovery is metadata/state-safe, not pipe reattachment.
4. Extend durable execution beyond task-graph job boundaries with artifact tracking.
5. Extend idempotency coverage only where replay semantics are provably safe; selected mutation keys/records are implemented.
6. Finish robust multi-device native-agent routing; persistent aliases are implemented.
7. Design production ChatGPT authorization/TLS/encrypted credential handling; rotating bearer sets now cover bootstrap credential rollover only.

## Known machine note

WSL2 execution is implemented. A real Linux-distro integration test still requires a distro on whichever Windows test machine is used.

## Architecture rule

Nexowire owns the ChatGPT-facing interface, hub, transport, and native execution agent. Implement capabilities directly rather than introducing a mandatory dependency on another remote-control product.
