# #03 P0: strict JSON version source fix and truthful Windows trust blockers

**Date:** 2026-10-22. Owner #03 isolated child of #756. DRAFT / production NO-GO.

## Exact provenance and regression

- #743 HEAD `7bc16b4cd1010803a4b13cdbdf95a1c02578cade`:
  main CI + QA17 + QA03 hosted **3/3 SUCCESS**.
- #756 HEAD `d4ed32f72701e5157929cbb9d36bdf0a90fc0d57`:
  dedicated Windows native QA `39736305459` **SUCCESS**; full CI
  `39736305461` **SUCCESS**.
- #753 HEAD `72ff16a23881c9dfde52f7bb5190bdf6185457e5`:
  independent QA26 identified PowerShell `-cne 1` JSON coercion, so
  numeric JSON `1`, string `"1"` and JSON `true` all passed the old
  version-v1 source gate. Its original diagnostic test expects incorrect
  acceptance, and therefore **should be revised by QA26** after this fix.
  Do not delete or weaken independent negatives to manufacture CI green.

## Narrow owner-source correction

One source file `scripts/audit-core-broker-protected-tree.ps1`:
- Require `request.version` to be actual **Int64/Int32** numeric integer
  and its value exactly `1`. `ConvertFrom-Json -AsHashtable` gives
  `Int64` for literal JSON `1`; legacy PowerShell named parameters
  construct `Int32` `1`. Both remain supported.
- Reject JSON string `"1"`, boolean `true`, floating `1.0`, exponent
  `1e0`, arrays/objects/null and unsupported versions, **before any
  file or ACL traversal**.
- Reject numeric, boolean, null, nested-array/object values inside
  `importedModulePaths` **before** casting to PowerShell `[string[]]`.
  The previous type conversion could silently coerce invalid imports.
- Preserve historical `-ProtectedInstallRoot`, `-LauncherPath`,
  `-UpdaterPath`, `-ImportedModulePaths` read-only interface and
  the base64 JSON parameter set. All pass the same strict schema and
  actual native OS file/ancestor ACL inspection. Keep original #705/#717
  and #709 negative tests unchanged.

Source-only test `test/core-broker-strict-json-v1-schema.test.ts`
uses actual disposable Windows TEMP EXE/import/updater files. The test
checks an accepted numeric v1, fourteen rejected wrong-type/version
literals, rejected malformed typed imports/extra fields, and accepted
historical legacy invocation **without enabling production**.

## Physical OS rights / PID boundary truthful disposition

#756 physically measured OS current-test-token effective CreateFile
`WRITE_DATA` and parent `ADD_FILE` after test-owned AU DENY: actual
ALLOW/DENIED behavior confirmed. It separately measured Win32 real
synthetic process `PID + creation FILETIME + image path`, caller token,
and same-user `PROCESS_DUP_HANDLE` open **ALLOW**.

This is **not** a low-integrity / foreign-owner protected HIGH Broker
acceptance. Actual independently signed HIGH Broker not installed:
- no signed protected installed EXE/import/updater manifest or rollback
- no externally enumerated complete transitive PE import dependency tree
- no independent lowpriv restricted-token effective ACL AccessCheck
- no kernel process/Job handle DACL denying attacker
  `PROCESS_DUP_HANDLE`, and no off-host owner epoch verifier
- no actual installed Broker PID/image FileID/FILETIME high-token proof

The executor is source-only:
`CORE_EXECUTOR_DISPATCH_ENABLED=false`,
`productionReady=false`, `elevatedDispatchEnabled=false`.
The #271 writable elevated ProgramData tree, #551 signed installer,
#576 same-user Job handle retention, and #323/#617 effective enrollment
are still **hard production NO-GO**.

No installed Broker, live UAC, elevated shell, service, Agent, VM,
ReVoltVPN, production ACL mutation or user process operations.
