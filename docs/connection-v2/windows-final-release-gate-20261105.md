# NEXOWIRE AI-10 — Final Windows Release and Security Gate

**Audit date:** 2026-11-05 (Europe/Istanbul)  
**Decision:** **PRODUCTION NO-GO**  
**Audit subject, immutable code SHA:** `25227d0d3361e95d6cf79679212bd81dc4c2a08f`  
**Repository main SHA at audit:** `939b4d6beecf996f2750c736c5d4b4beb7b64488`  
**Integration PR:** [#1085](https://github.com/Naveax/Nexowire/pull/1085), `coord/connection-v2-release-candidate-20261104`, OPEN/DRAFT, not merged to main.  
**Scope:** Windows 10/11, NAVEAX and Work-PC only. Linux/macOS jobs are not Windows acceptance evidence.  
**Classification rule:** CI PASS means its exact named checks passed; it is not production authorization.

## 1. Exact-head, directly inspected Actions evidence

| Job / workflow | ID | Observed outcome and scope |
|---|---|---|
| CI | [42087533258](https://github.com/Naveax/Nexowire/actions/runs/42087533258) | **16/16 SUCCESS**; includes Windows test Node22/24, native negative Node22/24, Round2 security Node22/24, CLEAN-10 Windows Node22/24, browser-live and native Git DAG. |
| Windows browser-live | [127456550959](https://github.com/Naveax/Nexowire/actions/runs/42087533258/job/127456550959) | **PASS**; Job Object helper, rollback fixtures, real NTFS owner/ACE, pinned Cloudflared signer, held-handle probe and fail-closed native launch denial. |
| Round2 Windows security Node22/24 | [127456551805](https://github.com/Naveax/Nexowire/actions/runs/42087533258/job/127456551805), [127456551514](https://github.com/Naveax/Nexowire/actions/runs/42087533258/job/127456551514) | **PASS**, 48 tests / 0 fail in each job. |
| Windows CLEAN-10 Node24/22 | [127456551519](https://github.com/Naveax/Nexowire/actions/runs/42087533258/job/127456551519), [127456551603](https://github.com/Naveax/Nexowire/actions/runs/42087533258/job/127456551603) | **PASS**; Node24 log 22 tests / 0 fail, lost-ACK UNKNOWN and cloned-runbook no-replay preserved. |
| Git-native DAG | [127456551475](https://github.com/Naveax/Nexowire/actions/runs/42087533258/job/127456551475) | **PASS**; log has `exact_sha=25227d0d3361e95d6cf79679212bd81dc4c2a08f`, `source_blobs:79`, `candidate_blobs:79`, `issues:[]`, merge-tree and stable patch-id exit 0. |
| Release Readiness | [42087533330](https://github.com/Naveax/Nexowire/actions/runs/42087533330) | **SUCCESS** for package checks. Windows user bundle/smoke PASS; tagged candidate attestation, publish, canonical tarball, release SBOM and tag/package match steps **SKIPPED**. No release published. |
| Relay QA | [42087533518](https://github.com/Naveax/Nexowire/actions/runs/42087533518) | **4/4 SUCCESS** in isolated Windows/Linux Node22/24 matrix; loopback QA is not off-network Cloudflare verification. |

These are facts about the **code SHA above**. Any subsequent documentation-only commit changes the PR HEAD and must have its own CI identity; do not reuse these green labels as exact-head CI for a newer SHA. No manual same-SHA workflow was dispatched by AI-10.

## 2. Git source provenance and actual merge status

The integration comparison from main has **210 commits ahead, zero behind and 85 changed files**, but remains a draft. Its source-preservation CSV has **79 rows: 56 EXACT_BLOB, 19 EVOLVED_SOURCE_SEMANTIC_REVIEW_REQUIRED, 4 MERGED_MAIN_SECURITY_REVIEW_REQUIRED**. The native Git check proves provenance/structure, not semantic sign-off for the 23 non-exact rows.

Source snapshots captured in the integration matrix:

| PR | Source HEAD | Scope |
|---|---|---|
| #1003 | `f1e5a5e4cadad8a276f7193932caf05f84196044` | Connection v2 / MCP / remote authorization |
| #1044 | `b7c39dbdade38a0a1cf3a69299b1d9677cf0a5e9` | adversarial P1 regression |
| #1074 | `6b00db5bb24e537a6d1c494b3459080a8af3f943` | public network/DNS/redirect P1-C |
| #1075 | `05a99388c377caa0781fb5a2c257ea1f9b92e5df` | CLEAN-10 no-replay oracle |
| #1077 | `b0bdfbced25364ad26473c24bb23f9d5cf249805` | P1-A/B/D Cloudflared proof/custody |
| #1081 | `a28995c25b5575636c929b09d1f6e7c4d9b33e5c` | Relay budget and throughput |
| #1083 | `20d4252eb10223a2c134aa25bba5107ed6a884f9` | reconnect, epoch, UNKNOWN |
| #1084 | `f4f80a76a186e84433ae4be6aed829a21d990a0c` | Windows task recovery / rollback fixtures |

All these source PRs were **open/draft** at review; inclusion in #1085 is **not** main merge/closure. No review submissions or inline review threads were recorded on #1085. #1073 (CLEAN-12 verified native ACK) is **merged into #1067's staging branch**, not main. #1067 CORE staging HEAD `c40ee2db1465d0ea457ffdc36dc9566b385d20b1` is still open/draft; exact-head [CI 42102010726](https://github.com/Naveax/Nexowire/actions/runs/42102010726) **7/7 SUCCESS**, but CORE is not composed into #1085.

#1086 SQLite Hub HEAD `af443d0dffec2b793ee3ce83d7e7fd2089de95f0` remains **open/draft** and absent from #1085. Its exact-head [CI 42038098864](https://github.com/Naveax/Nexowire/actions/runs/42038098864) is **7/7 SUCCESS** in the source branch, not the integrated combination. #1053, #1047 and #1048 are closed **without** being merged; they are not release-closure evidence.

## 3. Windows security acceptance matrix

| Control | Status | Exact reason |
|---|---|---|
| P1-A source image race negative / native FileIdInfo | **CI PASS; PRODUCTION BLOCKED** | `native/windows-cloudflared-image-probe.c` uses held source, WinVerifyTrust, CREATE_SUSPENDED and MEM_IMAGE readback but intentionally never resumes child. It does not attest a runnable kernel image-section binding. |
| P1-B SHA256 + Authenticode / issuer | **DISPOSABLE CI PASS; PRODUCTION BLOCKED** | Source-pinned official Cloudflared 2026.10.1 and hosted signer tests pass. There is no independently signed production launcher, enforced verified WDAC/UMCI policy, protected service launch path or actual enforced deny-event evidence. |
| P1-C public HTTPS/DNS/redirect/WSS | **CI PASS; OFF-NETWORK NOT_RUN** | IPv4/IPv6, CNAME/rebinding, private/metadata denial, 301/302/307/308 credential redirects, actual isolated TLS/WSS negatives pass. Real named Cloudflare tunnel and production remote authorization remain unaccepted. |
| P1-D Windows credential custody | **CI PASS; PHYSICAL NOT_RUN** | NTFS owner-only positive and foreign/inherited ACE negatives pass in hosted Windows. Full SID/DACL/parent/copy cleanup and tamper scenarios on authorized isolated target machines not yet accepted. |
| Windows Job Object / native task kernel identity | **HOSTED CI PASS; PRODUCTION BLOCKED** | Native guardian, managed process tree and rollback fixture checks pass. CORE branch has additional native attestations not composed here; production signed guardian identity and actual device reboot/recovery remain unverified. |
| Mandatory owner/device epoch + lease | **FAIL-CLOSED SOURCE; E2E BLOCKED** | Broker rejects missing verifier; authoritative public control-plane still needs independently confirmed ownerId/deviceId/epoch/lease response instead of legacy deviceId-only. |
| Revocation v. socket.send atomic effect fence | **BLOCKED** | Negative tests pass for current simulated paths; authority-owned atomic race closure across revocation and actual dispatch has not been demonstrated. |
| CAS / mutation UUID / durable UNKNOWN | **CI PASS; INTEGRATION BLOCKED** | CLEAN-10 lost ACK, restart, duplicate key and cloned-runbook negatives pass. Fresh externally authenticated owner intent and cross-Hub exactly-once handoff remain unavailable. |
| Windows semantic-effect journal SID/DACL | **NOT_RUN / BLOCKED** | Full platform-owner permission proof for `src/agent/runbook-effect-journal.ts` journal and historical migration is not independently accepted. |
| CORE verified native ACK | **SOURCE CI PASS; NOT COMPOSED** | #1073 merged only into draft #1067; independent #1085 combination with verified claims, native admission and destructive effects not tested. |
| SQLite Hub writer/anti-replay | **SOURCE CI PASS; NOT COMPOSED** | #1086 adds durable SQLite WAL/synchronous FULL, tombstone preservation, terminal-state immutability and single-writer identity. Neither main nor #1085 contains these changes. |
| Signed release artifact / Windows production installer | **NOT_RUN** | Tag, canonical release manifest/attestation and independent production signature gates skipped. Package smoke PASS does not authorize deployment. |

**Mandatory Windows Cloudflared gate:** `docs/security/CLEAN13_WINDOWS_PRODUCTION_LAUNCH_R4.md` expressly requires `productionLaunchGO=false` until a separately reviewed signed launcher, protected staging, validated WDAC/UMCI enforcement and witnessed Windows native production lifecycle exist. Never turn the CI-only suspended probe into a launcher.

## 4. NAVEAX / Work-PC acceptance and provenance

| Dimension | NAVEAX | Work-PC | Classification |
|---|---|---|---|
| Existing Native Agent v1.0.8 | Existing-agent online in 2026-11-04 read-only source ledger | Existing-agent online in same ledger | **HISTORICAL PASS ONLY**, not independently rechecked today |
| Local SQLite Hub | No independent local `Nexowire Hub` task reported in #1086 read-only inventory | #1086 describes live single-Hub SQLite cutover, a successful file_write and key 2001 | **PARTIAL; NOT TWO-HUB GO** |
| Independent Hub journal + migration/rollback | NOT_RUN | Live proof described by PR owner; source branch only | **NOT COMPOSED** |
| Owner/device v2 authorization and public OAuth | NOT_RUN | NOT_RUN | **BLOCKED** |
| Remote WSS and read-only MCP completion | NOT_RUN | NOT_RUN | **BLOCKED** |
| Physical logoff, reboot, startup, rollback | NOT_RUN | NOT_RUN | **BLOCKED** |
| 1 GiB verified file transfer / 24-hour soak / provider quota hard-stop | NOT_RUN | NOT_RUN | **BLOCKED** |

Do not confuse the Work-PC SQLite hotfix and a reported working `file_write` with NAVEAX having an independently installed Hub. #1086 itself prohibits rollback to a JSON-only Hub after new SQLite reservations exist; preserve SQLite main database and WAL/SHM journal continuity with secure offline snapshots.

## 5. AI-01 through AI-09 handoff audit

The nine assigned roles exist, but nine distinct exact-SHA delivery packages formally linked to this final gate were **not all evidenced**. Below are **related PR evidence anchors**, not fabricated agent completion certificates.

| Agent | Assigned scope | Known evidence | Delivery |
|---|---|---|---|
| AI-01 | Windows Job/kernel attestation | #1067, #1078; hosted native guardian checks | **PARTIAL / handoff not verified** |
| AI-02 | Cloudflared startup security | #1077, #1044; probe CI green, executable production trust blocked | **PARTIAL / NO-GO** |
| AI-03 | control-plane owner/device epoch and lease | #1003, #1074, #1083; strict tests pass | **PARTIAL / live backend blocked** |
| AI-04 | atomic CAS, revocation and no-replay | #1075, #1083; CLEAN-10 green | **PARTIAL / atomic fence unproven** |
| AI-05 | CORE plus Connection v2 composition | #1067 and #1085 remain separate drafts | **NOT_COMPOSED** |
| AI-06 | NAVEAX SQLite Hub | #1086 source + Work-PC pilot | **NAVEAX NOT_RUN** |
| AI-07 | reboot, recovery and rollback | #1084 hosted Windows; physical reboot missing | **PARTIAL** |
| AI-08 | two-device E2E acceptance | no witnessed two-device v2 evidence | **NOT_RUN** |
| AI-09 | PR/branch consolidation and closure | #1085 open; separate source and CORE/SQLite drafts | **NOT_COMPLETE** |

Formal acceptance requires a unique exact delivery SHA, explicit owner/reviewer, changed-file allowlist, task-specific negative tests, run/attempt/job IDs and acceptance signature per agent. Do not substitute the earlier 2026-10-31 `AI-01..09` branch naming scheme for this newer role sequence.

## 6. Version, installation and rollback decision

**Published version remains [v1.0.8](https://github.com/Naveax/Nexowire/releases/tag/v1.0.8)**. `package.json` at the audited SHA remains `1.0.8`. The previous untagged internal label `1.0.8-connection-v2-rc.0+939b4d6` is historical and **not a published artifact**. For the audited SHA use the report ID `WIN-RC-AUDIT-25227d0-20261105`; do not create a release tag, claim signed RC or increment the product version until all gates are GREEN.

### Windows installation: STOP / read-only inventory only

1. No production installer, CORE grant, privileged Broker, Cloudflare credential, DNS, scheduled-task or service state may be changed on NAVEAX/Work-PC under this gate.
2. Maintain the existing v1.0.8 installation and Tailscale fallback; preserve working unrelated tasks, services and credentials.
3. On a separately approved disposable Windows VM, record exact source SHA, Windows build, signed manifest, node/runtime versions, installer checksum, all native service/task principals, SID/DACL and current journal schema. Require a verified signed Cloudflared launcher with enforced WDAC/UMCI and independent authorization before any remote enablement.
4. Only after security, source-owner review and signed artifact gates pass, conduct owner-authorized staged deployment one machine at a time, observing read-only acceptance first. Keep installation/roll-forward/revert snapshots tied to the exact commit and service identity.
5. Externally witness correct OAuth PKCE, read-only MCP tool completion, owner/device/epoch lease, wrong-device/owner denial, no-replay, reboot x2, user logoff/logon, multi-device isolation, offline recovery, 1 GiB transfer, 24h soak and quota hard stop. Any failure is **NO-GO**.

Read-only Windows operator inventory (do not transmit raw task action arguments, credential values or private logs):

```powershell
Get-CimInstance Win32_OperatingSystem |
  Select-Object Caption,Version,BuildNumber,OSArchitecture
Get-ScheduledTask |
  Where-Object { $_.TaskName -like '*Nexowire*' } |
  Select-Object TaskName,TaskPath,State,@{N='Principal';E={$_.Principal.UserId}},
                @{N='LogonType';E={$_.Principal.LogonType}}
Get-Service -Name '*Nexowire*' -ErrorAction SilentlyContinue |
  Select-Object Name,DisplayName,Status,StartType
```

### Rollback contract: no mutation under NO-GO

- **Before** any future authorized cutover: sealed, independently verified and tested backup of each device's own Hub SQLite main file plus related WAL/SHM state, legacy JSON source, anti-replay receipts, unknown/in-flight reservations, task XML/principal, executable manifest and protected credential recovery. Never copy a foreign device's journal onto another device.
- If a disposable rollout fails: fail closed; stop only the explicitly-owned staging candidate; revoke only staging tokens; preserve UNKNOWN receipts and idempotency tombstones; no automatic retry of uncertain mutations. Restore previously verified artifact/config and exact task owner/principal/triggers using witnessed VM rollback.
- **Do not downgrade to JSON-only** after new SQLite reservations. Such a downgrade can forget anti-replay entries and redispatch mutations.
- Task XML alone does **not** restore password-backed credentials. A rollback cannot be marked PASS unless credentials, correct SID/ACL, one-instance process tree, native binary identity, prelogon Hub and dependent agents are independently verified.
- If a real device cannot be restored or provenance cannot be verified, remain **BLOCKED**, keep feature flag OFF, and preserve forensic evidence. Physical reboot is only with separate owner approval after VM tests.

## 7. Remaining owners, paths and release decision

| Priority | Owner / PR | Files / evidence required |
|---|---|---|
| P0 | Windows Cloudflared Security #1077 / AI-02 | `native/windows-cloudflared-image-probe.c`, `src/mcp/cloudflare-binary-trust.ts`, `scripts/audit-clean13-windows-launch-readiness.ps1`; separately signed real launcher and WDAC/UMCI enforcement proof |
| P0 | CORE Coordinator #1067 / AI-05 | `src/agent/core-windows-mutation-dispatch.ts`, `src/agent/windows-job-kernel-attestation.ts`, `test/clean12/mandatory-native-ack-gates.test.ts`; integrate native claim authority with v2 without weakening fail-closed rules |
| P0 | SQLite Hub #1086 / AI-06 | `src/operations/idempotency-store.ts`, `test/idempotency/hub-capacity-recovery.test.ts`; second local Hub, safe migration, writer fence and recovery proof |
| P0 | Public authorization #1003/#1074/#1083 / AI-03/04 | `src/hub/control-plane-agent-auth.ts`, `src/hub/agent-websocket.ts`, `src/core/agent-broker.ts`; authoritative owner/device epoch/lease and atomic revocation/send fence |
| P1 | Windows lifecycle #1084 / AI-07 | `src/hub/hub-lifecycle.ts`, `docs/connection-v2/windows-recovery-acceptance.md`; witnessed two-device VM reboot/logoff/rollback |
| P1 | Independent QA #1044 / AI-08 | `test/ai11-connection-v2-negative.test.ts`, `test/v206-round2-windows-native-reason.test.ts`; actual physical/device external negatives |
| P1 | Integration/review #1085 / AI-09/10 | `docs/connection-v2/source-preservation-matrix.csv`, `docs/connection-v2/staging-evidence.json`, this file; 23 non-exact semantic owner decisions, external acceptance, final exact-SHA revalidation |

**Final verdict: NO-GO.** No verified merge candidate SHA is recommended. All positive CI remains valid as isolated test evidence, but the source branches are not one signed, independently reviewed, Windows production-ready artifact. Keep #1085 draft; do not merge main, deploy, change privileges, reboot physical devices or publish a release on this report.
