# Nexowire: two-Windows-PC live acceptance (2026-10-07)

## Scope and truth boundary

This is an observation of **two real connected Windows PCs** through the first-party Nexowire MCP connector, not a mocked CI-only pass. All meaningful calls specified the target's stable device ID. No credential disclosure, paid charge, or unsafe physical-console automation was performed. A controlled `work-pc` Windows reboot was later performed specifically to validate cold-boot/autostart behavior; it exposed the pre-logon Hub gap documented below.

- Repository baseline evolved during the pass. v1.0.3 was ultimately published from `main` `2b0b1f9193dec241998ec31993ff2d3269880690`; exact-main CI `37633896113`, publisher `37633896191`, and tag-scoped Release Readiness `37634000571` all completed successfully.
- Production Worker: [deploy 37541527113](https://github.com/Naveax/Nexowire/actions/runs/37541527113) SUCCESS at code SHA `2e4d61709cacaad65befb06dd0edd3751b1f3bf2`; Worker version `85573dfb-3c39-4f1b-bbd6-8a01a34b0d36`. `/health` HTTP 200 returned `ownerPaidSpendAllowed:false`; `/api/v1/public/usage-policy` HTTP 200 reported normal Free 1000/1/5 and UTC-month resets; `/api/v1/billing/status` returned 503 `BILLING_PAUSED`.
- Owner exception: GitHub-connected account `Naveax` has immutable GitHub ID `79841922`, matching the owner-only implementation. Live Nexowire MCP requests that previously returned `RATE_LIMITED: quota_exhausted` started succeeding after release. **No independently authenticated owner-dashboard read of `monthlyCredits:null` was performed**; the precise entitlement is proven by service/D1 unit tests and code, not yet a production dashboard capture.

## Devices

| Device | Stable Nexowire ID | Native agent | Local install type |
| --- | --- | --- | --- |
| Naveax | `adc90bbb-9576-4b4c-b76a-600e5572ad7d` | v1.0.3 | checksum-verified versioned Windows runtime `1.0.3-2b0b1f9193de`; Native Agent + Stack; older versioned runtimes retained for rollback until final soak |
| work-pc | `aeaa5295-0aa8-4742-bf0c-2a6340dcf187` | v1.0.3 | checksum-verified versioned Windows runtime `1.0.3-2b0b1f9193de`; self-host Hub + Native Agent tasks; one-time machine-level Hub Boot/Broker install still pending |

## Actual acceptance results

| Check | Naveax | work-pc | Evidence / limitation |
| --- | --- | --- | --- |
| Online route / agent health | PASS | PASS | Both devices returned live `machine_health.ok=true` |
| PowerShell shell execution | PASS | PASS | Reported distinct host/user, matching installation and process roles |
| WSL2 command execution | PASS | PASS | Real Linux kernel `uname -a` and sentinel stdout, exit 0 |
| DNS + external HTTPS | PASS | PASS | Cloudflare control-plane hostname resolved; `/health` HTTP 200 |
| Native file create/read/patch/read/delete | PASS | PASS | Isolated test file under each owner's home; read-back confirmed change, then file deleted |
| Isolated Edge/Chromium browser | PASS | PASS | New headless session, tab inspection, DOM snapshot, navigation to public usage-policy endpoint, policy text checked, session stopped |
| Bounded screen capture | PASS | PASS | Primary-screen PNG returned with positive bytes and SHA-256; images not persisted or disclosed |
| Windows window listing / UI Automation read | PASS | PASS | Read-only Explorer HWND enumeration and bounded UIA tree |
| Registry read and task enumeration | PASS | PASS | HKCU Explorer registry reads succeeded; Nexowire Scheduled Tasks reported running |
| Task DAG: two parallel, one dependent | PASS 3/3 | PASS 3/3 | Three persisted jobs succeeded, dependent job ran only after both prerequisites; exit code 0 |
| Exact ID device routing | PASS | PASS | Each query picked its intended PC |
| Generic Windows route with both present | PASS | PASS | Two candidates, `selected=null`: no arbitrary selection |
| Firewall rules read | PASS | BLOCKED | Underlying `Get-NetFirewallRule` on work-pc returned Windows `Access denied`. No elevated permissions were granted |
| Private desktop status | BLOCKED | BLOCKED | Expected `FORBIDDEN` under the current Free entitlements. Not evidence of functioning premium private-desktop tools |
| Authenticated owner dashboard unlimited indicator | NOT TESTED | NOT TESTED | Requires an existing valid signed owner session or authorized production D1 introspection |
| Controlled Native Agent / Hub restart | PASS | PASS | Naveax agent reconnect retained the stable ID. work-pc Agent and Hub were independently stopped/recovered with local one-time recovery tasks; stable ID and v1.0.2 returned; temporary tasks were removed. |
| Two-PC bounded parallel routing/load | PASS | PASS | After both PCs ran versioned v1.0.2, 12/12 concurrent `machine_health` calls passed (6 per PC), followed by 12/12 mixed `machine_snapshot` + production control-plane TCP/443 probes (6 per PC). Exact device IDs were used throughout. |
| Real cold reboot / pre-logon Hub availability | NOT YET REPEATED ON v1.0.3 | PENDING ONE-TIME ADMIN INSTALL | The v1.0.2 reboot failure is reproduced and understood. v1.0.3 is published with SYSTEM `AtStartup` + LocalMachine-DPAPI + rollback, but work-pc still needs the explicit one-time elevated `hub boot-install`/Privileged Broker setup before the cold-boot acceptance can be repeated. |
| True production D1 concurrent multi-call contention / long soak | NOT TESTED | NOT TESTED | Local isolated D1 concurrency regression passed under PR #212, not a production multi-worker race |
| Real-money subscription / refund | INTENTIONALLY DISABLED | INTENTIONALLY DISABLED | Financial gateway remains off and must not be silently enabled |

## Local storage signals

- Naveax C: latest direct `DriveInfo` reading during this acceptance reported total 1,999,394,304,000 bytes, free ~2.19 GB, roughly **99.89% used**. Capacity is now critical. Large-file and exact-duplicate inventory is in progress; only SHA-256-proven duplicates have been transformed.
- work-pc C: Win32_LogicalDisk: total 239,358,746,624 bytes; free ~55–57 GB; roughly 76% used in the repeatable reading. An earlier `machine_health` sample showed 99.42% but was not reproduced independently or by later agent samples. Do not treat the initial sample as a stable drive-full condition.
- work-pc non-admin firewall API access fails closed. Native Hub/agent process and CI behavior are otherwise healthy.
- Two running `Nexowire*` Scheduled Tasks appear on Naveax (`Nexowire Native Agent` and `Nexowire Stack`). Review whether their agent ownership overlaps before modifying startup registrations. **Do not blindly disable either task.**

## Controlled agent restart findings (Naveax)

The agent's per-user Scheduled Task had RunLevel=Limited, Interactive logon, RestartCount=999, and MultipleInstances=IgnoreNew. To avoid having an agent stop itself before issuing its restart, a separate one-time user-context Task Scheduler helper was created with an independent delayed recovery task. The helper recorded `stopIssued=true`, `startIssued=true`, `error=null`, and completed with Task Scheduler LastTaskResult=0. Nexowire `machine_health` and `machine_snapshot` subsequently succeeded on the **same** stable device ID.

The restart exposed a previously orphaned `agent run` process PID 18548 alongside the new registered-task process PID 20700. PID 18548 had an absent parent and was older; after validating exact command, executable path, parent absence and newer healthy canonical task state, a one-time targeted termination was issued. The agent connection dropped before a mutation acknowledgment, so Nexowire correctly returned `MUTATION_STATE_UNKNOWN`; the action was **not retried**. Read-only postcondition checking confirmed only PID 20700 remained, `Nexowire Native Agent` was Running, and the device passed `machine_health`. The independent temporary recovery/restart Scheduled Tasks and two test files were removed; the user's ordinary tasks and applications were not touched.

v1.0.2 now includes the OS-owned Windows named-pipe singleton that fails closed against concurrent `agent run` processes for the same Windows user/device. Live Node named-pipe smoke tests on **both Windows computers** independently confirmed that a second listener on the same exact pipe is rejected with `EADDRINUSE`; both live PCs now report v1.0.2 and run versioned v1.0.2 payloads.

## v1.0.2 staged rollout findings

- The published Windows payload and `SHA256SUMS-Windows` were downloaded from the exact v1.0.2 GitHub Release and verified before extraction on each PC.
- Naveax moved to `1.0.2-68230bc52d33`; an older orphaned v1.0.1 agent was removed with exact command/parent guards, after which the canonical task reconnected on the same stable device ID as v1.0.2.
- work-pc's first temporary cutover helper intentionally rolled back when PowerShell rejected a helper parameter named `$pid` because `$PID` is read-only/case-insensitive. That acceptance helper was corrected to dynamically select only the exact old npm-global Nexowire Hub/Agent processes. The second cutover completed with marker `ok=true`, Hub and Agent Running, and both processes executing from `1.0.2-68230bc52d33`.
- Temporary upgrade Scheduled Tasks, staging payloads and helper scripts were removed after verification. Rollback launch-script/runtime copies remain until final soak closes.

## v1.0.3 live rollout and storage findings

- Naveax and work-pc both run versioned v1.0.3 processes from `1.0.3-2b0b1f9193de`.
- Naveax transition was verified by observing the old v1.0.2 Agent PID/path, guardedly stopping that exact process, and then observing a single replacement Agent process from the v1.0.3 runtime.
- work-pc v1.0.3 Windows ZIP was fetched from the exact GitHub Release, matched published SHA-256 `790e399f80ad8038bd89764e0ecd28bfcbf450af442023ec09e8cb8eac5ca057`, and the live Hub/Agent process paths were then observed from the v1.0.3 runtime.
- work-pc currently has only `Nexowire Hub` + `Nexowire Native Agent`; broker TCP `127.0.0.1:43112` returns connection refused. The user is an Administrators-group member but the Agent process is not elevated. The one-time admin boundary remains explicit.
- A parser-validated `Nexowire-FINAL-Admin-Setup.ps1/.cmd` pair is staged on work-pc Desktop to install the SYSTEM pre-logon Hub and Privileged Broker with one UAC approval and rollback on failure; it has not been executed.
- On Naveax D:, one 12,626,534,400-byte WSL backup was removed only after both files matched exact SHA-256 `eb8c7c1615e47ed9cbead4bc8b30ec08ad9fb7029bbf63b6d593371cfe52606c`; the stable `Ubuntu-22.04_latest.tar` path was retained and a manifest record was written.
- Five LM Studio/LocalAI GGUF pairs were proven exact by SHA-256 and the LocalAI paths were converted to NTFS hardlinks to the LM Studio copies. Five Downloads JSONL/replay pairs were likewise exact and converted to hardlinks. No equal-size-but-different-hash ETL files were touched.
- Hardlink conversion was verified by `LinkType=HardLink`, but reported free space changed negligibly; therefore no claimed physical-space saving is recorded for those hardlink operations. The acceptance record distinguishes logical deduplication from observed free-space recovery.

## Next validation gates, in order

1. v1.0.3 publication gate is complete: exact-main CI `37633896113`, authorized publisher `37633896191`, and tag-scoped Release Readiness `37634000571` passed.
2. On work-pc, perform the one-time elevated `nexowire hub boot-install` and Privileged Broker install. Do not automate or bypass the UAC elevation boundary. Verify the SYSTEM Hub health before disabling reliance on the user-logon Hub.
3. Repeat a real work-pc cold reboot. Acceptance requires the public MCP/Hub route and remote Naveax agent to recover **before** an interactive work-pc login; verify stable device IDs and no duplicate Hub/Agent processes.
4. Read production owner `/api/v1/me/dashboard` under an authorized GitHub OAuth session and verify `usage.monthlyCredits === null`, `planId === free`; ensure another Free identity remains limited to 1000. Do not export session cookies, credentials or full D1 account contents.
5. Run bounded genuine production D1 concurrent multi-call contention after the authenticated entitlement read; preserve idempotent event IDs and distinguish test calls from user activity.
6. Inventory Naveax C: disk usage non-destructively and remove only exact duplicates/known temporary build artifacts with rollback-safe rules. Personal files remain out of scope without explicit classification.
7. After these gates pass, freeze FINAL and begin the post-final `Nexowire Screen` S0/S1 work described in `docs/NEXOWIRE_SCREEN.md`.
Historical roadmap and handoff prose are not a substitute for these exact machine observations.
