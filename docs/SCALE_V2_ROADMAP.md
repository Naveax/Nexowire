# Nexowire Scale v2 — S1–S5 execution roadmap and acceptance checklist

> **Status: ROADMAP, unchecked means not verified.** [Parent #482](https://github.com/Naveax/Nexowire/issues/482). The older roadmap still records historical milestones; this plan is a *new* capacity/connection initiative, not a retroactive release declaration.
>
> **Critical path:** S1 connect/security baseline → S2 quota truth → S3 installer → S4 dormant subscription policy → S5 cost/load/staging acceptance. Limited parallel research is allowed; changes that depend on prior contracts must wait for the predecessor gate.

## S0: prerequisites (before software mutation)

- [ ] Capture current `main` SHA, open PRs and repo policy, and record exactly what is deployed versus only merged.
- [ ] Verify both preexisting `work-pc` and `Naveax` Native Agent routes online; record version/session identity without restarting them.
- [ ] Inventory actual hosted Worker ingress, D1 operations, OAuth flow and Agent message volumes (sanitized telemetry only).
- [ ] Read [Free-only policy](FREE_ONLY_POLICY.md), [product control plane](PRODUCT_CONTROL_PLANE.md), [quota identity](QUOTA_IDENTITY.md), [Agent lifecycle](AGENT_LIFECYCLE.md) and [vision](SCALE_V2_VISION.md).
- [ ] Define split between hosted ChatGPT MCP call, internal local task, E2E payload byte, P2P route attempt and billable logical invocation.
- [ ] Preserve parked work in [#481](https://github.com/Naveax/Nexowire/issues/481), hold #271, avoid unrelated code/feature changes.

## S1 — Connection Core v2 [#483](https://github.com/Naveax/Nexowire/issues/483)

- [ ] Draw exact current connect/login/pairing/Hub-Agent/relay/reconnect event diagram with protocol versions.
- [ ] Measure real traffic cost per authenticated MCP invocation: HTTP ingress, D1 IO, websocket signaling and streamed bytes.
- [ ] Implement **optional** route-adapter interface only after protocol contract: existing outbound WSS baseline, owner-approved direct P2P for supported first-party clients, bounded relay fallback.
- [ ] Define signed session/owner/device transport grant, expiry and revocation; avoid owner/device association from client text alone.
- [ ] NAT/firewall matrix: direct LAN, CGNAT, symmetric NAT, proxy/TLS interception, IPv4/IPv6, UDP denied, internet off.
- [ ] Error/failure state machine: authenticated reconnect, stale agent, duplicate session, abandoned relay, missing rendezvous, token rotation, revoked owner, partial payload, client cancellation.
- [ ] In tests prove one live Agent per device, no visible console switch, no unapproved service restart and no mutation replay on reconnect.
- [ ] S1 acceptance report: p50/p95 negotiation, direct success ratio per network class, relay fallback bytes/cost, baseline compatibility and security review.
- [ ] **Gate:** Real opt-in two-device transport and isolated NAT lab acceptance, feature flag **OFF by default**, existing production connections preserved.

## S2 — Identity and Daily Quota v2 [#484](https://github.com/Naveax/Nexowire/issues/484)

- [ ] Lock policy version: current monthly Free-only remains deployed until approved cutover; proposed daily: Free 1,000 / Plus 5,000 / Pro 10,000 / Enterprise contract.
- [ ] Define quota units and how 1x normal / 5x skill weighting maps to new daily envelopes; publish non-ambiguous user-facing description.
- [ ] Use canonical Free quota subject and separate paid subscription subjects; no same-device fresh account reset, paid/free cross-merge, or P2P bypass.
- [ ] Implement transactional atomic `(subject, UTC day, event-id)` reserve-before-dispatch and dedupe across concurrent Worker instances and reconnects.
- [ ] Test intentional separate invocations versus duplicated retries; return stable 409 for duplicate executed mutation rather than executing twice.
- [ ] Verify exact UTC rollover, allocation on plan upgrade/downgrade, revoked subscription, debt/refund and accounts with multiple linked device identities.
- [ ] Add honest used/remaining/reset/status dashboard and a quota-exhausted UX; no hidden unlimited tenant except explicit audited policy.
- [ ] Meter relay bytes, concurrent streams and CPU separately; enforce hard stop and fair use.
- [ ] **Gate:** Unit/D1/staging race and abuse tests pass on exact SHA, historical monthly usage migrated without silent reset or extra owner charges. Production flag remains unchanged.

## S3 — One-click onboarding v2 [#485](https://github.com/Naveax/Nexowire/issues/485)

- [ ] Preserve known working v1.0.1 Setup.cmd/LocalAppData/checksum-pinned flow as rollback.
- [ ] Build/design Nexowire-owned *signed* native installer/helper with versioned asset manifest, release checksum and publisher verification; bundled Node signature is not Nexowire installer signature.
- [ ] Default user experience: **(1) Download and install; (2) Sign in if required and press BAĞLA.** No technical network questions, manual IP, VPN or user-supplied bearer.
- [ ] Authenticate OAuth/PKCE plus owner-bound short-lived single-use pairing nonce; protected device secret and explicit SAFE default.
- [ ] Fail closed on fake download, corrupted archive, revoked pairing, wrong owner, stale executable and ambiguous duplicate device.
- [ ] Test zero-admin clean Windows user, upgrade/repair/rollback, offline/resume, UAC if truly necessary, low disk, proxy, antivirus, reboot/relogin and uninstall.
- [ ] Ensure signed installation does not restart unrelated Hub/Broker/Agent or poison current connections.
- [ ] **Gate:** Two-step clean-VM E2E + verified devices_list/health + signed artifact provenance + rollback evidence. Separate owner approval before distributing any new installer.

## S4 — Subscription/Enterprise v2 [#486](https://github.com/Naveax/Nexowire/issues/486)

- [ ] Model Free / Plus / Pro / Enterprise with explicit organization ID, seats, roles and plan-specific device/concurrency/relay budgets.
- [ ] Map signed Lemon Squeezy provider subscription/variant to **server-side** entitlement, never user input.
- [ ] Validate active → late → canceled → expired → refunded → chargeback lifecycles and out-of-order signed webhooks with idempotency.
- [ ] Ensure quota state on upgrade/downgrade has deterministic effective timestamp and no double credit; revocation propagates to device authority.
- [ ] Prove Free-only mode still yields `503 BILLING_PAUSED`; no live checkout, activation, debt or charged test without approval.
- [ ] Establish legal/merchant eligibility, privacy/data-processing terms, official invoice and explicit commercial release gate.
- [ ] **Gate:** Staging mock/provider-sandbox acceptance for subscription, enterprise tenancy and anti-fraud. **Live billing remains OFF** until separate explicit authorized go-live.

## S5 — Scale, reliability and cost acceptance [#487](https://github.com/Naveax/Nexowire/issues/487)

- [ ] Set up reproducible 100 / 1,000 / 10,000+ synthetic-account load envelopes **only in isolated test** (not live public Worker).
- [ ] Measure hosted ingress calls and D1 operations per logical request, CPU-ms, memory, egress/TURN relay GB, bytes per frame and provisioning costs.
- [ ] Mix Free/Plus/Pro/Enterprise tenants, normal/special weighted calls, heavy/light tools, outages, concurrent bursts and rate-limit queues.
- [ ] Measure p50/p95/p99 connect/reconnect/disconnect, authoritative quota reserve latency, failed auth, retry dedupe, relay fallback and cost/user.
- [ ] Inject D1 contention, cap exhaustion, relay outage, NAT failure, provider downtime, billing paused and token rotation; prove denial before execution and no surprise invoice.
- [ ] Define resource/SLO thresholds from **measured baseline** rather than inventing guarantees; version acceptance report and repeat after schema or transport changes.
- [ ] Create deployment feature flags, canary owner approval, stop criteria, one-command verified rollback design and alert thresholds.
- [ ] Test owner-active work/physical mouse and real multiple monitors only when authorized lab/hardware exists; a single-monitor DEV pass is not production multimonitor proof.
- [ ] **Gate:** Separate change approval, no-cost-overrun test evidence, independently reviewed cost forecast and complete user/device reconnect/rollback acceptance.

## S6 — Feature additions: explicitly postponed

- [ ] **NOT ACTIVE:** SCREEN X streaming feature expansion, BRAIN, GUARDIAN, FLEET, DEVGRID/HIVE, TWIN/TIME MACHINE, HARDWARE and SPECIAL X. Preserve [Nexowire EXTREME vision](SCALE_V2_VISION.md) and the user's feature concept, but do not use this initiative to sneak in UI, AI-model, remote-desktop, hardware or marketplace features.

## Cross-cutting exit definition

- [ ] Documented threat model and product policy approved; privacy, encryption, abuse and device-owner authority pass independent review.
- [ ] Every claimed successful phase has exact branch/commit, repeatable test command, CI run, platform/OS, date, and separate live acceptance evidence.
- [ ] No phase automatically deploys another phase; rollback artifacts and old Agent connectivity retained.
- [ ] Actual cloud invoices and quota-provider caps are **external facts to verify at launch**, not guessed values in Markdown.
- [ ] Existing unrelated GitHub backlog remains available in [#481](https://github.com/Naveax/Nexowire/issues/481); #402 and #271 are not closed by scale work.

### Reporting template for each stage issue

```
Stage / source SHA / branch / date:
Design decision(s) and existing-code reuse:
Acceptance checklist completed versus not done:
Windows DEV / Linux / macOS / WSL / NAT lab outcomes:
Verified CI run at exact head:
Cost estimate (measured or explicitly unknown):
Risk and owner-visible impact:
Rollback and effect on BOTH existing Native Agents:
Approval needed before any live action:
```
