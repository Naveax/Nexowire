# Nexowire Handoff

Updated: 2026-10-01

## Goal

Build a ChatGPT plugin/MCP-style computer-control system whose runtime is fully owned by Nexowire. Codex, Remote Desktop Commander, SentinelX, and other third-party computer-control services are not runtime dependencies. Useful capabilities are implemented directly in the Nexowire Hub + Native Agent stack.

## Repository state

Canonical branch: `main`

Implemented:
- TypeScript project and strict type checking
- normalized internal execution-backend interfaces
- first-party `native-agent` backend registered by the runtime
- internal capability registry with health/latency ranking, read-only failover semantics, and mutation replay protection
- native agent protocol over outbound WebSocket
- native protocol v2 process-instance identity plus bounded request deduplication for reconnect-safe same-process request continuity
- pending same-process requests resume with the exact operation/request ID; read-only requests may resume after agent process restart, while mutations fail unknown instead of being replayed
- stable native-agent device identity
- persistent case-normalized device aliases with alias-based MCP routing and offline-target rejection
- persistent native device directory with last-seen/connect/disconnect history plus capability/platform/name-aware route discovery that fails closed on ambiguity
- persistent device groups with ID/alias resolution and fail-closed group route filtering
- persistent named routing policies with `unique_only` and explicit stable-device `priority` selection, capability/platform/group filters, and fail-closed ambiguity handling
- persistent per-device capability allow/deny policy profiles enforced before provider/native execution
- shell execution for pwsh / Windows PowerShell / cmd / bash / sh
- WSL2 execution capability
- interactive process sessions with incremental stdout/stderr, stdin, stop, and list
- opt-in durable process sidecar sessions with bounded local output spool and stdin/stdout/stderr reattachment across native-agent restart
- persisted process-session metadata, retention/prune, and orphan/lost recovery classification without persisting command/output payloads
- allowlisted file read/write/list
- machine snapshot and Git workspace snapshot
- compact sampled CPU/memory/disk health plus structured DNS/TCP/HTTP probes
- structured workspace detection plus bounded parallel build/test/lint/typecheck execution
- bounded dependency-aware parallel task graphs with failure blocking and total timeout
- persisted payload-free task-graph checkpoints with exact-spec resume, succeeded-job reuse, unknown-state recovery, explicit retry controls, and verified artifact metadata (path/size/SHA-256/mtime) without artifact contents
- higher-level durable runbooks that compose task-graph and read-only assertion stages into a persistent dependency DAG with exact-spec resume; unknown task stages require explicit retry while interrupted assertion stages are safely replayable
- bounded task artifact lifecycle tools to list persisted metadata and re-stat/re-hash outputs after restart or later mutation, with changed/missing/unverified/error states and bounded hashing
- bounded in-memory agent/process event feed with topic/device filters, cursors, long-poll waits, and cursor-expiry detection
- Streamable HTTP MCP and stdio MCP
- versioned MCP surface v1 compatibility floor with `nexowire_surface_info`, independent native-agent protocol version reporting, stable-tool removal/rename protection, a frozen per-tool input-schema contract that rejects provable narrowing, and a machine-readable frozen MCP v1 structured-output semantic contract with canonical SHA-256
- persistent workspace checkpoints
- lazy skill registry
- machine-readable skill manifests with backward-compatible v1 plus additive v2 capability alternatives/preferences, replay/concurrency metadata, validation, exact-device runnability evaluation, 38 validated shipped workflows, and six read-only diagnostic workflows explicitly marked parallel-safe/replay-safe
- batch file reads and bounded text search
- safe file stat/mkdir/copy/move/delete/exact-patch primitives with real-path symlink escape checks
- SHA-256 file revisions plus conflict-safe exact patching with `FILE_CONFLICT` stale-read detection
- operation IDs plus persistent payload-free audit metadata
- bounded persistent audit-history queries with exact metadata/time filters and bounded tail scans
- persistent payload-free idempotency records for selected replay-safe mutations, with key/fingerprint mismatch rejection and restart-safe unknown-state blocking
- full MCP -> native-agent integration coverage
- real Linux native-agent outbound transport integration in Ubuntu CI covering capability advertisement, machine snapshot, bash shell, allowlisted file I/O, and interactive process sessions
- real Ubuntu 24.04 WSL2 CI covering `wsl.exec` exact distro selection, Linux cwd, Unicode stdout, nonzero exit/stderr propagation, and machine snapshot distro discovery
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
- reusable bounded read-only postcondition assertions for file existence/hash/text presence, PID liveness, TCP reachability, and HTTP status
- rotating MCP/native-agent bootstrap bearer token sets with constant-time digest matching
- external OIDC/JWT MCP identity with strict issuer/audience/signature/time verification and mapping into existing role/tool/device/route authorization
- Linux Secret Service and macOS Keychain protected-secret adapters, with hub/native-agent/relay bootstrap lookup wiring, platform-secret backend status/capability reporting, non-secret macOS presence probes, redacted diagnostics, and fail-closed macOS write when no safe no-argv path exists
- direct HTTPS/WSS hub transport with TLS 1.2+ and default refusal of non-loopback plaintext
- machine-readable deployment readiness doctor covering bind intent, TLS validity/expiry, MCP/native-agent auth, OIDC posture, secret-source mechanisms, and state-directory health without emitting credentials
- live operational security CI combining a real HTTPS hub, OIDC discovery/JWKS, role/tool scopes, hash-only stored credentials, and live revocation
- first-party relay server with inbound/upstream authentication, bounded backpressure/heartbeats, ordered agent endpoint fallback, and real native-agent relay CI coverage
- revocable/expiring hash-only stored MCP/native-agent credentials plus optional MCP tool allowlists enforced before tool execution
- stored MCP credential allowlists now filter both `tools/list` discovery and call-time execution, so restricted credentials do not receive unauthorized tool schemas
- stored MCP credentials can restrict stable device IDs and deterministic named routing policies; route grants authorize only their current unambiguous selected target
- explicit stored MCP `user`/`operator`/`admin` roles: operators can read sensitive control-plane/audit/idempotency state, admins can also mutate policy/routing/group/alias configuration, and legacy `administrative: true` credentials remain admin-compatible
- HTTP MCP discovery filters native-backed tool schemas by the capabilities currently advertised by online Nexowire agents
- Windows elevated broker mode with DPAPI CurrentUser-protected shared broker secret when no explicit plaintext broker token is configured
- purpose-bound Windows DPAPI CurrentUser protected bootstrap secret files for hub MCP/native-agent bearer sets, native-agent outbound auth, and relay inbound/upstream auth
- privileged-broker scheduled-task lifecycle (`install/status/start/stop/uninstall`) running highest-privilege under the same Windows user
- machine-validated cross-chat continuation state contract (`PROJECT_STATE.json` + required handoff files) gated by `npm run check`
- initial security/docs/tests/CI

## Current security behavior

Hub default: `127.0.0.1:43110`. Non-loopback binding is refused unless MCP and native-agent bearer credentials are configured; singular tokens, comma-separated rotation sets, and revocable/expiring hash-only stored credentials are supported. Stored MCP credentials may also carry explicit tool allowlists.

Native-agent file tools default to the current user's home directory. `NEXOWIRE_ALLOWED_ROOTS=*` intentionally grants unrestricted user-level filesystem paths.

## Runtime ownership rule

The default Nexowire runtime registers only the first-party `native-agent` backend. Third-party computer-control providers are not part of the product runtime and must not be required for any core capability.

The generic backend registry remains because it is useful for Nexowire-owned transports, multiple device paths, relay/direct routing, tests, and future first-party backends. It is not a plan to depend on external quota-limited services.

## Resume protocol

A new chat should not depend on conversation memory. Start from GitHub:

1. Open `docs/CONTINUATION.md`.
2. Read `HANDOFF.md` and `ROADMAP.md`.
3. Read `PROJECT_STATE.json` for machine-readable priorities/invariants.
4. Inspect current `main` HEAD and open PRs before editing.
5. Prefer a fresh feature branch per independent slice; parallel slices are encouraged when they do not edit the same hot files.
6. Run the smallest focused tests first, then `npm run check` and `npm run build` before merge when practical.
7. After every merged capability slice, update HANDOFF/ROADMAP/PROJECT_STATE if the remaining-work picture changed.
8. Never assume Desktop Commander or SentinelX is part of the Nexowire runtime. They are development access tools only when temporarily needed.

The repository is the source of truth. If this file disagrees with current code/CI, trust current `main`, tests, and the latest merged commits, then repair the handoff files. Run `npm run continuation:check` after changing continuation state; normal `npm run check` includes it.

## Active parallel work

- `feat/deployment-onboarding-v1`: guided deployment bootstrap on top of doctor/auth/TLS/OIDC without persisting plaintext credentials.
- `feat/native-agent-lifecycle-v1`: first-party native-agent install/status/start/stop/uninstall/autostart lifecycle.
- `feat/skill-v2-migration-pack-v2`: migrate additional conservative read-only workflows to manifest v2.

## Immediate next work

1. Build a guided bootstrap that can create scoped MCP/native-agent credentials and produce secret-safe deployment instructions/status.
2. Add persistent native-agent lifecycle so a normal machine can run Nexowire after reboot/logout without a hand-maintained console.
3. Continue manifest-v2 migration only for workflows whose replay/concurrency semantics are explicit and safe.
4. Keep deployment doctor plus live HTTPS/OIDC/revocation CI green as the production-security regression floor.
5. Keep macOS Keychain write fail-closed until a first-party no-argv/no-log write mechanism is proven.
6. Preserve the frozen MCP v1 compatibility floor and first-party-only runtime invariant.

## Known machine note

WSL2 execution is implemented and a real Ubuntu 24.04 WSL2 distro is provisioned/verified in Windows CI. Real Linux native-agent integration also runs in Ubuntu CI.

## Architecture rule

Nexowire owns the ChatGPT-facing interface, hub, transport, and native execution agent. Implement capabilities directly rather than introducing a mandatory dependency on another remote-control product.

