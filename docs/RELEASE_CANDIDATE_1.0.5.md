# Nexowire v1.0.5 release candidate

Status: **candidate only; not published or authorized for tagging**. Stable v1.0.4 remains the immutable public release and the installed work-pc runtime.

## Changes since v1.0.4

- PR #237: an owner-authorized device in persistent FULL ACCESS mode acknowledges `windows.console_control.request` without another local ALLOW/DENY dialog. SAFE mode still enforces the time-bounded local approval. This does not bypass Windows UAC, elevate arbitrary commands, or remove tool/device policy.
- PR #238: repair Windows ProgramData child-file ACL hardening for SYSTEM Hub Boot and Privileged Broker launchers, including a zero-DACL legacy file case. Treat null TaskScheduler last/next-run timestamps safely. Retain SYSTEM and Administrators only for protected files.
- PR #239: upgrade the direct `@modelcontextprotocol/sdk` dependency to locked 1.32.1, addressing high-severity advisory GHSA-6qxp-vccf-f47h. Clean local `npm audit` after the change reported zero vulnerabilities.

## Real-device evidence

On 2026-10-08 work-pc v1.0.4 had a running SYSTEM/AtStartup/Highest Hub Boot in Session 0 with LocalMachine-DPAPI token, local TCP 43110, an elevated interactive Privileged Broker on TCP 43112, and a Native Agent configured for broker mode. An idempotent first-party privileged `windows.task.control` call returned `verified:true`. The bootstrap used an existing owner-authorized SYSTEM maintenance channel, not a UAC bypass or Nexowire runtime dependency. Temporary elevated bootstrap tasks and executable scripts were removed.

**Do not conflate these live v1.0.4 installation results with deployment of this candidate's code changes.** The new no-popup and ACL source fixes remain absent from the immutable v1.0.4 runtime.

## Live broker recovery regression

A subsequent live check on work-pc found the v1.0.4 Privileged Broker stopped (Task Scheduler last result `0xC000013A`) with no listening TCP/43112; its original logon task had `RestartCount: 0`, a 72-hour execution limit and battery restrictions. PR follow-up in this release candidate adds one-minute scheduled-task restarts (up to 999), unlimited execution time, battery readiness and singleton policy while retaining the interactive elevated owner principal. An attempted live policy adjustment has **unknown postcondition** because both remote management channels went offline during the operation. On reconnection, inspect task settings and active ports read-only first; never blindly replay the mutation. The live crash/recovery gate remains open.

## Subsequent live Broker recovery finding

On 2026-10-08 at 12:16 TRT, work-pc had the upgraded `RestartCount=999` / 1-minute TaskScheduler failure-restart settings. A controlled abnormal Broker child termination nevertheless left the task `Ready`, `LastTaskResult=0xFFFFFFFF` and TCP 43112 closed for over a minute; the failure-restart setting alone is **insufficient on that installed task**. A manual start successfully restored Broker functionality.

This candidate adds a separate **indefinite 1-minute repeating Task Scheduler trigger**, alongside AtLogOn, and keeps `MultipleInstances=IgnoreNew` so an already running Broker is not duplicated. Disabling the scheduled task remains the explicit maintenance/owner-off path. PR #245 passed CI 7/7 and was merged. The live work-pc task configuration (separate from installed v1.0.4 source) passed a forced-exit recovery test: old PID 10848 was stopped at 12:21:05 TRT, and one new Broker PID 8108 was listening by 12:21:17. An idempotent first-party privileged scheduled-task operation returned verified=true; a singleton process/listener was confirmed. The installed v1.0.4 binary is not automatically upgraded by merging source.

## Restart ordering caveat

Read-only Windows event logs from the 2026-10-08 boot show kernel startup around 11:57:38 TRT, first user interactive logon at 11:57:54, SYSTEM Hub task start at 11:57:57, and Hub node process at 11:58:24. Thus the same reboot confirms recovery **after login**, not independent pre-login remote availability. Do not declare this gate passed without a dedicated no-login network probe.

## Candidate gates

- [ ] Check exact candidate SHA, clean PR CI and Release Readiness on Linux/Windows/macOS.
- [ ] Authorize a **separate** release tag `v1.0.5` only by a deliberate release authorization; never reuse or retarget v1.0.4.
- [ ] Verify canonical Windows ZIP, setup CMD, SHA256SUMS, manifest, SBOM, attestations and tagged release outcome.
- [ ] Stage and checksum-verify a side-by-side Windows update, preflight rollback, then perform an official guarded runtime rollout to work-pc and Naveax without duplicate agent processes.
- [ ] Verify real FULL no-popup UI behavior under authenticated owner FULL ACCESS, while SAFE still asks for approval.
- [ ] Verify actual cold reboot **before logon** for SYSTEM Hub Boot, then Agent/Broker reconnection after login, same device IDs and clean recovery.
- [ ] Verify authenticated production owner dashboard `monthlyCredits: null` and `planId: free`, and run bounded production D1 contention/soak.
- [ ] Complete security regression and rollback tests before declaring FINAL.

No billing activation, credential export, UAC policy change, or destructive data cleanup is authorized by this candidate.
