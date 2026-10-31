# AI-02 | test evidence (exact SHA required)

## Verified baseline and earlier heads

- #984 parent `9d0f35607d4cde87bd031e2da77855cfaf570c31`: CI [41145160595](https://github.com/Naveax/Nexowire/actions/runs/41145160595) SUCCESS 8/8. **Parent evidence only**.
- AI-02 `a8e81f9188ce59e65c05c5349377df554e578be2`: CI [41196473837](https://github.com/Naveax/Nexowire/actions/runs/41196473837) automatically **CANCELLED** on newer commit; its Windows native suite had 3 PASS / 1 FAIL caused by nested Windows PowerShell 5.1 `Get-FileHash` module autoload, not security assertion weakening. Never label that run green.
- AI-02 `a847fa10047a738b175ffd71a981791c6cfffab8`: CI [41196792149](https://github.com/Naveax/Nexowire/actions/runs/41196792149) **SUCCESS 8/8**; fixed test runner uses `pwsh` for non-mutating disposable preflight. Windows .NET10 native job 4/4 PASS, 0 FAIL.
- AI-02 `e39cbfe29ac5cdb92a89b7b3abf5a253413c883a`: CI [41198403395](https://github.com/Naveax/Nexowire/actions/runs/41198403395) observed 7/8 SUCCESS and browser-live pending. Native Windows job 124529136098 SUCCESS; .NET10 build 0 warning/0 error, 4/4 PASS, 0 skip; opt-in 192-file package, `installed=false`. Full run verdict remains pending.

## New candidate tests requiring fresh exact-HEAD CI

- Native diagnostic self-test now covers local active-console policy negatives (mismatched session, remote protocol, disconnected and no active console), strict `status` vs `attest` framing, CNG signing, and **disposable** real-Windows kernel file-share exclusion / timeout cancellation / successful reopen. All are test-only fixtures and must not be called real owner approval.
- Installer read-only preflight uses a fake executable, temporary manifest and current SID; rejects mismatched owner, missing identity fields and cross-installation requests without installing.
- Opt-in uninstall no-service preflight is read-only. It does **not** test an actual SCM stop, deletion or restore.
- For new exact source HEAD: `node --test --import tsx test/core-persistent-enrollment-v2.test.ts`; `node --test --import tsx test/windows-local-enrollment-native.test.ts`; `npm run typecheck`; Windows `dotnet build native/windows-local-enrollment/Nexowire.LocalEnrollment.csproj -c Release -o native/windows-local-enrollment/bin/qa --nologo`; PowerShell `Parser.ParseFile` and opt-in build. Record CI run/status/exit codes after commit.

## NOT TESTED / barriers

- Actual locally installed SCM service/hostile IPC client, authentic signed owner ceremony, hardware TPM attestation, real clock/restart/rollback, two-device rollout, offline revocation and independently operated restore/revoke authority: **NOT TESTED**.
- Local assistant container lacks `dotnet`, PowerShell and repository dependency checkout. Never claim local success on the basis of remote/fixture tests.
- The new lock-file and console policy diagnostics exercise disposable OS features; they do not establish protected ProgramData ACL correctness or two-PC physical acceptance.
- The parent PR's CI artifacts and prior SHA PASS are not transferred to a new SHA. No duplicate dispatch/rerun on an active SHA/workflow/input.
