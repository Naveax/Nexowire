# P1 #780 / worker #46: cross-platform native task sandbox RED acceptance

**Date:** 2026-10-23. **Owners:** new, isolated QA-only paths; coordinates #539.
**Baseline:** `main 754cc4364822be5fda528f54042fb22a84f19924`.
**Git executor reviewed:** #811 `600a0286557d360681be7bd7b86da95ba57f1980`, CI `39854971347` SUCCESS (7 jobs); Git hardening is **not** OS sandboxing.
**Windows feasibility reviewed:** #793 `9f24e7e11301ca9b8e4b8bd59f232f3eb2163d5c`, documents explicitly **no native per-task restricted-token/AppContainer isolation**. Its docs CI alone cannot authorize process execution.

## Decision

**BLOCKED / NO-GO for native task sandbox.** Only *negative source QA* has been added. No independent physical Windows token/ACL/Job/handle proof or Linux namespaces/mount/egress enforcement is available. Windows Job membership, `PathPolicy`, shell `cwd`, sanitized Git options, a mocked security adapter, and hosted Node test success are **not** evidence of a sandbox. No tests may be relaxed to a synthetic PASS.

The existing actual `executeCapability('shell.exec')` uses `runProcess` and `spawn(..., env:process.env)` with caller identity, ordinary environment, network and filesystem access. The new test tests *that current path*, not a nonexistent `task.sandbox.launch` API, using only disposable files under one `os.tmpdir()` fixture, a short-lived synthetic environment value, a local Git repository and loopback sockets. It intentionally expects OS-level denials the current source has not implemented, so RED is the correct indication of a leak. It makes no Windows Agent, UAC, ACL, service, protected process, VM, production D1, billing, or real user file changes.

## Independent negative coverage

| Case | Actual effect probe | Safe acceptance condition | Nonvacuity / interpretation |
|---|---|---|---|
| File boundary | A shell started with an authorized `cwd` reads a synthetic marker and writes a canary in sibling TEMP folder | No out-of-root effect | Command output is attributable to executed probe, not a mocked `PathPolicy` |
| Environment | Shell reads `NEXOWIRE_QA46_DISPOSABLE_SECRET` | Test-only value not inherited | Tests only a synthetic random marker, never a credential |
| Child process | Shell creates a Node grandchild which writes a sibling-TEMP canary | No outside write | Parent-only CLI guard cannot isolate descendants |
| Symbolic / reparse | Linux symlink or Windows junction inside task root points to sibling TEMP folder | No target read/write | Native link creation failure is BLOCKED, never `skip=PASS` |
| Hardlink | An approved name aliases a sibling-TEMP file on the same volume | Sibling file bytes remain intact | Pathname/realpath alone cannot distinguish hardlink identity |
| Git helper | Repository-local post-commit hook launches a disposable Node helper writing outside root | No outside effect | Preflight **proves** hook actually runs before this negative; distinct from unchanged #800 fsmonitor test |
| TCP, UDP, DNS-wire | Test binds short-lived `127.0.0.1` listeners, then task sends TCP/UDP/DNS-format packets only to those listeners | No packets/connection observed | No internet/public resolver used. Loopback result is **not** proof of WAN egress confinement |
| Timeout and terminate | Timed-out root spawns a delayed child writing sibling-TEMP marker | Timeout recorded; no orphan marker | A passing cleanup subtest proves only observed descendant cleanup on that runner |

**Do not modify original adversarial fixtures:** #786 `test/p26-780-git-worktree-root-escape-negative.test.ts` (blob `866c12289db344ef72d6c3a63112228c970aa0b9`), #800 `test/p20-780-git-fsmonitor-hook-escape-negative.test.ts` (blob `50a9b1437d66347c83e87164bc9d7233f1ae4a98`). Both are included unchanged on #811; original negative PR CI failure does not equal a newly accepted OS sandbox.

## Physical evidence required before lifting BLOCKED

1. **Distinct launch API and attestation:** exact task/request/worktree/root/grant/owner epoch and run identity bound to actual nonprivileged OS token; Windows restricted token or AppContainer SID + integrity level + restrictions verified *from the started root and descendants*. A Windows Job is lifecycle enforcement only. On Linux, verify real namespaces/mount bindings and LSM/seccomp/network policy as applicable, not an unshare command-line string or a synthetic report.
2. **Files/handles:** independent denial for sibling TEMP read/write, symlink/junction/reparse and hardlink identity, inherited open file handles, handle duplication (`PROCESS_DUP_HANDLE` under the actual test token on Windows), and concurrent namespace/rename races.
3. **Environment and children:** clear all ambient credentials/tokens/inherited sensitive handles; prove descendants inherit the restrictions. No guest/service/admin token and no installed Broker privilege entry from a task worker.
4. **Network:** enforce DNS and direct IP TCP/UDP including loopback, IPv4/IPv6, and child subprocesses with OS policy. Loopback-only unit negatives do not prove external network routing isolation or WFP/netns correctness; perform staged physical checks separately if authorized.
5. **Timeout and cancellation:** durable job/scope lifetime, verified root and descendant termination, owner-revoke fencing and lost ACK => UNKNOWN/reconciliation; no blind replay, no quota release from an unverified stop.
6. **Approval:** independent QA owner verifies exact native binary SHA/signing/version, launched principal and enabled OS policy, true denial receipts (not merely process exit error), and the exact CI source SHA. **Source CI green != physical approval.**

## Scope and handoff

Source-only QA branch is independent of #03 Windows native/Job owner, #05 PathPolicy, #31 executor, and #786/#800 owners. No changes to `src/agent/executors.ts`, Windows native launcher, Git tests, CI workflows, installed Agent/Broker, VM or user files. Preserve intentional RED until the dedicated trusted sandbox adapter and physical receipts exist; do not rebrand a `shell.exec` failure or unsupported runner as native denial. #539/#00 retain merge authority. 