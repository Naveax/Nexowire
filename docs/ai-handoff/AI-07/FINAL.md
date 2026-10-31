# AI-07 scoped handoff (2026-10-31)
**Decision: NO_GO for production, Draft source review only.**
Changed files: `src/agent/task-os-sandbox-policy.ts`; `native/task-os-sandbox-windows-appcontainer-probe-p07.c`; `test/ai07-sandbox-windows-probe.test.ts`; `test/ai07-sandbox-mutation-state.test.ts`; `docs/ai-handoff/AI-07/{STATUS,CONTRACT,TEST_EVIDENCE,INTEGRATION_REQUEST,FINAL}.md`.
- Source/static Windows C tests: 2/2 PASS on Linux Node 22.16.0, not OS proof.
- New mutation test, full repo typecheck, Windows MSVC, native kernel/physical tests: not locally run; consult new exact-head Actions.
- Existing #859 CI 40547392793 SUCCESS only applies to original SHA, not this branch.
- Missing: production OS worker, AI-05 pre-effect executor/CAS admission, AI-04 independent Broker/Job/receipt gate, authenticated owner/device/session identity, independent AppContainer/Job handle/disk/network isolation, descendant cleanup and verified revoke.
- No other-owner file mutation, merge, deploy, UAC/ACL/service, real Agent or OS policy changes.
- Child Draft PR URL, final HEAD SHA, exact CI run IDs: read live Github metadata, not an embedded self-referential SHA.

## Follow-on source hardening
- Linux selftest child closes *all* FDs rather than retaining stdin/out/err and no longer has seccomp write; outer parent owns the synthetic marker. Windows C includes Advapi32 and checks TokenPrimary, Job close semantics. Kernel acceptance remains separate and **NO_GO**.


## 2026-10-31 continuation scope
Added bounded Linux probe child lifetime and new Windows-only MSVC native regression; local Windows native compile still requires isolated runner. NO_GO persists.

## Correct owner routing
Per `NEXOWIRE_AI_TAKIM_PLANI_14_GUN.md`, AI-05 owns executor/CAS dispatch; AI-04 owns Broker-side admission/Job; AI-02 owns enrollment/protected Service; AI-03 owns mTLS/verifier; AI-08 independently validates native negatives. Any earlier handoff naming AI-03 as executor or AI-02 as Broker/CAS was erroneous and has been corrected. No out-of-owner code edited.


## Native diagnostic additional hardening
Linux selftest group termination and nested PID1 parent-death signal; Windows local readback of AppContainer SID and UIAccess. Exact OS acceptance still **NO_GO**, and these diagnostics remain non-executing task probes.


### Forced teardown caveat
A group kill is not a certified descendant-drain mechanism for an arbitrary task. Timeout cleanup failure is explicitly non-PASS; kernel-signed Job/cgroup readback, identity-fenced cancellation and external CAS remain P0.

### Additional Linux evidence gate (31 Oct)
The unshare caller's future-child PID namespace is now directly checked via `pid_for_children` and parent-owned process group identity. Post-seccomp file open attempts must fail with `EPERM`. No native task runner is enabled, and all external physical acceptance remains NO-GO.

### Two-stage PID namespace witness
A second bounded outer-parent kernel readback now precedes the gate for the test-only namespace PID 1. This corrects early `pid_for_children` inspection, keeps task execution disabled, and does not establish any release-ready OS sandbox.

### PID1 gate hardening
Addressed premature direct-parent SIGPIPE termination and late PR_SET_PDEATHSIG installation in disposable probe handshake. Deny-only OS task dispatch and external production NO-GO remain unchanged.

### Additional denial/teardown hardening
Eliminated inner Linux PID1 unbounded wait on both rejection and success paths; strict source-level NUL/length checks for task argv/path. Real OS kernel witness, Job/cgroup descendant drain and protected worker identity are still absent, therefore **NO_GO**.

### Direct diagnostic child orphan-fencing
Added pre-unshare parent-death signal + original parent PID race guard on the **disposable selftest** child only. No native worker launch or permission gate opened; OS-kernel independent verification, descendant drain and platform integration remain production NO-GO.

### Aggregate input-boundary restriction
Conservative combined argv length and targeted negative tests prevent source-only requests with excessive or NUL-truncated command parameters being mistaken for valid input. Real OS native request binding, independent caller authorization and kernel isolation remain **NO_GO**.

### Isolated OS kernel evidence added
Added reproducible `test/ai07-sandbox-linux-parent-death.test.ts`: native Linux PIDFD/subreaper parent-death behavior with a deliberate RED control when fence is disabled. Isolated Linux 6.18.57/GCC 14.2 validated positive exit 0 and negative exit 55; exact repository HEAD CI pending. Production worker, Windows MSVC/AppContainer, Linux task namespace/cgroup and descendant revoke remain NO-GO.

### Native test process-cleanup guarantee
The disposable Linux kernel negative test now avoids unbounded actor `waitpid` and attempts exact-owned PIDFD/fallback cleanup plus subreaper reap on failure paths, marking uncertainty BLOCKED. Still requires exact-head CI and independent worker acceptance.

### Kernel FD/seccomp diagnostic (1 Nov 2026)
Added disposable Linux native fixture `test/ai07-sandbox-linux-fd-seccomp.test.ts` with independently failing disabled-close_range and disabled-seccomp controls. Local isolated Linux 6.18.57/GCC 14.2 observations: protected exit 0, no-FD-close exit 53, no-seccomp exit 55; Node22 standalone test 1/1 PASS. Exact-head repository CI must still confirm this commit. No real task worker, Windows OS isolation or revoked process tree acceptance; production NO-GO stays.
