# Scale v2 — No-disconnect connection plan and safe release gates

> **DESIGN DOCUMENT ONLY.** No Hub, Native Agent, Broker, Cloudflare Worker, billing provider or machine process is changed by this file. Tracking: [#482](https://github.com/Naveax/Nexowire/issues/482), [S1 #483](https://github.com/Naveax/Nexowire/issues/483), [S3 #485](https://github.com/Naveax/Nexowire/issues/485), [S5 #487](https://github.com/Naveax/Nexowire/issues/487).

## 1. Current protected connections

| Device | Known identity at planning checkpoint | Observed Nexowire status | Preservation |
| --- | --- | --- | --- |
| Work PC | `aeaa5295-0aa8-4742-bf0c-2a6340dcf187` | Windows 10, Native Agent v1.0.5, online, Scheduled Task Running | DEV-only experimentation in separate Git branch/worktree; no live task/Hub/Agent restart |
| Naveax PC | `adc90bbb-9576-4b4c-b76a-600e5572ad7d` | Windows 11, Native Agent v1.0.5, online, Scheduled Task Running; Stack and Broker tasks also Running | Treat as owner production computer; no process, ACL, task or program modification during planning |

These statuses were **observed** during the 2026-10-14 task checkpoint; they are not a future uptime guarantee. Running scheduled tasks prove only task state, not necessarily authenticated route or Broker health. A safe future gate checks authenticated `devices_list` and `machine_health` for each exact stable device ID; no alternate alias fallback if a device is missing.

**Never run two Native Agent instances for the same device identity.** Existing Windows native Agent uses device/user-scoped singleton protection. The request to keep Nexowire on two PCs means preserve their **two distinct Agent installations**, not spawn two copies on one computer.

## 2. Connection Core v2 rollout layout

```text
CURRENT / RELEASED
  ChatGPT -> existing MCP ingress -> Hub -> authenticated outbound WSS Agent
                                                  | safe existing relay fallback

STAGING / OPTIONAL (after S1 review)
  First-party client <-> authorized device: direct-first peer session
      [device and owner authorization] -> NAT probe -> P2P if supported
      [unavailable] -> prepaid/free capacity-bounded relay or deny
  ChatGPT tool calls still enter hosted MCP unless platform capabilities prove otherwise.
```

Implement behind feature flags scoped to a **test account + exact test device IDs**. Failures route to the existing, authenticated, safe connection only where equivalent security semantics are proven. No automatic reroute between distinct users or to physical Default desktop; no mutation replay when outcome unknown. Fallback cannot sidestep authorization, quotas or relay hard stops.

## 3. Ordered engineering migration

### R0 — non-invasive baseline (safe now)

- [ ] Capture source/build SHA and enrolled Agent/Hub version separately, native transport protocol versions, exact device IDs, online timestamps, and current MCP endpoint.
- [ ] Collect redacted connection/failure/request-rate counters; **never echo secrets**, executable command lines with credentials, or stored DPAPI protected payloads.
- [ ] Keep old binaries, install paths, rollback state, long-lived task sessions and on-disk data intact.
- [ ] Model memory/CPU quotas without activating a disruptive experiment.

### R1 — isolated adapter development

- [ ] Implement transport adapter in separate source branch with fake peer/relay, deterministic auth and network simulation; no change to default production route.
- [ ] Verify API backward compatibility with MCP v1 and Agent v1.0.5; feature flag disabled if peer/platform lacks advertised support.
- [ ] Validate E2E handshake: owner, device, scope, expiry, nonces, cancellation, reconnect and audit metadata.

### R2 — opt-in DEV canary

- [ ] Owner explicitly confirms a test window; verify no running unsaved foreground work and safe rollback.
- [ ] Prefer separate test Agent identity/isolated VM, **not** a second process impersonating the existing DEV Agent identity.
- [ ] Preserve current Agent socket. Do not automatically replace its Hub route or service; test with a clearly separate peer runtime where possible.
- [ ] Simulate CGNAT/symmetric NAT/UDP disabled/relay-cap with external lab infrastructure only if provisioned without unexpected charges.
- [ ] Check authenticated exact-ID `devices_list`, tool health, mutation safety and no physical focus/keyboard disruption before/during/after.

### R3 — staged traffic handoff (requires separate approval)

- [ ] Verify signed release and native source/provenance, operating-system trust, protocol/server compatibility, owner-allowed time window and rollback.
- [ ] Establish both devices reachable via old mechanism **before** any handoff; record a second independent recovery channel if the live Agent could become unavailable.
- [ ] Staged canary by exact device and tenant; atomically stop routing new work to old connector only after new authenticated health is verified; retain in-flight operation idempotency.
- [ ] Any failed health/owner auth, replay mismatch, high latency, unexpected billing or relay consumption aborts and rolls back; no silent divergent UI.
- [ ] No live privileged Stack/Broker migration while #271 ACL issue is still user-held.

### R4 — general release readiness

- [ ] Recheck CI SHA, multi-platform test matrix, release signatures and invoice hard-stop.
- [ ] Verify encrypted client pairing and uninstall/rollback, automatic update policy, stale credential revocation, tenant isolation.
- [ ] Publish staged, explicitly authorized release only after independent acceptance. Never infer deployment from a merged PR.

## 4. Failure and rollback decision matrix

| Event | Mandatory response | Why |
| --- | --- | --- |
| P2P handshake fails | Retry within small bounded attempts; authenticated equivalent fallback if under budget; otherwise deny | No infinite retry/cloud billing |
| NAT requires relay | Check entitlement, bytes and remaining funded relay budget; use capped relay or deny | No hidden egress charges |
| Agent heartbeat lost | Mark offline, preserve unknown mutation, reconnect with same device identity only | No unintended duplicate execution |
| Quota service/D1 unavailable | Fail closed for new billable remote mutations; surface retry-safe status | No unmetered remote authority |
| Payment provider offline | Keep current verified cached entitlement only until explicit expiry; stop unsupported upgrades | No unauthorized paid elevation |
| Owner revokes device | Invalidate signed leases and scopes, terminate new remote access without side-channel fallback | Immediate isolation |
| Installer interrupted | Verify staged artifacts, leave prior known-good Agent intact; rollback safely | Don't strand device |
| Existing Hub/Broker task differs | Abort cutover and report observed state; no generic taskkill or unverified service restart | Protect other workloads |
| Feature flag rollout regression | Restore old authenticated route and preserve audit / idempotency state; no replay of unknown mutation | Safe recovery |

## 5. Evidence needed to claim "keeps both connections"

- Continuous, time-correlated authenticated health of **both** stable device IDs, not mere TCP reachability.
- Reconnect/disconnect event history with request/session IDs **excluding secrets**; explicit planned failover duration and observed gaps.
- Running in-flight command/session preservation under staged reconnect plus verified result/unknown classifications.
- Absence of a second competing Agent identity/process and no incidental Hub/Stack/Broker restart.
- User foreground/physical pointer unaffected while test runs, tested only in a controlled session with explicit approval.
- One clear abort/rollback action reviewed and successfully rehearsed in nonproduction.

## 6. Hard boundaries of current task

This task authorizes **GitHub documentation and planning**, not production modifications or zero-cost infra purchases. Work PC and Naveax PC must remain intact. Previous tasks are indexed in [#481](https://github.com/Naveax/Nexowire/issues/481). P0 #271 security remediation has been explicitly deferred and may not be started merely to make this rollout easier. Phase S6 feature development is postponed.
