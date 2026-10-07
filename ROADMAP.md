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
- [x] Public deployment security foundation: bootstrap bearer rotation, direct TLS, mounted/platform secrets, external OIDC/JWT identity, backend status/redaction, deployment doctor, guided onboarding/bootstrap, live HTTPS/OIDC/revocation CI, and safe stdin-backed macOS Keychain write/update are implemented

## v0.2 - Computer control

- [x] process metadata retention/recovery policy and explicit prune
- [x] durable reattachable process I/O with bounded sidecar output spool; live event feed is implemented
- [x] structured process/service/network inspection and fail-closed exact-name service control with exactly-one-target resolution plus bounded verified state/startup postconditions
- [x] registry read, scheduled-task list, event-log query, and firewall-rule list
- [x] registry value/key (including unnamed/default values), task state, and firewall rule mutation controls with verification; structured Windows-control PowerShell payloads use explicit UTF-8 stdin
- [x] registry and exact process/user/machine environment controls; user/machine PowerShell payloads use explicit UTF-8 stdin and real Windows large-Unicode-value coverage
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
- [x] first-party native-agent install/autostart lifecycle across Windows current-user Scheduled Task, Linux systemd user service, and macOS per-user LaunchAgent, with real macOS lifecycle CI

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

- [x] production authorization foundation: revocable/expiring hash-only credentials, tool/device/route scopes, roles, bearer rotation, TLS, external OIDC/JWT identity, protected secret sources including verified macOS Keychain write/update, machine-readable readiness, guided onboarding/bootstrap, and live revocation/security CI
- [x] platform-backed secret lifecycle: Windows DPAPI, Linux Secret Service, and macOS Keychain support protected lifecycle operations; macOS write/update uses bounded `security -q -i` stdin commands with explicit overwrite and read-back verification
- [x] bounded persistent audit/history query with payload-free metadata filters
- [x] stable MCP surface v1: tool-name floor, frozen backward-compatible input contracts, machine-readable frozen structured-output semantic contracts, canonical output-contract hash, and surface discovery metadata
- [x] multi-device routing
- [x] dynamic capability exposure: credential-aware tools/list filtering plus online-device capability-aware schema filtering; browser capabilities are executable-aware and `wsl.exec` is advertised only when an installed distro is detected
- [x] mature v1 skill-library baseline: backward-compatible manifest v1+v2, device-aware runnability, capability alternatives/preferences, replay/concurrency metadata, 45 shipped workflows, fourteen explicit replay-safe/parallel-safe read-only workflows, corrected event-driven-control semantics, seven conservative domain recipes including release-readiness, backup-integrity, and configuration-drift auditing, and CI-enforced domain capability/read-only contracts; further recipes are post-v1 incremental additions
- [x] Windows + WSL2 + Linux + macOS core coverage: Windows control/browser lanes, real Ubuntu 24.04 WSL2 `wsl.exec`, real Linux native-agent/relay core CI, and real macOS native-agent machine/shell/file/process CI are implemented
- [x] release-candidate readiness: installable CLI packaging, bundled skills outside repository cwd, deterministic package-content checks, and clean tarball install smoke on Linux/Windows/macOS with canonical GitHub Actions artifact upload
- [x] Windows one-click release bundle: no preinstalled Node/npm or admin requirement, checksum-pinned versioned install under LocalAppData, Start Menu launcher, bundled official Node runtime/license, release checksums, and provenance attestations
- [x] zero required third-party computer-control runtime dependencies
- [x] release provenance metadata: SHA256SUMS, release manifest, and CycloneDX SBOM are attached to canonical candidates
- [x] independently verify generated checksum/manifest/SBOM evidence before candidate upload
- [x] exact tag/package-version enforcement before canonical packaging on `v*` tag-triggered readiness runs
- [x] tag-only SLSA build provenance and CycloneDX SBOM attestations after verified candidate download with isolated OIDC/attestation permissions
- [x] GitHub v1.0.0 published with verified package artifacts, SHA256SUMS, release manifest, CycloneDX SBOM, SLSA provenance, and SBOM attestation; npm publication remains intentionally disabled for the initial self-hosted release
- [x] GitHub v1.0.1 published with checksum-pinned Windows one-click setup/payload assets, real `cmd.exe` installation smoke, Windows provenance attestations, independent post-publication hash/manifest/setup-pin verification, and duplicate-safe authorized Release Readiness dispatch

## Post-v1 - Private desktop and isolated input

- [x] independent click-through Nexowire virtual cursor with separate coordinates/style and proof that it never moves the Windows system cursor
- [x] real `NexowirePrivate` Win32 desktop with private shell, hidden-desktop process launch/window enumeration, user-only switch entry, and no automatic visible-desktop takeover
- [x] private-surface cursor routing so Nexowire pointer actions target the private desktop instead of the physical console
- [x] isolated private keyboard/text/hotkey routing scoped to the private desktop/application target
- [x] private viewer/switch UX with explicit user entry/exit and bounded screenshot/inspection path
- [x] time-bounded explicit console-control grant profile for physical pointer/keyboard/UIA/clipboard mutations


## Post-v1 - Easy onboarding and Tailscale transport

- [x] fail-closed native-agent enrollment/status/doctor flow that distinguishes installed/configured/running from real Hub authentication
- [x] reject placeholder Hub URLs and unavailable protected credential references before treating an agent as connected
- [x] detect local Tailscale connectivity, MagicDNS identity, Serve state, and Funnel state
- [x] expose `nexowire tailscale status|serve|funnel|reset`; public Funnel is refused until MCP and native-agent authentication are configured
- [x] Windows one-command self-host bootstrap: hash-only credentials, DPAPI token recovery, Hub Scheduled Task, local Agent loopback enrollment, resumable state, and optional auth-gated Tailscale Funnel
- [x] live self-hosted Hub + local Agent enrollment on DESKTOP-ONDD84S with authenticated local MCP `devices_list`, `machine_snapshot`, and `machine_health`
- [x] enable Tailscale Serve/Funnel at the tailnet account level and verify public HTTPS/WSS ingress on `nexowire.tail10f02d.ts.net`
- [x] complete ChatGPT-side OAuth MCP connector verification


## Temporary Free-only policy (2026-10-06)

Nexowire is intentionally FREE ONLY until the owner explicitly authorizes a future paid launch after legal/provider verification. Normal hosted Free accounts have 1,000 weighted tool units per UTC calendar month; the uniquely GitHub-OAuth-verified repository owner (GitHub numeric subject `79841922`) has `monthlyCredits: null` and therefore no Nexowire-hosted tool-credit ceiling. Both retain 1x normal and 5x special-skill event accounting, device/tool authorization, and idempotent execution. The quota denies further calls before execution; all billing routes remain 503/BILLING_PAUSED by default, no automatic payments/upgrades. The provider integration is retained but dormant. See docs/FREE_ONLY_POLICY.md. Verify the current main and CI before claiming the policy is deployed; a branch-local implementation is not proof of production rollout.

## 2026-10-07 two-PC production acceptance

- [x] Owner-only unlimited hosted MCP tool-credit deployment: PR #213, exact-main 7/7 CI `37541360109`, production Worker deploy `37541527113`; paid billing remained disabled. PR #214 restored manual-only deploy and exact-main CI `37541907756` passed.
- [x] Verify live Nexowire MCP access to two distinct Windows agents and migrate both to runtime v1.0.2: `Naveax` and `work-pc` both run the checksum-verified versioned Windows bundle at `1.0.2-68230bc52d33`; rollback launcher/runtime copies are retained until final soak closes.
- [x] Run cross-device basic Windows shell, WSL2, DNS/HTTPS, allowed file write/read/patch/delete, isolated Edge browser navigation/DOM, visible screenshot, bounded UIA, registry/task enumeration, and 3-stage dependency task graph smoke tests.
- [x] After both PCs moved to v1.0.2, run 24 bounded parallel MCP calls across the pair: 12/12 machine-health calls plus 12/12 mixed machine-snapshot/control-plane TCP probes passed with exact device targeting.
- [x] Prove generic Windows route ambiguity does not silently select either device; exact-ID routes select correctly.
- [ ] Authenticated production owner dashboard must be checked to explicitly confirm `usage.monthlyCredits === null`; successful MCP requests and simulated D1 tests are not a substitute for this proof.
- [x] Perform controlled **Naveax Native Agent** stop/start through an independent per-user Scheduled Task with a recovery task; real MCP reconnect passed on the same device ID, and a previously orphaned second agent process was identified and safely removed via guarded PID checks. Ambiguous mutation was not replayed.
- [x] Verify bounded work-pc Hub and Agent stop/recovery on the same stable device ID; both recovered and temporary recovery tasks were removed.
- [ ] Fix and re-test cold-boot/pre-logon availability. Real work-pc reboot proved the v1.0.2 Hub is only `AtLogOn`; v1.0.3 adds an elevated SYSTEM `AtStartup` Hub with LocalMachine-DPAPI service token and rollback to the user Hub.
- [ ] Run genuine production D1 concurrent multi-call contention after authenticated owner entitlement inspection.
- [x] Resolve `Nexowire Stack`/`Nexowire Native Agent` overlap on `Naveax`: Stack now supervises the canonical Scheduled Task instead of launching a second agent; controlled restart/reconnect confirmed one active agent. The separate `work-pc` non-admin firewall-rule read still returns Windows access-denied and correctly remains fail-closed.
- [x] Migrate `work-pc` Hub/Agent to the checksum-verified versioned v1.0.2 runtime without breaking its existing self-hosted Hub/Tailscale wiring; controlled cutover rollback worked on the first helper-script failure, and the corrected cutover then completed with Hub/Agent Running.
- [ ] Install/verify the Privileged Broker on `work-pc`. Current official install correctly refuses from the non-elevated agent; one initial local administrator approval is required, after which supported admin operations should not require per-operation UAC.
- [x] Publish v1.0.2 after Linux/Windows/macOS Release Readiness, Windows setup smoke, checksums, SBOM and attestations: publisher `37617454518`, tag-scoped Release Readiness `37617530936`.
- [ ] Complete v1.0.3 reboot-resilience CI/Release Readiness, then install its pre-logon Hub on work-pc with one explicit administrator approval and repeat a real cold reboot.

Detailed evidence: [docs/LIVE_ACCEPTANCE_2026-10-07.md](docs/LIVE_ACCEPTANCE_2026-10-07.md).

## Post-final - Nexowire Screen

First major feature after the current FINAL acceptance/release gate. Detailed design: [docs/NEXOWIRE_SCREEN.md](docs/NEXOWIRE_SCREEN.md).

- [ ] Screen S0: stable `nexowire.screen.*` contracts plus deterministic cursor-path simulator.
- [ ] Screen S1: dedicated AI workspace built on private desktop/screen/viewer primitives; user keeps the physical desktop and real mouse.
- [ ] Screen S2: smooth AI cursor using cubic Bézier geometry plus minimum-jerk timing, bounded velocity/acceleration, target slowdown, cancellation and replanning.
- [ ] Screen S3: optional signed Windows IddCx/Indirect Display virtual-monitor track after VM validation and reversible install/uninstall.
- [ ] Screen S4: dashboard viewer/settings, resolution/DPI/FPS controls, cursor themes and Natural/Precise/Fast motion profiles.
- [ ] Prove 1,000 AI Screen moves do not move the physical Windows cursor.
- [ ] Prove two PCs can run independent Screens without cross-device state leakage.

## Post-v1 - Hosted product control plane

- [x] Free / Plus / Pro / Custom plan model with hard-stop zero-owner-spend policy
- [x] quota subjects, privacy-preserving device anchors, and Free-account anti-abuse binding
- [x] Cloudflare Worker + D1 control plane with migrations through MCP OAuth
- [x] GitHub OAuth sign-in and signed Nexowire sessions
- [x] one-click browser pairing and per-device agent credentials
- [x] reduce normal hosted onboarding to `nexowire connect` -> sign in if needed -> **BAĞLA**, with the production control-plane endpoint baked in and no token/URL/Tailscale/capability-selection UI
- [x] keep physical-console access outside routine onboarding/automation; prefer private desktop, browser, and structured controls unless the user explicitly requests visible-desktop control
- [x] OAuth 2.1 + PKCE hosted MCP authorization
- [x] hosted account device isolation and MCP usage metering
- [x] automated Cloudflare production deployment workflow with generated secret-free runtime config
- [x] one-command owner bootstrap with DPAPI owner secrets, D1 migrations, Worker deploy orchestration, protected GitHub App Manifest setup, and encrypted D1 OAuth runtime config
- [x] complete Cloudflare browser authorization and first production Worker/D1 deployment
- [x] complete the live GitHub App Manifest creation during the first production bootstrap
- [x] complete live Hub protected control-plane service authentication
- [x] complete end-to-end ChatGPT OAuth MCP acceptance against the hosted control plane
- [x] complete hosted Free-plan production acceptance: live dashboard/device presence, quota/event accounting, and OAuth refresh-token rotation
- [x] create the initial least-privilege Cloudflare CI API token in the dashboard, run `npm run cloudflare:ci-provision -- --apply` to sync the token/account plus the three existing DPAPI owner deploy secrets, and verify the GitHub Actions production deploy path
- [x] add Lemon Squeezy Plus/Pro subscription checkout, signed webhook reconciliation, customer portal, and protected deployment-secret handling
- [x] add Custom prepaid credit packs with carry-over quota-subject balances, idempotent signed order credits, refund clawback, and refund debt
- [x] add protected Lemon Squeezy production provisioning: live catalog validation, DPAPI secret persistence, idempotent webhook create/update, and bootstrap auto-discovery
- [x] add secret-safe local Lemon Squeezy provisioning readiness inspection with stable blocker codes and purpose-bound protected-envelope validation without decrypting secrets or contacting the provider
- [x] add single-command paid-plan production acceptance orchestration: read-only live catalog/webhook preflight, protected deploy mode, public health, zero-owner-spend, billing deployment/auth-boundary validation, and fail-closed no-provider/no-deploy behavior while provisioning is missing
- [x] add guided production billing setup with hidden API-key input, GET-only store/product/variant discovery, safe Plus/Pro auto-selection, prepaid-credit inference, canonical webhook derivation, protected provisioning reuse, deploy, and read-only acceptance
- [ ] ensure the real live Lemon Squeezy merchant account/store/catalog exists, enter the live API key through `npm run billing:setup`, then complete the explicit real-money Plus/Pro/Custom checkout/webhook/refund/debt/quota acceptance
