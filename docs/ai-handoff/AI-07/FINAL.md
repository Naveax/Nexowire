# AI-07 scoped handoff (2026-10-31)
**Decision: NO_GO for production, Draft source review only.**
Changed files: `src/agent/task-os-sandbox-policy.ts`; `native/task-os-sandbox-windows-appcontainer-probe-p07.c`; `test/ai07-sandbox-windows-probe.test.ts`; `test/ai07-sandbox-mutation-state.test.ts`; `docs/ai-handoff/AI-07/{STATUS,CONTRACT,TEST_EVIDENCE,INTEGRATION_REQUEST,FINAL}.md`.
- Source/static Windows C tests: 2/2 PASS on Linux Node 22.16.0, not OS proof.
- New mutation test, full repo typecheck, Windows MSVC, native kernel/physical tests: not locally run; consult new exact-head Actions.
- Existing #859 CI 40547392793 SUCCESS only applies to original SHA, not this branch.
- Missing: production OS worker, #03 admission, signed owner/CAS, independent AppContainer/Job handle/disk/network isolation, descendant cleanup and verified revoke.
- No other-owner file mutation, merge, deploy, UAC/ACL/service, real Agent or OS policy changes.
- Child Draft PR URL, final HEAD SHA, exact CI run IDs: read live Github metadata, not an embedded self-referential SHA.

## Follow-on source hardening
- Linux selftest child closes *all* FDs rather than retaining stdin/out/err and no longer has seccomp write; outer parent owns the synthetic marker. Windows C includes Advapi32 and checks TokenPrimary, Job close semantics. Kernel acceptance remains separate and **NO_GO**.
