# Nexowire

**Temporary Free-only policy:** hosted users have 1,000 weighted tool units per UTC month. Normal tool calls are 1x, dedicated skill tools and marked special-skill workflows are 5x. Paid checkout is paused. See [Free-only policy](docs/FREE_ONLY_POLICY.md).

**AI-native remote computer control for ChatGPT.**

Nexowire is a self-hosted control plane and native-agent runtime that gives ChatGPT a structured, resumable way to work with computers, terminals, files, processes, GUIs, browsers, and project workspaces.

> Status: **v1.0.1 released; v1.0.2 in candidate preparation.** The MCP v1 compatibility floor and first-party native runtime are stable. v1.0.1 adds the verified Windows one-click setup/payload distribution path; future domain recipes and capability additions remain backward-compatible incremental work.

## Runtime rule

Nexowire does not depend on Remote Desktop Commander, SentinelX, Codex, or another third-party remote-control service at runtime.

Those products may be useful during development, but the shipped data path is owned by Nexowire:

```text
ChatGPT
   |
   v
Nexowire MCP / HTTPS
   |
   v
Nexowire Hub
   |
   v
Nexowire Native Agent
   |
   v
Target computer
```

If a useful capability exists elsewhere, Nexowire implements the capability in its own native layer instead of requiring that service.

## Goals

- One stable tool surface across Windows, PowerShell, WSL2, Linux, GUI automation, files, processes, services, networking, browsers, and project workspaces.
- First-party outbound native-agent transport controlled by Nexowire.
- Persistent workspaces and resumable task state instead of stateless command-by-command control.
- Capability-based routing across Nexowire-owned execution backends and devices.
- Fast AI use through batched operations, compact snapshots, dynamic tool exposure, and structured output.
- Reusable skills for coding, diagnostics, administration, deployment, and recovery.
- Auditability, cancellation, verification, and explicit handling of destructive operations.
- No runtime quota or feature dependency on third-party computer-control providers.

## Architecture

```text
ChatGPT
   |
   v
Nexowire MCP
   |
   v
Nexowire Hub
   |-- Core / task engine
   |-- Capability router
   |-- Workspace state
   |-- Skills
   |-- Shell runtime
   |-- GUI / browser control
   |
   +-- Nexowire Native Agent
        |-- Windows / PowerShell
        |-- WSL2
        |-- Linux
        |-- Files / processes / services
        |-- UIA / screenshots / keyboard / pointer
        +-- Browser automation
```

The provider abstraction remains an internal routing boundary. Runtime registration is first-party: the default runtime registers only the Nexowire native-agent backend. Future backends must be Nexowire-owned transports or explicitly added by the operator.

## Planned capability groups

```text
filesystem   search       shell        process
git          windows      wsl          network
services     registry     tasks        gui
browser      workspace    devices      runtime
```

## Repository direction

The first milestones establish shared protocol types, a native execution backend, normalized execution results, workspace snapshots and resumable tasks, the ChatGPT-facing MCP server, multi-device routing, and tests for concurrency, validation, failure handling, and mutation safety.

See `ROADMAP.md` and `HANDOFF.md` as the implementation grows. The ChatGPT-facing compatibility contract is versioned separately as MCP surface v1; `nexowire_surface_info` reports the MCP surface and native-agent protocol versions, and `docs/MCP_SURFACE.md` defines the compatibility rules.

## Normal user connection

The normal hosted-device path is intentionally small.

For a Windows end user:

1. Download **`Nexowire-Setup.cmd`** from the versioned GitHub Release and open it.
2. Sign in if the browser asks.
3. Press **BAĞLA** once.

The setup verifies the version-pinned Windows payload SHA-256, installs its bundled Node runtime and Nexowire under the current user's `%LOCALAPPDATA%\\Nexowire\\versions\\...` directory, creates a Start Menu **Nexowire** shortcut, and launches the same hidden `connect` flow. Node/npm and administrator access are not required.

For a developer or an already installed CLI, `nexowire connect` invokes the same flow.

That is the complete user-facing connection flow. A normal user does not enter a Hub URL, bearer token, Tailscale address, PowerShell command, capability list, or per-tool access selection. Nexowire uses the hosted control plane by default, creates the localhost callback, enrolls the native agent, stores the device credential through the platform-protected secret path, and verifies the data-plane credential automatically.

Physical-console control is not part of routine connection or automation. Nexowire should prefer private-desktop, browser, and structured controls. The physical-console override remains an exceptional path for cases where the user explicitly asks to control the visible Windows desktop.

Advanced self-hosting, endpoint overrides, credential rotation, and operator policy configuration remain available, but they are not part of the normal user onboarding path.

## Security

Nexowire supports both first-party revocable credentials and optional external OIDC/JWT identity for MCP clients. External identities still pass through Nexowire tool/device/route/role authorization; they do not bypass policy.


Nexowire is intended to control real computers. Security is therefore part of the architecture rather than a later toggle. The project uses scoped capabilities, explicit target selection, audit events, credential isolation, safe defaults, and verification around destructive or privileged actions.

Do not expose a development instance directly to the public Internet.

For bootstrap remote deployments, MCP and native-agent bearer credentials support comma-separated rotation sets through `NEXOWIRE_MCP_BEARER_TOKENS` and `NEXOWIRE_AGENT_TOKENS`; singular token variables remain compatible. Matching uses constant-time digest comparison. Non-loopback exposure additionally requires direct TLS (`NEXOWIRE_TLS_CERT_FILE` + `NEXOWIRE_TLS_KEY_FILE`) unless the operator explicitly enables the trusted-private-network plaintext override. This is still bootstrap auth, not the final production authorization/revocation layer.

Stored MCP credentials can also be constrained to tool patterns, stable device IDs, and deterministic named routing policies. Stored credentials have explicit `user`, `operator`, and `admin` roles: operators can inspect sensitive control-plane/audit state but cannot mutate policy/routing/alias/group configuration, while admins can. `--admin` remains a compatibility alias for `--role admin`; static bootstrap credentials and unauthenticated loopback development retain the full operator surface. Example: `nexowire credentials issue mcp chatgpt 86400 --role operator --allow-tool machine_* --allow-device <stable-device-id>` or use `--allow-route <policy>` for a deterministic route grant.

## Development

```bash
npm install
npm run check
npm run build
```

Run the hub with `npm run dev:http` and the native agent with `npm run dev:agent`. On Windows, bootstrap bearer credentials can be sealed into purpose-bound DPAPI CurrentUser envelopes with `nexowire secrets seal <purpose> <file>`; plaintext is read only from stdin. On Windows, privilege-separated mode can be bootstrapped from an elevated terminal with `nexowire privileged-broker install`; the installer registers a highest-privilege per-user logon task and uses the DPAPI-protected broker secret rather than persisting a plaintext token. The default loopback MCP endpoint is `http://127.0.0.1:43110/mcp`; the default agent WebSocket endpoint is `ws://127.0.0.1:43110/agent`. With direct TLS configured, the same listener serves `https://.../mcp` and `wss://.../agent`.

The current bootstrap already supports shell execution, WSL2 execution, allowlisted file access, machine/workspace snapshots, interactive process sessions, batched reads, SHA-256 conflict-safe patching, bounded text search, operation audit metadata plus bounded persistent audit history queries, explicit payload-free idempotency records for selected replay-safe mutations, workspace detection/checks, dependency-aware parallel task graphs with exact-spec task-graph resume and bounded artifact re-verification, a bounded event feed, structured DNS/TCP/HTTP diagnostics, compact machine health, exact Windows environment controls, exact HWND window control, inline Windows screenshots, exact-foreground keyboard input and bounded clipboard control, Windows UI Automation tree/actions, exact-HWND pointer fallback, first-party Edge/Chrome CDP automation, workspace checkpoints, persistent device aliases/history with capability-aware route discovery, lazy skills, and native capability routing. See `ROADMAP.md` for what is still intentionally unfinished.
