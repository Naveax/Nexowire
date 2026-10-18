# Connection Core v2: production acceptance ledger (2026-10-18)

Status: **STAGING / DRAFT — not production-accepted**.

Repository: Naveax/Nexowire. PR: https://github.com/Naveax/Nexowire/pull/547
Branch: fix/parallel-06-connection-recovery-20261018
Verified preceding PR HEAD: 4bb72b47132ba53c5f8413915888b471a81a521f
Previous exact-head GitHub CI: 39150296541, completed SUCCESS, seven jobs passed.
Main integrated in this branch: 8660ac1fa9ec38fd81488a48b34affcb7d71fe65
Merge commit: 56224b3dc61faaccd9d47e5434a5fbf8143eaef9

The two competing file owners in current main, src/agent/native-agent.ts and
src/providers/agent-provider.ts, were merged without conflict. Existing Journal
v2, ERROR CONTRACT v2, Agent outcome / reconciliation code is retained.

## Source boundaries

- ChatGPT -> MCP Hub HTTP(S) -> authenticated per-device native WebSocket.
- The Agent keeps its existing outbound websocket and optional Tailscale/Cloudflare routes.
- The local fault injector implements *only* two ephemeral 127.0.0.1 listeners
  (mock /agent Hub and a WebSocket forward proxy) and synthetic device IDs.
- The injector hard-rejects forwarding to any hostname other than 127.0.0.1,
  any scheme other than ws, or any remote path other than /agent.
- No existing Native Agent, Hub, Windows service, tunnel, local DNS, firewall,
  Tailscale state or Cloudflare config was stopped, rewritten or reconfigured.
- No direct P2P support is claimed for ChatGPT MCP. The transport label is
  websocket, not P2P.

## Transport / negative acceptance matrix

| Fault | Observed / asserted behavior | Evidence |
| --- | --- | --- |
| Delayed ACK for mutation | Proxy holds simulated Agent ACK; Hub must return MUTATION_STATE_UNKNOWN, never auto-dispatch after same instance reconnect | test/connection-fault-proxy.e2e.test.ts |
| Offline device | No dispatch to another device by name or alias | test/connection-recovery-faults.test.ts |
| Two devices | One synthetic device disconnects; other in-flight request completes; read-only request resumes on exact original device and requestId | Both tests |
| Same device / duplicate WSS | Hub socket epoch increments, stale connection cannot send authoritative ACK/event, mutation not resent | Both tests |
| Instance changed | In-flight mutation returns AGENT_INSTANCE_CHANGED, no blind replay | test/native-session-continuity.test.ts |
| Read-only reconnect budget | Original request ID and deadline retained, max retries bounded | test/connection-recovery-faults.test.ts |
| Capability removed | AGENT_CAPABILITY_CHANGED, no reroute | test/connection-recovery-faults.test.ts |
| Forged ACK by other authenticated device | Rejected, no pending resolution | Both tests |
| Credential revoked then reconnect | Once the isolated proxy breaks the old route, **fresh** authenticated handshake is refused; existing mutation result remains UNKNOWN, not auto-replayed | test/connection-fault-proxy.e2e.test.ts |
| Active WebSocket after revocation | **NOT ACCEPTED:** token invalidation of an existing open WSS session has not been demonstrated. S2 Public WSS owner/revocation acceptance must prove this. | S2 #537 / WSS stream |
| Loss of all relay paths / real NAT / network outage | **NOT ACCEPTED:** real hardware cutover and production route interruption prohibited by this PR | Future owner-approved staging |
| Hub restarts during mutation | **NOT ACCEPTED END-TO-END:** persisted Hub unknown state and Agent journal reconciliation code now present on main, but no live version-matched Hub restart tested | Journal v2 / main integration |

## Read-only physical device evidence

On current first-party Nexowire route (Agent v1.0.5, existing binaries only):

| Device | Exact device ID | Platform | Read-only machine.health | UTC time |
| --- | --- | --- | --- | --- |
| Naveax | adc90bbb-9576-4b4c-b76a-600e5572ad7d | Windows 11, 22631 | PASS | 2026-10-18T18:18:37.976Z |
| Work PC | aeaa5295-0aa8-4742-bf0c-2a6340dcf187 | Windows 10, 19045 | PASS | 2026-10-18T18:18:42.621Z |

These are fresh separate authenticated read-only RPC responses, not sustained
uptime, deployed build provenance, or a physical reconnect test. Both live
Agents remain version 1.0.5 per device listing. Repository commits were NOT
automatically installed on the physical devices.

## Separate path-policy workstream

Related **PR #553** (not a GitHub issue):
https://github.com/Naveax/Nexowire/pull/553

Prior Windows full test failures included a separately reproduced mismatch:
TEMP and TMP are D:\Temp. Existing workspace-intelligence tests attempt to
resolve the D:\ ancestor under a narrow PathPolicy root and return PATH_DENIED.
This is NOT fixed by Connection Core. The filesystem security owner must
classify whether this is a test fixture/canonicalization issue and ensure that
no path-policy grant is weakened. No file permissions, filesystem-policy code,
USB volume logic, process shell bypass or admin rights are changed here.

## Remaining release gates

1. Exact-head CI on the latest PR SHA, including branch updated against main,
   with Linux/Windows/WSL/macOS and security jobs traced to the same SHA.
2. Windows local comprehensive regressions: classify known environmental
   failures separately from transport regressions, without masking failures.
3. Revoke *already-open* WSS sessions on effective owner/device/token
   revocation and prove bounded delay/no alternative route; S2 owner scope.
4. Safe Hub restart / WAL recovery / reconciliation end-to-end under a
   version-matched staging deployment. Unknown mutation can never imply
   successful task completion or automatic replay.
5. Owner-approved physical fault tests for both PCs with explicit recovery
   window, signed binary provenance, rollback plan and no competing Agent.
6. Cloudflare/Tailscale failover or P2P only after separately authorized
   authentication, tenant-isolation and capacity-cost acceptance.

No PR merge, agent update, DNS / firewall changes or service restart occurred.


## Latest main synchronization and Windows regression triage

A second conflict-free merge integrated main SHA
c2d4c7084b2a5173c67e8567745f00f1dc66ee7c, producing branch merge
68019ed6ba8d26e97eb6ec16ea4516963520d5bd. No Connection Core files
were overwritten during the second merge. After this merge, typecheck PASS,
build PASS and **80/80** targeted cross-module tests PASS (Node WSS fault
proxy, session continuity, credential checks, Broker, provider, Agent
reconciliation, WAL integrity, MCP idempotency, Error Contract and metrics).

The broader local Windows suite was run after the initial integration of
main 8660ac1fa9ec38fd81488a48b34affcb7d71fe65. It had **1841 tests:
1754 PASS, 56 FAIL, 31 SKIP**. This is an explicit RED local acceptance
gate, and is not an exact-head green run for the later merge.

Failure classes from the saved log (not blanket-dismissed as environmental):
- 16 tests failed with WINDOWS_JOB_HELPER_UNAVAILABLE; the native Windows
  Job owner executable was not present for tests that require it. This is
  process-manager / helper packaging scope, not a transport-layer bypass.
- Existing TLS/OpenSSL owner-WSS and public signed WSS fixture tests failed
  while generating local temporary certificates; certificate tooling/SAN
  assumptions require independent verification.
- Two test-worker fixtures failed loading TypeScript with
  ERR_UNKNOWN_FILE_EXTENSION. Their worker bootstrapping must be tested in
  the correct CI environment.
- Private GUI/Win32 input tests, runtime ACL/publisher trust, process
  lifetime and rollback tests also failed. These are **unresolved**, not
  automatically waived by the 80/80 Connection Core result.
- The D:\Temp / PathPolicy ancestor mismatch occurred again in
  workspace-intelligence tests. This is cross-referenced to
  https://github.com/Naveax/Nexowire/pull/553 and must be repaired in the
  filesystem path safety workstream with its full security policy preserved.

Saved developer-machine log:
D:\Temp\nexowire-pr547-merged-fullsuite-20261018.log
This file remains on the local authorized development machine. It is not
a production log, and is not copied to GitHub as it may contain machine paths.

The most recently committed PR head before this report and fault proxy was
4bb72b47132ba53c5f8413915888b471a81a521f, whose GitHub Actions run
39150296541 had 7/7 SUCCESS. Newly pushed commits need independent exact-HEAD
CI verification and are not covered by that earlier green run.


## Integration race / follow-up provenance

**IMPORTANT:** Original PR #547 was merged by the integration owner at
2026-10-18T18:28:47Z with head
4bb72b47132ba53c5f8413915888b471a81a521f.
The proxy fault-injector and this ledger were committed **after** that merge
as original-branch commit 7597c20324ddb3c64d23744845016f213083d7c1.
They were **not** in the #547 merge.

To prevent rewriting a merged PR, the exact two-file delta was cherry-picked
onto a new clean worktree/branch:
fix/parallel-06-connection-fault-acceptance-20261018
Base main: ca7fc2c457cd47181e5b5d6c4db7b0ac32698838
Cherry-pick commit: 0c2175ebc6d5f913ab78d64ceea5cb04dabe4540

The original Connection Core runtime corrections are in main via PR #547.
This new review contains only test/connection-fault-proxy.e2e.test.ts and
this acceptance ledger. It does not redeploy or restart the Agent, Hub,
Broker, Cloudflare tunnel or Tailscale.

**CI must be judged from the follow-up PR exact HEAD**, not the former
PR #547 run 39150296541. Physical production reconnect and active-session
revocation remain blocked.
