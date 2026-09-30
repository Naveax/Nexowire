# Nexowire Continuation Protocol

This file exists so development can continue from a completely new ChatGPT conversation with no access to prior chat history.

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
- normalized provider/backend registry used only as an internal Nexowire routing seam
- stable native device identity, persistent aliases/groups, device history, capability-aware route discovery, deterministic named routing policies, and per-device capability allow/deny policies
- operation IDs, audit metadata, mutation replay protection, selected idempotency records
- shell, WSL2, files, search, volatile + durable reattachable process sessions, machine/workspace snapshots
- persistent task-graph checkpoints and bounded parallel dependency execution
- event feed
- structured Windows process/service/network/registry/task/eventlog/firewall/environment controls
- exact HWND windows, screenshots, clipboard, keyboard, UI Automation, pointer fallback
- first-party isolated Edge/Chrome CDP automation
- exact-element browser visual verification with cropped PNG evidence
- reusable read-only postcondition assertions over files, PID liveness, TCP, and HTTP status
- rotating bootstrap MCP/native-agent bearer token sets with constant-time matching
- lazy skills and MCP HTTP/stdio surfaces

## Important unfinished slices

The canonical priority list lives in `PROJECT_STATE.json` and `ROADMAP.md`. Broadly:

1. durable long-running work/artifact workflows beyond current process/task-graph primitives
2. reconnect/session continuity and optional first-party relay transport
3. first-party privilege separation; per-device capability policy profiles are implemented
4. production authorization/TLS/revocation/encrypted secret storage
5. extend postconditions only into deterministic additional OS/application domains
6. stronger Linux/WSL integration coverage

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
