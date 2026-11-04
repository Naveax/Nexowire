# Nexowire Connection v2 | Release candidate gate

**Verdict: NO-GO. This is a Draft-only source integration, not a release.**

## Frozen source snapshot
- Candidate identifier: `1.0.8-connection-v2-rc.0+939b4d6` (no release tag)
- Current main parent: `939b4d6beecf996f2750c736c5d4b4beb7b64488`; old #1003 base: `a19a228dc6f19fd484cf935e941a00ea625233f8` (62 main-side commits)
- Snapshot heads: #1003 `bf9e54227f6dc19bcca440718dc822c2af91e318`; #1044 `835d17e05e7d06c7ea30b53635dec2a34e7f8968`; #1074 `5997a6d7ae43c34170016eb0963718ee35bf4a15`; #1077 `67fa411c6aa6135aeeac93f7197b5fd46c804884`; #1081 `707db9728c883d1bb027788793f4cc072768f325`
- Git DAG: commit with six parents (current main plus five frozen source heads). Original branch refs are untouched.
- Selected source paths: **40**, preservation rows **45**. Status distribution: `{"MERGED_MAIN_SECURITY_REVIEW_REQUIRED":4,"EXACT_BLOB":38,"EVOLVED_SOURCE_SEMANTIC_REVIEW_REQUIRED":3}`. See `source-preservation-matrix.csv`.
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
| Lost ACK / UNKNOWN / no-replay | **NOT_RUN** | V2-07 dedicated PR not included in frozen source snapshot. |
| Windows Task Scheduler guardian, child cleanup, reboot, recovery, rollback | **NOT_RUN** | V2-04 dedicated child PR not included; no live OS mutations allowed. |
| Off-network OAuth, token validation, MCP initialize, device select, harmless read-only tool | **NOT_RUN** | Real external provider flow not captured. |
| Relay Windows/Linux, Node 22/24 | **SOURCE_PASS_ONLY** | #1081 prior relay QA `41821338857` 4/4 success, not integrated exact SHA. |
| 101+ authenticated WSS; overload; 1GiB verified transfer | **NOT_RUN** | No disposable staging test evidence. |
| Real off-network; 24h soak | **NOT_RUN** | No authorized staging environment/time-series evidence. |
| NAVEAX and Work-PC distinct stable ID, status, correct owner | **NOT_RUN** | Live device read-only checks not performed. |
| Provider traffic, actual cost, quota hard-stop | **NOT_RUN** | No provider measurements; zero-cost cannot be guaranteed. |
| Candidate exact-head full CI, negative QA, static typecheck, coverage | **NOT_RUN** | New candidate actions must finish before acceptance. |
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
