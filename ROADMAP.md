# Roadmap

## v0.1 - Control plane bootstrap

- [x] Repository and TypeScript project
- [x] Capability abstraction and native routing
- [x] Native outbound agent transport
- [x] MCP Streamable HTTP and stdio modes
- [x] Shell, WSL2, file, machine, and workspace primitives
- [x] Persistent workspace checkpoints
- [x] Lazy skill registry
- [x] Initial security boundaries
- [x] End-to-end MCP -> native-agent integration test
- [x] Interactive process sessions: start/read/write/stop/list
- [x] Persisted process-session metadata, orphan/lost recovery classification, retention, and prune
- [x] Opt-in fully reattachable durable process I/O across native-agent restart
- [x] Operation IDs and persistent audit metadata
- [x] Structured bounded event feed with cursor-based long polling
- [~] Public deployment authentication: bootstrap bearer rotation is implemented; production authorization/TLS remains open

## v0.2 - Computer control

- [x] process metadata retention/recovery policy and explicit prune
- [x] durable reattachable process I/O with bounded sidecar output spool; live event feed is implemented
- [x] structured process/service/network inspection and service control
- [x] registry read, scheduled-task list, event-log query, and firewall-rule list
- [x] registry value/key, task state, and firewall rule mutation controls with verification
- [x] registry and exact process/user/machine environment controls
- [x] structured DNS/TCP/HTTP network diagnostics
- [x] batch file reads and bounded text search
- [x] SHA-256 file revisions and conflict-safe exact patching
- [x] compact sampled system health snapshots
- richer Windows registry/task/firewall mutations where verification remains reliable

## v0.3 - Workspace agent

- [x] project detection and targeted repository search
- [x] structured build/test/lint/typecheck adapters for detected workspaces
- [x] persistent task graph metadata and exact-spec resume
- [x] persistent/resumable task graph metadata across agent restart with explicit unknown-state replay control
- [x] bounded dependency-aware parallel independent jobs
- resumable long-running work beyond task-graph job boundaries
- [x] verified task-graph artifact metadata tracking with SHA-256 and no persisted artifact contents

## v0.4 - Native remote runtime

- [x] first-party Nexowire native-agent backend as the default runtime
- [x] provider/backend health and latency ranking kept as an internal routing primitive
- [x] mutation-aware failover with automatic replay blocked on unknown mutation state
- [~] multi-device native-agent routing: persistent directory, aliases, groups, online/offline state, and capability-aware route discovery are implemented; richer routing policy remains open
- [x] persistent stable device aliases and alias-based MCP targeting
- [ ] reconnect/session continuity without third-party control providers
- [x] operation IDs plus persistent payload-free idempotency records for selected replay-safe mutations
- [ ] native relay mode for machines that cannot reach the hub directly
- [~] first-party privilege separation remains open; persistent per-device capability allow/deny profiles are implemented

## v0.5 - GUI and browser

- [x] window enumeration/focus with exact HWND verification
- [x] bounded inline screenshot capture for desktop and exact HWND rectangles
- [x] bounded Windows UI Automation tree/find plus exact invoke/set-value controls
- [x] exact-foreground keyboard input and bounded clipboard control
- [x] first-party Edge/Chrome session, navigation, DOM snapshot/action, and screenshot automation
- [x] exact-element browser visual verification with DOM expectations, hit testing, and cropped PNG evidence
- [x] exact-HWND raw pointer move/click/scroll only as a fallback
- [x] reusable bounded postcondition assertions for files, PID liveness, TCP, and HTTP status

## v1.0 - ChatGPT-ready remote control

- production authorization, TLS, revocation, and encrypted credential storage
- encrypted secrets and hardened administrative authorization for policy profiles
- audit/history
- stable MCP surface
- multi-device routing
- dynamic capability exposure
- mature skill library
- Windows + WSL2 + Linux support
- zero required third-party computer-control runtime dependencies
