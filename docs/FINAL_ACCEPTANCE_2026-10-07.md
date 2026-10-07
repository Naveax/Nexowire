# FINAL acceptance checkpoint — 2026-10-07

Current published release: **v1.0.3** at `2b0b1f9193dec241998ec31993ff2d3269880690`.

Verified release gates:

- exact-main CI `37633896113`: success
- authorized publisher `37633896191`: success
- tag-scoped Release Readiness `37634000571`: success
- no open pull requests at the checkpoint
- paid billing remains intentionally disabled

Live Windows state:

- Naveax: checksum-verified `1.0.3-2b0b1f9193de` runtime installed. Launcher points to it and an exact guarded durable cutover stopped the old v1.0.2 agent; subsequent process inspection confirmed one `agent run` process executing from the v1.0.3 versioned runtime.
- work-pc: last fully verified Hub/Agent runtime is checksum-verified versioned v1.0.2. A parser-clean one-UAC final setup script is staged locally for the v1.0.3 SYSTEM pre-logon Hub plus Privileged Broker, but it has not been executed.
- prior two-PC v1.0.2 parallel acceptance passed 24/24 bounded calls.
- current production contention attempts are partially obscured by upstream platform safety filtering; those filtered calls must not be counted as Nexowire/D1 failures.

Storage work:

- exact SHA-256 duplicate WSL backups were found; the timestamped duplicate `Ubuntu-22.04_2026-02-09_062902.tar` was removed while `Ubuntu-22.04_latest.tar` was retained, reclaiming 12,626,534,400 bytes on D:.
- five large LM Studio / LocalAI model pairs were proven byte-identical by SHA-256. No model file has been removed or hardlinked because the hardlink mutation test is currently blocked by the platform safety layer.
- Naveax C: remains critical at roughly 99% used; continue non-destructive inventory before large builds.

Remaining FINAL gates:

1. Install the published v1.0.3 versioned payload on work-pc.
2. With one explicit local administrator approval, install the v1.0.3 SYSTEM `AtStartup` Hub and Privileged Broker. Do not bypass UAC.
3. Repeat a real work-pc cold reboot and prove public Hub/MCP availability before interactive logon, stable device IDs, and no duplicate Hub/Agent processes.
4. Read the authenticated production owner dashboard and prove `planId=free` plus `usage.monthlyCredits=null`; verify a non-owner Free identity remains finite.
5. Run bounded production D1 contention/soak without upstream safety-filter interference.
6. Finish rollback-safe exact-duplicate cleanup and C: capacity inventory.
7. Freeze FINAL, then begin `docs/NEXOWIRE_SCREEN.md` S0/S1.

Post-final Nexowire Screen remains the first major feature: dedicated second-screen-like AI workspace, independent visual AI cursor, smooth cubic-Bezier/minimum-jerk motion, bounded capture/viewer, and no movement of the user's physical pointer.
