# Nexowire Connection v2 | Release candidate gate

**Verdict: NO-GO. This is a Draft-only source integration, not a release.**

## Frozen source snapshot
- Candidate identifier: `1.0.8-connection-v2-rc.0+939b4d6` (no release tag)
- Current main parent: `939b4d6beecf996f2750c736c5d4b4beb7b64488`; old #1003 base: `a19a228dc6f19fd484cf935e941a00ea625233f8` (62 main-side commits)
- Source HEAD snapshot: #1003 `95d9f9e431ad5a9c46adde1ecf716f84d60d8455`; #1044 `d38b30fec77cce5c9b5e29c491b11f8fe6806bef`; #1074 `5997a6d7ae43c34170016eb0963718ee35bf4a15`; #1077 `67fa411c6aa6135aeeac93f7197b5fd46c804884`; #1081 `707db9728c883d1bb027788793f4cc072768f325`; #1083 `4d8e7b359d572a6ee4cf22fd02ad9ee7ed81808e`; #1084 `84cfcaa19095f3210e92ffc22d7ca3dce3d8dd13`.
- Git DAG: original six-parent commit (main plus #1003/#1044/#1074/#1077/#1081); next integration commit records #1083, #1084 and newer #1003/#1044 as additional parents. Source refs stay untouched.
- Selected source paths: **47**, preservation rows **54**. Status distribution: `{"MERGED_MAIN_SECURITY_REVIEW_REQUIRED":4,"EXACT_BLOB":45,"EVOLVED_SOURCE_SEMANTIC_REVIEW_REQUIRED":5}`. Exact SHA matching is not equivalent to semantic verification..
- `.github/workflows/ci.yml` merged with current-main QA checks and official Cloudflared security checks; `scripts/ai-screen-launch-sinks-baseline.json` union retains main journal owner and new Cloudflare launch sinks. No branch source file was deleted.
- Candidate exactly matching a source blob is not equivalent to a passing integration test. `MERGED_*` and `EVOLVED_*` rows need independent owner confirmation and semantic regression tests.
- GitHub compare provided merge-base evidence. Native `git cherry`, `git patch-id --stable`, and `git merge-tree` are **NOT_RUN**; Git data tree construction is not a substitute for native conflict simulation.

## Security, operations and acceptance gates
| Acceptance | Status | Blocking evidence |
|---|---|---|
| P1-A/B/D: Cloudflared publisher, official binary provenance, credential ACL/custody | **NO-GO** | Previous #1077 CI `41812885695` failed on an older SHA; candidate exact-head proof needed. |
| P1-C: deny authenticated redirects, DNS rebinding, private/metadata IPs | **NO-GO** | Previous #1074 CI `41812040060` failed on an older SHA; candidate exact-head proof needed. |
| Authentication: device binding before WSS HTTP 101 | **NOT_RUN** | No authenticated isolated staging handshake captured. |
| Revocation while dispatching mutation | **NOT_RUN** | Negative fail-closed oracle not exercised on integrated candidate. |
| Lost ACK / UNKNOWN / no-replay | **SOURCE_INCLUDED / NOT_ACCEPTED** | #1083 integrated; explicit negative CI and physical lost-ACK/UNKNOWN state transitions not yet accepted. |
| Windows Task Scheduler guardian, child cleanup, reboot, recovery, rollback | **SOURCE_INCLUDED / NO-GO** | #1084 integrated; disposable VM 20-cycle real Task test NOT_RUN; prior Windows parent cleanup test RED. |
| Off-network OAuth, token validation, MCP initialize, device select, harmless read-only tool | **NOT_RUN** | Real external provider flow not captured. |
| Relay Windows/Linux, Node 22/24 | **PRIOR_CANDIDATE_PASS** | #1085 prior SHA `c09ad208...`, run `41826788911`: 4/4 SUCCESS. New candidate SHA requires fresh verification. |
| 101+ authenticated WSS; overload; 1GiB verified transfer | **NOT_RUN** | No disposable staging test evidence. |
| Real off-network; 24h soak | **NOT_RUN** | No authorized staging environment/time-series evidence. |
| NAVEAX and Work-PC distinct stable ID, status, correct owner | **EXISTING_AGENT_READ_ONLY_PASS / V2_NOT_RUN** | Existing v1.0.8 Agent devices online with distinct IDs; Connection v2 OAuth/device binding NOT_RUN. |
| Provider traffic, actual cost, quota hard-stop | **NOT_RUN** | No provider measurements; zero-cost cannot be guaranteed. |
| Candidate exact-head full CI, negative QA, static typecheck, coverage | **NO-GO** | Prior candidate `41826788848` CI FAILED browser-live; new CI explicitly runs AI-11/CLEAN-14/V2-07 negatives, exact-head status pending. |
| CORE P0 #1067/#1073 | **SEPARATE BLOCKER** | Connection v2 security cannot close CORE P0 tickets. |

## Acceptance runbook (not executed)
1. Disposable staging only. Snapshot known-good version, credentials and config; restrict provider traffic and disable production v2 feature flag.
2. OAuth connect, scoped token check, MCP initialize, owner device selection, verified read-only command and exact response.
3. Negative cases: 401, 403, wrong-device, revoked-token, host redirect, rebind/private/metadata address, stale/duplicate identity.
4. Loss tests: WebSocket disconnect, TCP half-open, DNS loss, interface switching, Hub restart, lost ACK, UNKNOWN without replay, explicit rollback.
5. Windows disposable VM: service/task identity, start/stop, child cleanup, rollback and reboot.
6. Isolated provider traffic: 101+ authenticated WSS, 1GiB transfer hash, off-network clients, 24-hour soak, rate/quotas/cost hard-stop. Record precise environment, exact SHA, command, exit code, action run/job ID and evidence artifact.
7. NAVEAX and Work-PC **read-only** stable identity and online status checks only after owner-approved remote access; no changes to registry, DNS, tokens, scheduled tasks, services, filesystem or credentials.

## Feature flag, credential rotation and rollback
- Keep Connection v2 **OFF** on production until all P0/P1 are GREEN and separately authorized.
- Retain the legacy Tailscale fallback, pinned installation artifacts, rollback version, sealed credential backup, and old device registration while testing.
- On staging failure: prevent new v2 sessions, revoke disposable staging tokens, stop only the staging candidate processes, restore pinned staging config/artifact. Preserve UNKNOWN receipts, never replay a mutation merely because ACK was lost.
- Rotate staging credentials with a verified expiry/revocation procedure; do not rotate production secrets within this integration work.
- **No main merge, release tag, deploy, paid billing activation, issue closure, branch deletion or live two-PC cutover.**

**Final decision: NO-GO until exact-head tests, source owner review and physical/off-network acceptance are proven.**

## 2026-11-04 exact-head acceptance evidence (follow-up)
- Previous integration SHA `c09ad208dfc34b18a6d91b2cb00a635939df2159`, CI run `41826788848`: Node22, Node24, WSL2, Linux-native, macOS and security-operational jobs SUCCESS; Windows `browser-live` job `126563449512` FAILED (exit code 1).
- Four Windows negative failures: Cloudflared credential SID/DACL/ACE custody; official image/native immutable launch guard; OAuth doctor metadata/tool readiness; task parent/descendant cleanup.
- Previous integration Relay QA `41826788911`: Windows and Linux Node22/24 4/4 SUCCESS. The updated seven-source candidate needs its own exact-head result.
- The earlier general Node jobs did not actually run several AI-11/CLEAN-14 top-level negative test files. Added explicit fail-closed Linux and Windows security-oracle CI steps. Failed negatives remain RED and cannot be hidden by general green suites.
- NAVEAX device `adc90bbb-9576-4b4c-b76a-600e5572ad7d` and Work-PC device `aeaa5295-0aa8-4742-bf0c-2a6340dcf187` online on Native Agent 1.0.8 at read-only inspection; different stable device IDs, native Agent and Broker tasks Running. No production modifications, no v2 deployment/reboot.
- #1084 Windows 20-cycle task start-stop uses explicit disposable VM flag `NEXOWIRE_V2_04_DISPOSABLE_WINDOWS_VM=YES`. It is not run by hosted Actions and does not count as physical PASS.
