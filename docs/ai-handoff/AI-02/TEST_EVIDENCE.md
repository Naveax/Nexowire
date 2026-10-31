# AI-02 | test evidence

## Baseline (not new branch evidence)

- Parent Draft #984 source SHA: `9d0f35607d4cde87bd031e2da77855cfaf570c31`.
- Existing workflow `CI` run **41145160595**, completed SUCCESS on that SHA; 8/8 job outcomes read through GitHub connector. Native Windows job included actual disposable CNG diagnostics, not local approval/service rollout.

## AI-02 isolated source changes

- New negative `test/core-persistent-enrollment-v2.test.ts`: reject owner-account Unicode, whitespace, control/escaping, slash, too long/short while retaining native-compatible ASCII positive fixtures.
- Extended `SelfTest.cs`: parser-only rejection of denied, wrong version, claimed dispatch, explicit error and missing evidence response frames.
- New Windows preflight tests: disposable temp runtime/manifest and current non-elevated owner SID; `-PreflightOnly` must reject cross-installation, cross-account and missing trusted identity fields. No runtime execution or service install.
- New uninstall smoke test: no-service `-Execute`-absent preflight only; preserves protected evidence. No actual SCM delete.

## Local tools and actual results

- `git ls-remote https://github.com/Naveax/Nexowire.git HEAD`: exit 128; github.com DNS resolution unavailable. No local clone/worktree or dependency tree.
- Node `v22.16.0` available. `tsx`, `zod`, `dotnet`, `pwsh` and `gh` missing.
- Repository `node --test --import tsx ...`, `npm run typecheck`, Windows `dotnet build`, PowerShell packaging parse: **NOT RUN locally**, not PASS.
- New exact-head GitHub Actions CI: **pending until Draft PR**. Never inherit parent CI success.
- Windows-native self tests, positive/negative preflight and PowerShell syntax still require the repository's existing Windows CI job. Physical process-source authentication, malicious pipe client, actual SCM restart/crash, TPM and two-device enrollment remain **NOT TESTED**.
- No security negative assertion removed or deliberately skipped.

## Required later tests

Actual Windows isolated host: named-pipe wrong owner/session/physical-console and same-user unauthorized executable, partial IPC writes/timeouts, service stop/restart and crash, corrupted protected file, revoked generation and stale challenge, machine key ACL and restart, installer rollback after interruption, and offline revoke with actual independent issuer. **These are not claimed by CI.**
