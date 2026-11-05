# Connection v2 | Round 4 final source refresh — authoritative checkpoint

**NO-GO.** Sources #1044 `b7c39dbdade38a0a1cf3a69299b1d9677cf0a5e9`, #1077 `b0bdfbced25364ad26473c24bb23f9d5cf249805` and #1083 `2b2a1b7e4199705a78a4a8ca4d19e6aca7d7cca3` are frozen for this coordinator commit.

- Preservation matrix: 78 PR/file rows, 70 distinct source paths, {"MERGED_MAIN_SECURITY_REVIEW_REQUIRED":4,"EXACT_BLOB":64,"EVOLVED_SOURCE_SEMANTIC_REVIEW_REQUIRED":10}. Source owners have not approved 14 non-exact entries. Git and CI must run on the new HEAD.
- The latest #1077 **native held-handle WinVerifyTrust** probe, MSVC `wintrust.lib` build fix, read-only Windows PowerShell7/5.1+WDAC inventory and mandatory `productionLaunchGO=false` CI gate are integrated as exact source blobs. The test probe always terminates suspended child without resuming; it is **not** a signed native production launcher.
- Official Cloudflared SHA256 and Authenticode remain required, P1-D SID/DACL/ACE inherited-parent checks remain strict, and public P1-C HTTPS/DNS admission stays unchanged. Full positive Windows credential fixture evidence is pending this exact candidate's `browser-live`.
- #1044 original native Windows negative assertion names 6/6 preserved plus fixed PowerShell 7/5.1 encoded-command diagnostics. #1083 original 7/7 revocation assertions preserved plus three strict registration negatives. The remote-only Hub Broker construction binds mandatory strict mode; V2-03 source-owner approval is pending.
- Existing Round3 `MUTATION_STATE_UNKNOWN`, cloned-runbook no-replay O_EXCL journal and 22-case CLEAN-10 Windows acceptance are preserved without code changes.
- Real staging: off-network OAuth/MCP completion, 2-PC v2 acceptance, actual reboot/rollback, provider egress hard stop, 1GiB/24h soak **NOT_RUN**.
- Production feature flag OFF, Tailscale fallback preserved, no NAVEAX/Work-PC writes or credential/DNS changes, no billing, main merge or release tags.

## Earlier round ledger (historical source SHA snapshots, not current acceptance)

# Connection v2 | Round 4 security-source integration checkpoint

**Decision: NO-GO**. Only #1085 Draft coordination branch is changed. No main merge, production deploy, live NAVEAX/Work-PC write, DNS, Cloudflare account or credential mutation.

- Prior coordinator HEAD: `ebc8029d15a948a4e3a0003df1301e6b21f47a77`. This Round4 commit integrates source snapshots #1044 `e431f6854e743982475fc513295881ed16a7fe92`, #1077 `8405c44cbc60205f33d47a8525eea7e3fbf9541f`, #1083 `2b2a1b7e4199705a78a4a8ca4d19e6aca7d7cca3`.
- Preservation matrix: **76 PR-path rows / 68 unique source paths**; `{"MERGED_MAIN_SECURITY_REVIEW_REQUIRED":4,"EXACT_BLOB":62,"EVOLVED_SOURCE_SEMANTIC_REVIEW_REQUIRED":10}`. No source test name was removed (V2-06 6/6, CLEAN-13 3/3, V2-07 7/7 preserved). Security source old commits remain Git ancestors; manual CI merge is explicitly marked, no synthetic PASS.
- Source #1044 Windows encoded-command PowerShell 7/5.1 runner diagnostics: added exact blob, no changed old assertion lines. Source #1077 native Windows CREATE_SUSPENDED/FileIdInfo probe C code, MSVC build script, new independent held-image negative, strict Cloudflare publisher and credential SID/DACL chain: exact blobs imported. Native probe remains test-only and never authorizes a Windows cloudflared launch.
- Source #1083 strict `AgentBroker` requires per-socket verifier before AUTHENTICATED_ONLINE when opted in. `src/runtime.ts` opts into strict authorization when `remoteAgentAuthOnly===true`, consistent with existing public Cloudflare publication gate and `src/hub/agent-websocket.ts` session checks. Public strict-mode unit test added to Windows/Linux Node22/24 independent CI. #1003 owner confirmation pending.
- Existing #1074 `normalizePublicControlPlaneAuthority()`, pre-credential Cloudflare admission, OAuth/MCP ingress, #1075 unchanged CLEAN-10 mandatory oracle and Round3 durable owner/device journal remain intact.
- Last SHA `ebc8029d15a948a4e3a0003df1301e6b21f47a77`: `41991273960` CI **FAILURE** due Windows V2-06 Node22/24 and browser-live P1-D; CLEAN-10 Node22/24 PASS, native Git DAG 73/73 PASS. Relay `41991273873` 4/4 PASS; Release Readiness `41991273889` SUCCESS (packaging, not security).
- #1077 source itself had failed CI `41989954395`; integrating new test-only native probe does not grant P1-A/B/D GREEN. Require exact-HEAD full Windows P1-D owner-only positive, foreign inherited ACE denial, hardlink/junction, signer, sealed-image tests before any security acceptance.
- Source owners #1003, #1044, #1077 and #1083 semantic review: **PENDING**; no approval is inferred from zero reviews.
- New exact SHA CI/native Git DAG, Windows/Linux Node22/24, browser-live and Relay: **NOT_RUN** until GitHub Actions runs after coordinator commit.
- External named Cloudflare tunnel, OAuth/MCP read-only completion, 101+ *off-network* WSS, two-PC v2 authentication, reboot/rollback, 1GiB verified transfer, 24h soak, provider egress quota/cost: **NOT_RUN**.
- Rollback: v2 production feature flag stays OFF and existing Tailscale fallback preserved. In isolated staging only stop candidate processes, revoke only staging tokens, restore pinned config/artifact and preserve UNKNOWN receipts without redispatch.

## Security source-to-candidate semantic decisions

| Candidate file / group | Decision | Owner review |
|---|---|---|
| `src/core/agent-broker.ts` | Latest #1083 strict registration, per-mutation authorization and socket epoch; exact source blob | PENDING |
| `src/runtime.ts` | Coordinator-only strict remote-only mode instantiation; local Agent legacy unchanged | #1003 PENDING |
| `src/mcp/cloudflare-binary-trust.ts` | Latest #1077 SHA, Authenticode and missing-production-custodian denial | PENDING |
| `src/mcp/cloudflare-credential-custody.ts` | Latest #1077 Windows SID/DACL/ACE and ancestry, no permission relaxations | PENDING |
| `test/clean13-cloudflared-windows-custody.test.ts` | Original three assertions retained with diagnostic envelope | PENDING |
| `native/windows-cloudflared-image-probe.c`, `scripts/build-windows-cloudflared-image-probe.ps1` | Test-only MSVC helper, never release an executable | PENDING |
| `test/v206-round2-windows-native-reason.test.ts` | Original six assertions retained, adds Windows native prerequisite diagnostic | PENDING |
| `.github/workflows/ci.yml` | Existing tests kept, native probe built only in disposable browser-live job and new strict broker test in Round2 matrix | PENDING |
| `src/mcp/local-first-cloudflare.ts` | Existing P1-C strict public canonical HTTPS plus P1-B/D ordering unchanged | PENDING |
| `src/agent/runbooks.ts`, `src/agent/runbook-effect-journal.ts` | Round3 durable UNKNOWN and no-replay kept byte-identical | CLEAN-10 prior PASS, current SHA pending |

---

# Connection v2 | Round 3 P0 CLEAN-10 checkpoint

**NO-GO.** The following is a candidate-only patch set for #1085 Draft. A passing historical unsafe exploit oracle is not equivalent to a positive security proof.

- Baseline coordinator HEAD: `206615686c249a11c10498d1b809d87789ef69ad`. Round 3 consists of separately reviewable (1) durable UNKNOWN classification and (2) semantic effect identity, dispatch-preceding journal reservation and owner/device binding, followed by QA/CI evidence changes.
- Original #1075 CLEAN-10 mandatory negative remains exact blob `720565cf8821f9ceea9e5ca6101c0213558a1c09`; do not skip or weaken. Historical QA-18 now asserts fail-closed behavior instead of exploiting the old bug, source blob retained in Git ancestry.
- Cross-runbook cloned semantic mutation never dispatches twice without *independent* authorized fresh intent. Journal is a non-expiring O_EXCL tombstone; corruption/missing reservation state cannot be presumed safe. A raw `retry_unknown` flag or rotated runbook ID cannot supply owner approval.
- Round3 test matrix: mandatory CLEAN-10 lost ACK, 32-way concurrent O_EXCL, restarts, canonical input, owner/device mismatch, corrupt/unavailable journal, missing owner grant, separately verified fresh user intent and one-time receipt, plus original QA-02 output ordering test **unchanged**.
- QA-02 prior root cause: Windows native Job owner helper absent `WINDOWS_JOB_HELPER_UNAVAILABLE`, independent of CLEAN-10. New CI builds `scripts/build-windows-job-owner.ps1` before the physical pipe-ordering assertion. No fallback to unmanaged processes.
- P1 owners advanced since frozen integration: #1044 `e431f6854e743982475fc513295881ed16a7fe92`, #1077 `31fc77e7076ca9be255e71059478b0dec3a6e299`, #1083 `2b2a1b7e4199705a78a4a8ca4d19e6aca7d7cca3`. These source changes require separate semantic review; **no automatic source overlay** during this P0 patch.
- Original 73 source PR/path records preserved. Candidate changes to `src/agent/native-agent.ts`, QA-18 and CI explicitly classified as evolved/merged; new source files are coordinator-owned and not falsely counted as exact source blobs. Matrix counts: {"MERGED_MAIN_SECURITY_REVIEW_REQUIRED":4,"EXACT_BLOB":59,"EVOLVED_SOURCE_SEMANTIC_REVIEW_REQUIRED":10}.
- Critical remaining requirements: exact SHA Linux/Windows Node22/24 CI, native Git DAG, source owner approval, Windows journal SID/DACL verification, trusted fresh owner-intent issuance, public P1-B/P1-D, off-network MCP staging, genuine reboot/rollback, provider cost/soak: **NOT_RUN / NO-GO until proven**.
- Rollback: v2 production remains disabled, prior Tailscale connection untouched; on disposable staging only stop candidate, revoke disposable tokens, restore pinned artifact/config, never auto-replay UNKNOWN.

Full design: `docs/connection-v2/round3-clean10-effect-identity.md`.

---
# Connection v2 | Round 2 authoritative release gate

**Decision: NO-GO.** #1085 remains Draft. Eight immutable source commits integrated, not approved for production.

- Coordinator parent `5c2155f259798f71f352482c4cddc87b3e156b0e`; base main `939b4d6beecf996f2750c736c5d4b4beb7b64488`. Source snapshot: #1003=`17b699084ad90cc929db83b5942eed812e80cd83`; #1044=`48704c908636383d63e6284082f167f1909124d0`; #1074=`6b00db5bb24e537a6d1c494b3459080a8af3f943`; #1075=`05a99388c377caa0781fb5a2c257ea1f9b92e5df`; #1077=`384c05276d2c0116ee13f7b70d6709cdb478f887`; #1081=`a28995c25b5575636c929b09d1f6e7c4d9b33e5c`; #1083=`136627e161872f534dfc30242e59223b378dce09`; #1084=`f4f80a76a186e84433ae4be6aed829a21d990a0c`.
- Source preservation: **73 entries / 65 unique paths**, {"MERGED_MAIN_SECURITY_REVIEW_REQUIRED":4,"EXACT_BLOB":61,"EVOLVED_SOURCE_SEMANTIC_REVIEW_REQUIRED":8}. 12 non-identical records require original file-owner semantic approval. New exact SHA DAG and CI **NOT_RUN**.
- On previous SHA `5c2155f259798f71f352482c4cddc87b3e156b0e`: native Git DAG `41853910953` / job `126657229931` PASS, `git merge-tree` exit 0, `patch-id` exit 0, cherry 148, source/candidate 73/73. Dedicated Relay QA `41853910766` 4/4 SUCCESS, Windows/Linux Node22/24.
- CLEAN-10 Windows22/24 job IDs `126657230114`/`126657229916` **FAIL**: UNKNOWN incorrectly becomes FAILED, cloned runbook dispatches same uncertain mutation, Windows QA-02 output ordering fails. Ubuntu package `126657236904` also failed CLEAN-10. This is actual no-replay P1 blocker, not a waived test.
- V2-06 Windows-native negative suites `126657230093`/`126657230145` **FAIL**, including official test binary not provisioned and PowerShell/ACL fixture errors. New independent Windows-only official SHA256 fixture provisioning added to coordinator Round2 job; remaining native failures still block release.
- Previous Windows browser-live `126657230375` had not completed at last evidence check; P1-B/P1-D is not GREEN. Prior 20/20 disposable Windows Task cycles and 101+ local WSS remain limited on-premise acceptance proxies, not external proof.
- Real named tunnel, off-network OAuth token and MCP initialize, owner/device read-only execution, 401/403, revocation in-flight over public network, device reboot/rollback, 1 GiB transfer, 24h soak, real provider egress/billing hard-stop: **NOT_RUN**.
- Rollback: production v2 feature flag OFF; keep Tailscale fallback; in disposable staging only stop candidate, revoke staging tokens, restore pinned config/binary, preserve UNKNOWN mutation receipts without replay. No main merge, release tag, source branch updates or NAVEAX/Work-PC changes.

## Outstanding semantic security review
- `src/mcp/local-first-cloudflare.ts`: #1077 publisher/custody/identity checks and strict #1074 public control-plane HTTPS admission combined without weakening (owner signoff pending).
- `src/core/agent-broker.ts`: #1083 mutation reauthorization exact blob; separate CLEAN-10 cross-runbook no-replay still RED.
- `src/hub/hub-lifecycle.ts`: new #1084 Windows task identity/fallback; real reboot/rollback unproven.
- `.github/workflows/ci.yml`: original main and adversarial suites preserved, plus Windows official fixture with SHA256 pin; test outcomes, not binary hash alone, decide GO.

## Historical release ledger (archived; do not treat old NOT_RUN table as current)

# Nexowire Connection v2 | Release candidate gate

**Verdict: NO-GO. This is a Draft-only source integration, not a release.**

## Frozen source snapshot
- Candidate identifier: `1.0.8-connection-v2-rc.0+939b4d6` (no release tag)
- Current main parent: `939b4d6beecf996f2750c736c5d4b4beb7b64488`; old #1003 base: `a19a228dc6f19fd484cf935e941a00ea625233f8` (62 main-side commits)
- Source HEAD snapshot: #1003 `95d9f9e431ad5a9c46adde1ecf716f84d60d8455`; #1044 `d38b30fec77cce5c9b5e29c491b11f8fe6806bef`; #1074 `5997a6d7ae43c34170016eb0963718ee35bf4a15`; #1077 `67fa411c6aa6135aeeac93f7197b5fd46c804884`; #1081 `707db9728c883d1bb027788793f4cc072768f325`; #1083 `4d8e7b359d572a6ee4cf22fd02ad9ee7ed81808e`; #1084 `03e8507c2d6b18742a6a337356f3d5bb19da6f22`.
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

## Candidate CI metadata correction
- Exact SHA `524497acee4d2078828019eb99ff4ad5d8b418df` CI run `41829279333`: `test (24)` failed before adversarial steps because preservation matrix still referenced pre-Oracle `ci.yml` blob; `two_pc_read_only` had an ambiguous non-`NOT_RUN` value. Updated candidate matrix to actual Git blob SHA and restored strict `NOT_RUN` for unperformed v2 acceptance. This change is **not** a security PASS.

## V2-04 source refresh
- #1084 Windows recovery source advanced by three commits: `84cfcaa...` → `03e8507c2d6b18742a6a337356f3d5bb19da6f22`. `src/mcp/cloudflare-connection-lifecycle.ts` and `test/cloudflare-connection-lifecycle.test.ts` exact new blobs incorporated. Previous candidate CI remains attached to its original SHA; successor must pass its own checks.

## Separate Windows negative oracle (latest coordinator patch)
- Prior exact SHA `aa4fc209ac4fd8486bf4dd68b65238a9f0584994`, CI `41830183272`: Windows browser-live ended RED at the first newly added negative job step, leaving downstream Cloudflared custody/Task validation unexecuted.
- Split Windows CI into independent matrix job `connection-v2-negative-windows` on Node 22 and Node 24. Existing `browser-live` original Cloudflared credential custody, native image and Windows process cleanup tests remain intact and can now run separately. Both jobs **must pass**. Current new exact SHA result is pending.

## V2-04 refresh at 03e8507c2d6b18742a6a337356f3d5bb19da6f22
- Exact latest four #1084 source blobs carried into the coordinator candidate; source branch unchanged.
- Windows PowerShell task code uses UTF-16LE `-EncodedCommand`; revised tests avoid bare-PID kills and may run 20 real Scheduler cycles on GitHub disposable Windows runners when `RUNNER_ENVIRONMENT=github-hosted`. This is **NOT_RUN until matching CI emits the cycle evidence**. Reboot/logoff remain NOT_RUN.
- Any previously completed CI run belongs to its previous exact SHA and cannot approve the refreshed candidate.

## Coordinator-only P1-C hardening proposal (not yet accepted)
- Added public Cloudflare admission guard using existing `normalizeControlPlaneBase()` and HTTPS requirement in `src/mcp/local-first-cloudflare.ts`. This is a candidate-only integration correction, not an owner branch edit.
- Bound the WebSocket session's real authorization checker to `AgentBroker.register()`, and invoked it at each mutation admission before queuing or sending. A revoked credential, verifier failure, or changed socket epoch must fail closed, with no mutation replay.
- Existing original AI-11 and CLEAN-14 negative tests remain unchanged. **P1-C stays NO-GO until exact-head CI shows them GREEN on both Linux and Windows, and source owners review the 3 candidate-only changed files.**

## P1-B Windows provenance ordering / source-owner approval pending
- Candidate-only early Windows `prepareTrustedCloudflared()` precheck runs before credential read or Hub probe, preventing a profile-matching SHA of an unrelated executable from being treated as publisher proof. Windows native immutable-image launch remains denied without signed handle custodian.
- Prior exact SHA `89d9c336e8a6587069f32a4ea00befbb649692ca`: Linux Node22/24 general CI SUCCESS, Node24 explicit security negative 60/60 PASS (CI `41834121454`, job `126588539754`). Windows 22/24 explicit suite has only P1-B publisher assertion RED, not waived.
- GitHub-hosted disposable Windows VM on previous SHA `e9e598dbf689cb4e063ce5b5d4ce430ef7e58804` run `41833352347`, job `126585876171`: **20/20 real Scheduler start-stop/descendant cleanup cycles PASS**. Reboot/rollback NOT_RUN. Cloudflared Windows P1-B/D remains a separate blocker.

## Native Git DAG evidence gate (candidate-only CI)
- Added `connection-v2-native-git-dag` Linux CI job gated to coordinator PR branch only; full-history checkout at **exact PR head SHA**.
- New `test/connection-v2-release-gate/git-native-dag.mjs` executes real `git merge-base`, `git cherry -v`, `git patch-id --stable`, `git merge-tree --write-tree --messages`, ancestry and all 54 source/candidate blob checks. A conflict or mismatch is RED, never auto-resolved.
- Evidence artifact `connection-v2-native-git-dag.json` is produced even on a failed job. Until a matching Actions run exists, native Git checks are **NOT_RUN**. A DAG PASS alone never grants production GO.

## Latest V2-04 source refresh / native Git prior-run evidence
- #1084 advanced one commit `385109b87c22ae677ba06f517b7872b732b142dc` → `03e8507c2d6b18742a6a337356f3d5bb19da6f22`; exactly three modified source files were imported as Git blobs and matrix source heads refreshed. #1084 branch remains unchanged by coordinator.
- Native Git DAG at **prior** candidate `e3384c89001f49ca1a525ff04639752b23f35c6a`: CI `41835856330` job `126594742469` PASS, `merge-tree=0`, `patch-id=0`, `cherry` 110 records, all 54 source + candidate blobs match. Artifact retained. New exact SHA requires its own DAG job.

## Completed exact-head CI and refreshed V2-04 owner source (2026-11-04)
- Previous coordinator `06a3d58fa0c7b98764b2aaaa9cb5a6d16651dffb`: CI `41836378207` **FAILURE**. All nine other jobs PASS, but Windows `browser-live` job `126596782011` exit 1 with four security/compatibility failures: P1-D ACL on owner-only disposable fixture, P1-B signed official image/immutable custodian, Windows foreign task refusal reason, and checksum/credential identity error precedence. Do not suppress tests or treat a fail-closed rejection as the expected security proof without testing the intended boundary.
- Native Git DAG job `126596782124` exact SHA SUCCESS: merge-tree exit 0, stable patch-id exit 0, cherry 111, source blob 54/54, candidate blob 54/54. Relay Windows/Linux Node22/24 run `41836378051` 4/4 SUCCESS. Release Readiness `41836378072` SUCCESS is packaging only.
- Real TLS loopback WSS benchmark has 101 authenticated admissions and 101 read-only AgentBroker ACK completions on all four Node/OS combinations, 128 connection cap, 129th attempted connection rejected by 503, and 256 attempt scenario capped at 128. Exact CPU/RSS/latency samples stored in `staging-evidence.json`. No external hosting, 1 GiB file transfer or 24h soak was exercised, and whole-process memory/CPU must not be mislabeled relay-only provider cost.
- #1084 latest `03e8507c2d6b18742a6a337356f3d5bb19da6f22` adds allowlisted, non-sensitive PowerShell task refusal-token reporting in `src/mcp/cloudflare-connection-lifecycle.ts`; one source blob updated, all original assertions unchanged. Previous completed CI is evidence for **previous** SHA only; new candidate exact SHA checks required.

## Windows P1-B official signer diagnostic, isolated coordination QA
- In Windows `browser-live`, immediately after downloading and verifying the pinned official SHA256 of `cloudflared-windows-amd64.exe`, a read-only `Get-AuthenticodeSignature` observation now emits `NEXOWIRE_P1B_WINDOWS_SIGNATURE_DIAGNOSTIC` with signature **status**, signer-present and subject-matches-Cloudflare booleans only. No certificate, credential or private path text is printed.
- This is a **diagnostic**, not a substitute for signed-publisher trust or held-image custody. Every existing CLEAN-13 negative assertion remains unchanged and still controls CI. Signature status and exact-head test result remain **NOT_RUN** until the new candidate's Windows job logs confirm them.
