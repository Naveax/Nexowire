# Nexowire Work-PC functional integration — 2026-11-06

## Work scope and boundaries

- Source worktree: `C:\Users\umut\Documents\Nexowire-Integration-20261106`
- Working branch: `integration/workpc-windows-recovery-20261106`
- Main baseline at checkout: `eeb3b26d208c7119c4313982a43d03a1aa5169f9` (merged #1095)
- **NAVEAX was not accessed, changed or rebooted during this integration round.**
- The live Work-PC Hub, Agent, Broker, their services/tasks, credential stores and SQLite WAL were not restarted or replaced by this source integration. Work-PC reboot has not been performed.
- Release classification: **candidate / NO-GO** pending independent CI and disposable VM acceptance. Local pass is not production proof.

## Source DAG and preserved changes

All following source PR heads are Git ancestors of this integration candidate:

| Source | Exact head SHA | Purpose |
| --- | --- | --- |
| #1086 | `eee335eb4188eb82614c6791c67622d7832646b5` | Durable Hub SQLite, no 2,000/5,000 record production cap, legacy migration |
| #1087 | `7a580104def439e217fe1facb27334c78c29f3e7` | Atomic mutation authority, no-replay negatives |
| #1088 | `d687181269c11ae913051ed6c75a1a3d139f584b` | Authorization epochs and time-bounded authority |
| #1089 | `f4765a59b914089ebc050208c2218d7a9730dacf` | CORE + Connection v2 Windows integration |
| #1092 | `4df53690acb7de130f9bb2346aabaf8e28760fbc` | Reject SQLite downgrade before Windows Hub update / rollback |
| #1094 | `fddcaef3118aa01f5dc3814dd6a346d6e2f1bedf` | Permanent owner CORE, Windows process availability |
| #1095 | `eeb3b26d208c7119c4313982a43d03a1aa5169f9` | Main baseline: personal owner features, MCP diagnostics, native hotkey fix |

Source history includes #1093 through #1094 and #1089 through #1092. No source PR was closed or merged into main by this worktree.

## Applied integration repairs

1. Retained the PowerShell 5.1 module search isolation for the Windows SQLite cutover fixture; replaced invalid hard-coded escaped paths with canonical `SystemRoot`-derived executable, PATH and module directory.
2. Recomputed only changed **candidate** Git blob SHA values in the two source-preservation matrices. Kept the original source SHA references and the original row counts (**79** and **243**); downgraded obsolete `EXACT_*` claims to `EVOLVED` / semantic review where the integrated candidate differs.
3. Preserved the `NO_GO` declaration for physical Windows reboot, unexpected power loss, high-integrity Broker / Hyper-V operations and release acceptance.

## Verification completed on Work-PC

- `npm ci --no-audit --no-fund --prefer-offline`: PASS
- `npm run typecheck`: PASS
- `npm run build`: PASS
- Windows SQLite + update/rollback preflight: **10/10 PASS**
- AI-04 Atomic Mutation: **26/26 PASS** (first merge verification)
- AI-03 Control Plane Authorization: **8/8 PASS** (first merge verification)
- Unified AI-04/AI-03/SQLite acceptance: **44/44 PASS**
- CORE bootstrap, personal process, native lifecycle suites: **29/29 PASS**
- Source-preservation gate: **2/2 PASS** after candidate SHA refresh
- Full repo regression and GitHub CI: **pending** at the time this report was drafted; do not infer completion from this file.

## Remaining release acceptance

- Work-PC controlled owner CORE enrollment is active from a prior local approval, but **post-Windows-reboot persistence remains NOT_RUN**.
- Generic elevated shell / Hyper-V is **not implemented** in the existing non-elevated `shell.exec` path. Do not report it as fixed just because a privileged Broker process is running.
- `agent_operation_status` exists in source but is not exposed by the current ChatGPT Nexowire stable tool surface. Journal read-only reconciliation is separate.
- Hosted final release CI, cross-version upgrade and rollback and disposable Windows VM reboot / power interruption are **NOT_RUN** until independently executed.
- The Work-PC installed automatic updater remains temporarily disabled to preserve the live SQLite hotfix. Verify guarded updater before re-enabling; do not overwrite live WAL.
- Check Work-PC C: free disk before making Windows release artifacts. Never reboot the NAVEAX physical computer during testing without explicit separate owner approval.

## 2026-11-08 unattended Windows reboot readiness (later source check)

The `nexowire hub reboot-readiness` CLI now inspects the canonical
`Nexowire Hub Boot` task and the `Nexowire Native Agent` task
**without modifying Windows tasks, UAC, Winlogon or user credentials**.

Observed source-client result on Work-PC:

```json
{
  "systemHubInstalled": false,
  "agent": {
    "installed": true,
    "systemIdentity": false,
    "bootTrigger": false,
    "interactiveOnly": true
  },
  "autoAdminLogon": false,
  "startupTopologyReady": false,
  "remoteRebootAccepted": false,
  "blockers": [
    "SYSTEM_HUB_BOOT_NOT_INSTALLED",
    "NATIVE_AGENT_LOGON_ONLY",
    "PRELOGIN_REMOTE_RECOVERY_NOT_VERIFIED"
  ]
}
```

A SYSTEM Hub Boot task *alone* does not solve an interactive-only
Native Agent. A safe remote unattended reboot requires a separately
implemented, tested pre-login Agent path, machine-scope credentials,
controlled actual reboot, and externally observed recovery. This
source-level command is intentionally a **diagnostic, not an
implementation or simulation of a SYSTEM Agent**.

A separate controlled Work-PC **Hub task process restart** already
recovered HTTP 200 and preserved all 2,398 existing SQLite records
(`quick_check=ok`); that does not establish whole-computer reboot or
pre-user-login reachability. Do not enable auto-logon merely to hide this
acceptance gap. Production release remains NO-GO.

## 2026-11-08 SYSTEM pre-login Agent transport bootstrap, source only

The native Agent can now enter a separate **opt-in** Windows
`NEXOWIRE_WINDOWS_PRELOGIN_AGENT=1` transport-bootstrap mode.
It advertises only `machine.health` and `windows.tasks`. Even if
the Hub sends a forged or hidden request for `shell.exec`,
`files.read`, browser/desktop or a mutation, the Agent returns
`AGENT_PRELOGIN_CAPABILITY_UNAVAILABLE` **before** the request
cache, independent CAS, journal, or executor. CORE Broker discovery is
disabled in bootstrap mode. The standard interactive Agent mode
is not changed.

This is an actual runtime guard, not a SYSTEM service installation.
The future pre-login task must be provisioned with its own
independently verified machine-scope DPAPI token, device identity,
trusted executable/tree and protected persistent state. The source
now requires a canonical `C:\\ProgramData\\Nexowire\\system-agent`
profile: machine-DPAPI `agent-bearer-token`, a separate protected
`agent.json`, state and journal, an exact loopback Hub WebSocket endpoint,
trusted Node/CLI code and verified parent, child and secret ACLs. It
rejects owner CORE credentials, arbitrary file roots and user DPAPI
before opening the Agent identity. No SYSTEM task has been registered. Do not run
the owner-account DPAPI launcher in SYSTEM or share an untrusted
user-writable runtime. A separate controlled logon handoff is still
required to restore full owner CORE capabilities.

Pre-login bootstrap runtime tests and explicit Windows Node 22/24
CI tests verify the separate mode. No live tasks, credentials,
UAC, startup settings or Work-PC/NAVEAX service state were changed
by this source round. Full OS reboot remains NOT_RUN.
