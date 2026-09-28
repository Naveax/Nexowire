# Roadmap

## v0.1 - Control plane bootstrap

- [x] Repository and TypeScript project
- [x] Provider abstraction and capability routing
- [x] Native outbound agent transport
- [x] MCP Streamable HTTP and stdio modes
- [x] Shell, WSL2, file, machine, and workspace primitives
- [x] Persistent workspace checkpoints
- [x] Lazy skill registry
- [x] Initial security boundaries
- [x] End-to-end MCP -> provider -> native-agent integration test
- [x] Interactive process sessions: start/read/write/stop/list
- [ ] Durable process-session recovery across agent restart
- [x] Operation IDs and persistent audit metadata
- [ ] Structured event subscriptions
- [ ] Public deployment authentication

## v0.2 - Computer control

- richer process metadata, retention, and recovery policy
- [x] structured process/service/network inspection and service control
- [x] registry read, scheduled-task list, event-log query, and firewall-rule list
- registry/task/firewall mutation controls with verification
- registry and environment
- network diagnostics
- [x] batch file reads and bounded text search
- compact system health snapshots
- richer Windows registry/task/firewall mutations and event subscriptions

## v0.3 - Workspace agent

- project detection and targeted repository search
- build/test adapters
- persistent task graph
- parallel independent jobs
- resumable long-running work
- artifact tracking

## v0.4 - Provider mesh

- SentinelX adapter where supported
- Remote Desktop Commander adapter where supported
- provider health/latency scoring
- mutation-aware failover
- operation IDs and idempotency records
- multi-account provider profiles

## v0.5 - GUI and browser

- window enumeration/focus
- screenshot capture
- accessibility-tree inspection
- keyboard/clipboard and browser automation
- visual verification
- raw mouse control only as a fallback

## v1.0 - ChatGPT-ready remote control

- production authentication and TLS
- encrypted secrets and policy profiles
- audit/history
- stable MCP surface
- multi-device routing
- dynamic capability exposure
- mature skill library
- Windows + WSL2 + Linux support
