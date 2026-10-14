# Nexowire Scale v2 — Vision and architecture decision record

> **Status: DESIGN / NOT DEPLOYED • 2026-10-14 • Scope S1–S5 only**
>
> Parent: [#482](https://github.com/Naveax/Nexowire/issues/482). Phases: [S1 #483](https://github.com/Naveax/Nexowire/issues/483), [S2 #484](https://github.com/Naveax/Nexowire/issues/484), [S3 #485](https://github.com/Naveax/Nexowire/issues/485), [S4 #486](https://github.com/Naveax/Nexowire/issues/486), [S5 #487](https://github.com/Naveax/Nexowire/issues/487).
>
> S6 (SCREEN X / BRAIN / GUARDIAN / FLEET / DEVGRID / HIVE / HARDWARE / SPECIAL X feature expansion) is **PARKED**. This project changes scalability and onboarding foundations first, not end-user tool features.

## 1. Product vision

Enable an ordinary owner to install a verified Nexowire agent, sign in, press **BAĞLA**, and reliably control only their authorized devices through ChatGPT/MCP or first-party clients. No manual Hub URL, token copying, public inbound port, VPN enrollment or server provisioning in the standard path. Keep real machine input and existing sessions safe; meter hosted service use per account or enterprise organization without an unexpected owner-funded bill.

Desired **future plan proposal**, not live policy:

| Plan | Proposed hosted logical invocation entitlement | Reset | Device / concurrency / relay budgets |
| --- | ---: | --- | --- |
| Free | 1,000/day per canonical quota subject | 00:00 UTC | To be decided with cost test |
| Plus | 5,000/day per subscription subject | 00:00 UTC | To be decided with cost test |
| Pro | 10,000/day per subscription subject | 00:00 UTC | To be decided with cost test |
| Enterprise | Explicit contracted allowance | Contract-defined | Organization seats, device, roles, relay/byte/SLA contract |

No statement above is a promise of unlimited Cloudflare requests, unlimited local CPU, free relay traffic, unlimited ChatGPT usage or availability under every NAT. "Unlimited" can describe locally executed *unmetered* operations within authorized resource limits, **never** a server-side infinite-cost commitment.

## 2. What is already implemented versus still a hypothesis

| Layer | Existing source/documented behavior | Scale v2 decision needed |
| --- | --- | --- |
| Hosted ingress | ChatGPT MCP/HTTPS -> Nexowire Worker/Hub; OAuth and owner/device scopes | Measure hosted HTTP per logical tool call; preserve MCP v1 compatibility |
| Remote Agent | Outbound first-party authenticated WebSocket, stable device IDs, reconnect, process-aware mutation safety | Transport adapter, resilience/cost instrumentation, fallback policy |
| Relay | First-party relay and ordered endpoint fallback already covered by CI | Relay cost caps, NAT test matrix, optional P2P for compatible first-party clients |
| Quota | **Live documented temporary policy:** Free-only, 1,000 weighted units per UTC **month**, ordinary 1x, special skill 5x, quota subjects and D1 usage records | Explicitly versioned transition to proposed UTC daily plans and dimensions |
| Billing | Lemon Squeezy integration exists; live checkout deliberately paused with `BILLING_PAUSED` | Validate and launch only with separate explicit owner/legal/provider approval |
| End-user install | Checksum-pinned Windows Setup.cmd, bundled signed Node runtime, sign-in + BAĞLA | Nexowire-owned signed native installer/helper, safe repair/rollback |
| Other projects | AI Screen #402, runtime ACL #271 and related Broker/Hub issues remain open | Preserve safety boundaries and park unrelated feature work |

Sources in this repo: `README.md`, `ROADMAP.md`, `docs/FREE_ONLY_POLICY.md`, `docs/QUOTA_IDENTITY.md`, `docs/PRODUCT_CONTROL_PLANE.md`, `docs/PROVIDERS.md`, `docs/AGENT_LIFECYCLE.md`, `docs/ARCHITECTURE.md`.

### Existing policy and target may conflict: intentional

`docs/PRODUCT_CONTROL_PLANE.md` includes an older **initial monthly plan envelope** (Free 20k, Plus 100k, Pro 500k, Custom explicit), while `docs/FREE_ONLY_POLICY.md` defines the later **temporary effective hosted policy** (Free-only, monthly weighted 1,000, billing paused). Scale v2 proposes **daily** allowances, not a silent deployment or an immediate replacement for either. A feature-flagged versioned entitlement migration and dashboard/user communication are required. Current special-skill 5x weighting and owner exception require explicit migration decisions, not assumptions.

## 3. Control versus data plane

```text
ChatGPT host ── MCP/HTTPS request ──> Nexowire hosted ingress
                                      | AuthN/AuthZ, account and quota subject
                                      | Atomic request reservation + audit
                                      v
                               Hub / authorized router
                                      | existing outbound authenticated WSS
                                      v
                               Nexowire Native Agent
                                      | local job graph, bounded outputs
                                      +--> machine capabilities

First-party local viewer / paired device <== mutually authorized E2E ==>
    direct peer path (where viable) OR bounded metered relay fallback
```

**Non-negotiable protocol reality:** ChatGPT's hosted MCP tool calls must reach the configured Nexowire MCP server. An Agent-Agent QUIC/WebRTC stream cannot erase the hosted MCP ingress call merely by being P2P. Device-to-device files, first-party viewer streams and local task fan-out are the initial candidates to move large data off centralized infrastructure. If product strategy requires *direct ChatGPT host -> device* transport, document and prove platform support before designing around it.

A lightweight Control Plane handles OAuth identity, owner-bound device selection, initial signaling, short-lived capability grants, plan/quotas, lease revocation and audit. Local Agent executes authorized work. P2P attempts follow explicit supported-network detection; NAT/relay is negotiated with hard limits. **Never make a cloud outage disable local OS safety or make offline billing unlimited.**

## 4. Security and multi-tenant invariants

1. Server-authoritative account, subscription, device, organization and quota-subject identities; no trusting caller-chosen plan, device, units, grant or billing status.
2. Hosted dispatch checks authenticated scope **and** atomic quota reservation *before* mutation execution. Same request ID does not entitle unlimited free retrials. Ambiguous mutation never silently replays.
3. Short-lived signed transport capabilities bound to owner + device pair + session + scope + expiry; peer-to-peer never bypasses authorization or grants unrestricted shell access.
4. Encryption in transit (and E2E for private P2P payloads where designed); no transfer of raw credentials, screenshots or full shell results through analytics logs.
5. Explicit quotas beyond logical calls: simultaneous tasks/streams, bytes, CPU/memory, per-device network and relay GB; rate limiting and anti-abuse must not disproportionately mischarge retries.
6. Budget hard-stop: zero implicit owner-paid upgrades, no postpaid debt, no unbounded TURN service or background egress. Graceful denial when free resources are exhausted.
7. No agent duplication, no unapproved Hub/Broker/Stack restarts, no Windows Default desktop focus/mouse interruption. No live ACL modification while #271 is user-held.
8. Distinguish observed status from inferred success: an installed task or returned 200 is not equivalent to authenticated ready and reconnectable end-to-end route.

## 5. Authority / blockers

Only **documentation, issue tracking, read-only inspection and isolated software design** are authorized by this record. Production Worker/D1 schema changes, paid billing, real card charges, service restarts, installer signing/distribution and high-volume public load require separate gate approval. Work PC and Naveax PC currently have separate online Native Agent v1.0.5 installations; maintain both and independently prove reconnection before any later staged cutover.

## 6. Next reading order

1. [Implementation roadmap](SCALE_V2_ROADMAP.md) for S1–S5 dependency gates.
2. [Quota and capacity economics](SCALE_V2_QUOTA_AND_COST.md) for accounting semantics and finite resource math.
3. [No-disconnect rollout](SCALE_V2_CONNECTION_ROLLOUT.md) for two-device preservation and rollback.
4. [Current effective Free-only policy](FREE_ONLY_POLICY.md) to avoid confusing proposal with deployment.
5. [Global parked-task handoff #481](https://github.com/Naveax/Nexowire/issues/481) for unrelated preserved work.
