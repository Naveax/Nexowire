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
- structured Windows process/service/network/registry/task/eventlog/firewall/environment controls, including fail-closed exact-name service mutation with bounded verified state/startup postconditions, bounded Event Log text with truncation metadata, verified unnamed/default registry value mutation, and explicit UTF-8 stdin transport for structured-control plus user/machine environment PowerShell payloads
- exact HWND windows, screenshots, clipboard, keyboard, UI Automation, pointer fallback
- first-party isolated Edge/Chrome CDP automation
- exact-element browser visual verification with cropped PNG evidence
- reusable read-only postcondition assertions over files, PID liveness, TCP, and HTTP status
- rotating bootstrap MCP/native-agent bearer token sets with constant-time matching
- external OIDC/JWT MCP identity with issuer/audience/signature/time validation mapped into Nexowire roles and tool/device/route scopes
- Linux Secret Service and macOS Keychain protected-secret adapters wired into hub/native-agent/relay bootstrap lookup paths; macOS create/update is stdin-backed, bounded, read-back verified, and covered by real Keychain CI
- revocable/expiring hash-only stored MCP/native-agent credentials; stored MCP credentials support explicit user/operator/admin roles, and allowlists filter both tool discovery and call-time execution
- direct HTTPS/WSS transport with TLS 1.2+ and default refusal of non-loopback plaintext
- elevated Windows broker with DPAPI CurrentUser-protected bootstrap secret and per-user scheduled-task lifecycle
- purpose-bound Windows DPAPI bootstrap secret envelopes for hub/native-agent/relay bearer credentials
- lazy skills and MCP HTTP/stdio surfaces
- versioned MCP surface v1 compatibility floor with hub-local version discovery, frozen input contracts, and `src/mcp/v1-output-contract.json` machine-readable structured-output semantic contracts with a canonical hash
- real Linux native-agent outbound transport CI covering machine/shell/file/process core paths
- real macOS native-agent outbound transport CI covering machine/shell/file/process core paths, alongside LaunchAgent and Keychain lifecycle lanes
- real Ubuntu 24.04 WSL2 CI covering Nexowire `wsl.exec` exact distro/cwd/Unicode/nonzero-exit behavior; Windows agents advertise `wsl.exec` only when bounded distro discovery finds at least one installed distro
- additive skill manifest v2 with capability alternatives/preferences plus replay/concurrency metadata while preserving v1 semantics
- platform-secret backend hardening with non-secret macOS status probes and hashed/redacted backend diagnostics
- machine-readable `nexowire doctor` deployment readiness with strict remote-ready semantics and no secret output
- guided `nexowire onboard plan|bootstrap` deployment onboarding with hash-only stored credentials, one-time plaintext output, scoped MCP options, bounded TTLs, and doctor integration
- first-party Windows current-user Scheduled Task, Linux systemd user-service, and macOS per-user LaunchAgent native-agent lifecycle with install/status/start/stop/restart/uninstall/autostart, refusal to persist plaintext bearer variables, and real macOS lifecycle CI
- live HTTPS/OIDC/scoped-discovery/revocation operational CI
- 45 shipped skills, including fourteen replay-safe/parallel-safe read-only manifest-v2 workflows, conservative artifact/browser/service/regression/release-readiness/backup-integrity/configuration-drift domain recipes, and CI checks that domain capability references are known and read-only recipes use only read-only runtime capabilities
- installable v1.0.0 release packaging with the `nexowire` CLI, package-backed version reporting, bundled-skill fallback outside repository cwd, deterministic package-content auditing, clean tarball install smoke on Linux/Windows/macOS, SHA256SUMS, release-manifest.json, CycloneDX SBOM evidence, independent verification before upload, exact `v<package-version>` tag enforcement, SLSA/CycloneDX attestations, and an explicit authorization-marker GitHub Release gate
- canonical-realpath async path authorization that handles platform aliases such as macOS `/var` -> `/private/var` without weakening symlink-escape protection

## Release boundary and post-v1 work

The v1.0 implementation scope is complete. Further domain recipes, additional capability probes, performance tuning, and reproduced hardening work are post-v1 incremental development rather than blockers for the first stable release.

After publication:

1. keep the production regression floor green across packaged-runtime smoke, browser, Windows, Linux, macOS, WSL2, doctor/onboarding, HTTPS/OIDC/revocation, LaunchAgent, Keychain, relay, and privileged-broker lanes
2. preserve the frozen MCP v1 input/output contracts and first-party-only runtime ownership invariant
3. add new domain recipes only when they encode repeated real workflows with explicit capability requirements and mutation/replay/concurrency semantics
4. add executable/environment capability probes only after reproducing a static-advertisement mismatch
5. keep npm publication disabled for the initial self-hosted v1.0.0 release unless package policy is explicitly changed later

Nexowire v1.0.0 is published as a stable GitHub Release. Tag `v1.0.0` points at `98d040c284efad7f726c3d3ccaa1771d385ed60d`. Tag-scoped Release Readiness run `36890669730` passed Linux/Windows/macOS packaging, independent candidate verification, checksum re-verification, SLSA provenance, CycloneDX SBOM attestation, and GitHub Release publication. The release contains `nexowire-1.0.0.tgz`, `SHA256SUMS`, `release-manifest.json`, and `nexowire-sbom.cdx.json`. npm publication remains intentionally disabled.

At the 2026-10-01 post-release sync, the v1.0 implementation and publication goals are complete. Future domain recipes, probes, performance work, and reproduced hardening are post-v1 incremental work rather than missing release blockers. A new chat must still inspect current main/open PRs first because this sentence is a checkpoint, not an oracle.

## Selected post-v1 work

As of 2026-10-02, the virtual-pointer slice is merged on main as `4cfbbadfac2d4d5e6d5b1afc36abfa78b8925a25`, and `PROJECT_STATE.json` tracks `feature/private-desktop-session` as active testing work. The current slice creates a separate `NexowirePrivate` Win32 desktop with a private shell, hidden-desktop process launch/window enumeration, and a user-only shortcut for switching into it. Automated Nexowire operations do not switch the visible input desktop; tests require `Default` to remain active. The next slices are private-surface cursor routing and private keyboard delivery. No patch release is authorized by this work.

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
