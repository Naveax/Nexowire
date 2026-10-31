# AI-07 | INTEGRATION_REQUEST — coordinator-only native collision and runtime

## Latest verified frozen source snapshots
- AI-07 Draft [#990](https://github.com/Naveax/Nexowire/pull/990), parent `a6900ab9695d3524ca8999d3bd62975c3d4bab59`, base `68ee74ce7e1e5a36c8ae2f9b065f49a5cb13cee9`.
- Coordinator Draft [#1004](https://github.com/Naveax/Nexowire/pull/1004) head `d1bba9615b279d22e9878a7750ce2d6395c20c53`, base `d4f034ac6068e5228b3cc192eb6e1a2d02029709`. `d4f034...` is an ancestor **8 commits behind** AI-07's `a6900ab9695d3524ca8999d3bd62975c3d4bab59`; rebase/regenerate the coordinator child on a **new frozen AI-07 exact HEAD** instead of merging stale child changes or overwriting owner source.
- Child rename is **coordinator-owned**. Do not mutate #1004 from AI-07 branch and do not add a second renamed C file here.

## Lossless Windows C source preservation
- #980 integration introduced `native/task-os-sandbox-windows-appcontainer-probe-p07.c` as a distinct 691-line fixture (blob `df5af96e247816d0e628796ae4a7bc92915f5c95`).
- AI-07 #990 introduces a separate 126-line token/Job diagnostic under the same path (blob `7d56907b7e832b9682e879cd3b9db96d34f424f2`).
- #1004 has already moved that AI-07 diagnostic **byte-for-byte**, verified exact matching blob `7d56907b7e832b9682e879cd3b9db96d34f424f2`, to `native/task-os-sandbox-windows-token-job-readback-p07.c`. It also updates `test/ai07-sandbox-windows-msvc-p07.test.ts`, `test/ai07-sandbox-windows-probe.test.ts` and two handoff docs to reference the renamed diagnostic.
- **Coordinator integration acceptance:** preserve both distinct C blobs in different paths, adjust only child-owned path references, validate `cl /W4 /WX` plus `--selftest-only` and invalid-argv exit 64/normal-host exit 77. Redo non-destructive frozen-head merge-tree rehearsal against #980 and exact latest #990, without blind merge/rebase or overwriting either implementation. A conflict-free Git tree is **not** sandbox containment evidence.

## Production dependency handoffs
- **AI-05:** pre-effect, no-spawn-fallback deny-only executor/CAS integration; immutable task request bytes and UNKNOWN lost-ACK handling.
- **AI-04:** independently protected Broker admission/receipt, exact process PID+creation identity and OS Job/native containment verified outside worker.
- **AI-02/AI-03:** real protected enrollment + authenticated transport only, neither one creates sandbox permit.
- **AI-08:** adversarial C/JS source and real native negative checks for nested process, breakaway, file symlink/hardlink, network/IPC, inherited handles/env, revoked grant and unsupported kernel readback. Synthetic tests cannot be physical owner approval.
- Required real native worker provider still absent; a `--selftest-only` probe is never a task runner. **CORE_EXECUTOR_DISPATCH_ENABLED=false, CORE NO-GO, Draft only**.
