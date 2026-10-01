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
- [x] machine-validated cross-chat continuation state contract integrated into normal checks
- [~] Public deployment security: bootstrap bearer rotation, direct TLS, descriptor-safe mounted secret files, and Windows DPAPI CurrentUser protected bootstrap secret envelopes are implemented; deployment-grade external identity and broader platform-backed secret storage remain open

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
- [x] higher-level durable runbooks composing resumable task graphs and read-only postcondition stages
- [x] verified task-graph artifact metadata tracking with SHA-256 and no persisted artifact contents
- [x] bounded artifact lifecycle inspection/re-verification with changed/missing detection and MCP exposure
- [x] payload-free runbook checkpoints with DAG dependencies, bounded parallelism, exact-spec resume, and fail-closed unknown task state

## v0.4 - Native remote runtime

- [x] first-party Nexowire native-agent backend as the default runtime
- [x] provider/backend health and latency ranking kept as an internal routing primitive
- [x] mutation-aware failover with automatic replay blocked on unknown mutation state
- [x] multi-device native-agent routing with persistent directory, aliases, groups, online/offline state, capability-aware discovery, and deterministic named route policies
- [x] persistent stable device aliases and alias-based MCP targeting
- [x] reconnect/session continuity without third-party control providers, with process-instance-aware request resumption and mutation-safe restart boundaries
- [x] operation IDs plus persistent payload-free idempotency records for selected replay-safe mutations
- [x] first-party native relay mode with direct/relay endpoint fallback and real native-agent relay CI
- [x] first-party privilege separation with elevated Windows broker routing, DPAPI-protected same-user secret bootstrap, and highest-privilege per-user scheduled-task lifecycle

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

- [~] production authorization: revocable/expiring hash-only credentials, tool/device/route scopes, explicit stored `user`/`operator`/`admin` roles, bearer rotation, TLS, descriptor-safe mounted secrets, and Windows DPAPI bootstrap envelopes are implemented; deployment-grade external identity and broader cross-platform protected-at-rest integration remain
- deployment-grade external identity plus platform-backed/encrypted secret handling beyond the current local credential store and mounted-secret/DPAPI paths
- [x] bounded persistent audit/history query with payload-free metadata filters
- [x] stable MCP surface v1: tool-name floor, frozen backward-compatible input contracts, machine-readable frozen structured-output semantic contracts, canonical output-contract hash, and surface discovery metadata
- [x] multi-device routing
- [x] dynamic capability exposure: credential-aware tools/list filtering plus online-device capability-aware schema filtering
- [~] mature skill library: manifest v1, validation, device-aware runnability, and 38 shipped operational workflows are implemented; workflow version evolution and additional domain recipes remain ongoing
- [~] Windows + WSL2 + Linux support: real Linux native-agent outbound transport/core capability CI is implemented; real WSL2 distro integration remains open
- zero required third-party computer-control runtime dependencies
