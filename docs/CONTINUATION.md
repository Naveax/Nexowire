# Nexowire Continuation Protocol

This file exists so development can continue from a completely new ChatGPT conversation with no access to prior chat history.

## Canonical continuation files

A new chat must treat these exact repository paths as the handoff set:

- `docs/CONTINUATION.md`
- `HANDOFF.md`
- `ROADMAP.md`
- `PROJECT_STATE.json`

`PROJECT_STATE.json` declares the same set so CI can detect drift instead of relying on somebody remembering which markdown file was sacred this week.

## One-line goal

Build a first-party ChatGPT/MCP computer-control stack whose runtime is owned by Nexowire: Hub + Native Agent + first-party transports/capabilities, with no required SentinelX, Desktop Commander, Codex, browser SaaS, or other quota-limited remote-control dependency.

## Start here in a new chat

Use this exact order:

1. Inspect the current `main` HEAD and open pull requests on `Naveax/Nexowire`.
2. Read `HANDOFF.md`.
3. Read `ROADMAP.md`.
4. Read `PROJECT_STATE.json`.
5. If implementation details are needed, inspect only the files relevant to the next open slice.
6. Do not ask the user to repeat project history unless GitHub itself is unavailable.

## Runtime invariants

- ChatGPT talks to Nexowire MCP/HTTPS.
- Nexowire Hub routes normalized capabilities.
- Nexowire Native Agent executes them on target computers.
- The default runtime registers only Nexowire-owned execution backends.
- Third-party remote-control products are not runtime dependencies.
- Native agents initiate outbound connectivity.
- Read-only operations may fail over only across equivalent Nexowire-owned routes.
- Ambiguous mutation state is never blindly replayed.
- Secrets/command payloads should not be persisted unless a design explicitly requires and protects them.
- Tool output must remain bounded.
- Structured APIs are preferred over UIA; UIA/browser semantics are preferred over raw pointer control.

## Current high-level implementation

Implemented on main as of the latest repository state:

- first-party native-agent WebSocket transport with heartbeat/reconnect hardening
- process-instance-aware reconnect continuity: same-process request-ID resumption with native dedupe cache, read-only replay after process restart, and fail-closed mutation boundaries
- normalized provider/backend registry used only as an internal Nexowire routing seam
- stable native device identity, persistent aliases/groups, device history, capability-aware route discovery, deterministic named routing policies, and per-device capability allow/deny policies
- first-party relay server plus ordered direct/relay native-agent endpoint fallback, verified with a real relayed native agent in Ubuntu CI
- operation IDs, audit metadata, bounded persistent audit-history queries, mutation replay protection, selected idempotency records
- shell, WSL2, files, search, volatile + durable reattachable process sessions, machine/workspace snapshots
- persistent task-graph checkpoints and bounded parallel dependency execution
- higher-level durable runbooks combining task-graph stages and read-only postcondition stages with exact-spec resume and restart-safe retry rules
- bounded artifact metadata listing/re-verification with changed/missing detection and no persisted artifact contents
- event feed
- structured Windows process/service/network/registry/task/eventlog/firewall/environment controls
- exact HWND windows, screenshots, clipboard, keyboard, UI Automation, pointer fallback
- first-party isolated Edge/Chrome CDP automation
- exact-element browser visual verification with cropped PNG evidence
- reusable read-only postcondition assertions over files, PID liveness, TCP, and HTTP status
- rotating bootstrap MCP/native-agent bearer token sets with constant-time matching
- external OIDC/JWT MCP identity with issuer/audience/signature/time validation mapped into Nexowire roles and tool/device/route scopes
- Linux Secret Service and macOS Keychain protected-secret adapters wired into hub/native-agent/relay bootstrap lookup paths
- revocable/expiring hash-only stored MCP/native-agent credentials; stored MCP credentials support explicit user/operator/admin roles, and allowlists filter both tool discovery and call-time execution
- direct HTTPS/WSS transport with TLS 1.2+ and default refusal of non-loopback plaintext
- elevated Windows broker with DPAPI CurrentUser-protected bootstrap secret and per-user scheduled-task lifecycle
- purpose-bound Windows DPAPI bootstrap secret envelopes for hub/native-agent/relay bearer credentials
- lazy skills and MCP HTTP/stdio surfaces
- versioned MCP surface v1 compatibility floor with hub-local version discovery, frozen input contracts, and `src/mcp/v1-output-contract.json` machine-readable structured-output semantic contracts with a canonical hash
- real Linux native-agent outbound transport CI covering machine/shell/file/process core paths
- real Ubuntu 24.04 WSL2 CI covering Nexowire `wsl.exec` exact distro/cwd/Unicode/nonzero-exit behavior
- additive skill manifest v2 with capability alternatives/preferences plus replay/concurrency metadata while preserving v1 semantics
- platform-secret backend hardening with non-secret macOS status probes and hashed/redacted backend diagnostics
- machine-readable `nexowire doctor` deployment readiness with strict remote-ready semantics and no secret output
- live HTTPS/OIDC/scoped-discovery/revocation operational CI
- six replay-safe/parallel-safe read-only workflows migrated to skill manifest v2

## Important unfinished slices

The canonical priority list lives in `PROJECT_STATE.json` and `ROADMAP.md`. Current focus:

1. guided deployment onboarding/bootstrap on top of the now-implemented doctor/auth/TLS/OIDC stack
2. first-party native-agent install/autostart lifecycle so operator deployments survive logout/reboot without manual terminal sessions
3. migrate additional suitable read-only skills to manifest v2 while keeping mutation replay conservative
4. keep macOS protected-secret write fail-closed until a no-argv/no-log first-party path is proven
5. only add durable-runbook/idempotency/postcondition semantics when restart/replay behavior is explicit and tested

The frozen MCP v1 input and structured-output contracts are complete on main. Future incompatible semantic changes require an explicit reviewed surface/version migration rather than silently editing the v1 contract.

## Branch and merge discipline

- `main` is canonical.
- Use separate branches for independent slices.
- Avoid stacking unrelated features in one PR.
- Before merging, rebase/merge current main if the branch touches hot files such as:
  - `src/agent/executors.ts`
  - `src/protocol/capabilities.ts`
  - `src/mcp/create-server.ts`
  - `HANDOFF.md`
  - `ROADMAP.md`
- Merge only after CI is green or after a documented, reproduced CI-infrastructure issue.

## Verification commands

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Useful focused pattern:

```bash
node --test --import tsx test/<focused>.test.ts
```

Windows-only GUI/browser paths also have Windows CI coverage where applicable.

## Development access vs product runtime

During development, ChatGPT may temporarily use GitHub tools, SentinelX, or Remote Desktop Commander to edit/test the repository or a Windows machine. That is not Nexowire's architecture.

A feature is not considered complete merely because it works through SentinelX/RDC. It must exist in Nexowire's own code, tests, and first-party runtime.

## Handoff maintenance rule

Whenever a major slice merges:

- mark completed/open roadmap items accurately
- update HANDOFF implemented/next-work sections
- update `PROJECT_STATE.json` priorities and notes
- keep this file architectural and stable rather than filling it with transient branch noise

If a conversation disappears, another chat should be able to continue by reading these repository files alone.

`npm run continuation:check` machine-validates `PROJECT_STATE.json`, all declared continuation files, hot-file references, priority uniqueness/order, and the HANDOFF resume contract. Normal `npm run check` includes this validation so stale or broken continuation metadata fails CI rather than waiting for the next chat to discover archaeology.
