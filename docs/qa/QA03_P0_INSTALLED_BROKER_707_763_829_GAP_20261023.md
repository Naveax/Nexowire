# #03 P0 cross-audit: HIGH Broker physical-provider boundary vs #707/#763/#829

**Review:** 2026-10-23. **Owner:** #03. **Source base:** PR #829 HEAD
`5715402142968498ce6d53014888e1c39f6e2ac9`, CI `39863445519`
7/7 SUCCESS, dedicated Windows durable `39863445634` SUCCESS.
This child adds ONLY the already-proven #763 PowerShell typed JSON fix, an
unchanged #763 negative test, a separate hosted Windows QA and this note.
**No installed HIGH Broker exists in this acceptance. PRODUCTION NO-GO.**

## Proven missing #03 source integration

- #829 inherited `scripts/audit-core-broker-protected-tree.ps1` Git blob
  `87c18f60a36149df3798a2d3911c004ffbe38668`.
  Its v1 comparison `$request.version -cne 1` was coercive; actual original
  #763 negative `test/core-broker-strict-json-v1-schema.test.ts` Git blob
  `03b39821464cbc2c66735eb18b134aee53a3e48d` reproduced **RED**
  on #829 with `unsupported JSON version "1" was accepted`.
- Original #763 source Git blob
  `e00784bf2a5dcce6faa52f4b7c50805b3c2827fe` was copied
  byte-for-byte into this isolated #03 child. Only actual integral
  `Int64/Int32` v1 is accepted; JSON string `"1"`, boolean `true`,
  floating `1.0`/`1e0`, object and array versions fail closed.
  Non-string imported-module paths reject **before** a `[string[]]`
  coercion; original named `-ProtectedInstallRoot` legacy interface
  remains read-only and valid.
- Original unchanged strict-v1 negative + unchanged protected-tree and
  transitive-import synthetic Windows negatives: **7 PASS, 0 FAIL,
  0 SKIP**. Source fix does NOT allow elevated CORE dispatch or assert
  complete independent imports. No QA17/QA19/durable tests were altered.

## Independent #707 contract versus real OS facts

#707 current HEAD `967a7dc7cc014e655730061fc89d7e93738dccbc`,
CI `39867164984` SUCCESS, is **#05-owned, source-only**.
Do not cherry-pick its source into an installed #03 Broker or claim
its synthetic `provider:'native-retained-handle'` literals are native proof.

| Mandatory installed production evidence | Source contract | Actual accepted native provider |
| --- | --- | --- |
| Signed protected install/release/rollback manifest and trusted publisher, enrolled owner+device+epoch | #707 `ProtectedImportGraph.manifestProvider` + `manifestSignatureVerified`, strict v1 in #763 | **BLOCKED**; no independently trusted release manifest/signer provider |
| Root EXE + updater + all transitive DLL/delay load/dynamic resolution import edges | #707 `pinned[]` exactly equals `observed[]`, per-PE signer/digest edges | **BLOCKED**; OS loader does not supply a proven exhaustive signed graph |
| Retained no-follow file handles and real FileID/volume/partition for EXE, all imports and ancestors | #707 `NtCreateFile.RootDirectory`/`OpenFileById`, root `rootFileId`, `volumeSerial`, `observedAfter`, independently pinned chain | **BLOCKED**; TypeScript metadata and paths are not retained native OS handles |
| Complete effective ACL for every protected file/ancestor, from a separately created low-user token | #707 `NativeEffectiveAcl`, #763 PowerShell GetAccessRules DACL enumeration | **BLOCKED**; #756 physical `CreateFileW` covers only the calling *test* token and TEMP fixture, not real installed HIGH paths or separate low-user |
| Root and guardian real PID+creation FILETIME, retained signed image FileID and exact token HIGH identity | #829 `windows-job-kernel-attestation.ts` verifies synthetic Job root, `scripts/audit-core-broker-fixture-pid-handle.ps1` on #763 synthetic pwsh | **BLOCKED**; none binds an actual installed signed HIGH Broker PID/image+token to the approved release |
| Actual same-user/low-user `OpenProcess(PROCESS_DUP_HANDLE)` and Job-handle acquisition denied, no inherited privileged handles, negative after guardian crash | #576 Job ownership and synthetic #756 `OpenProcess(PROCESS_DUP_HANDLE)` | **BLOCKED**; #756 observed **ALLOW**, an exposure rather than a mitigation |
| Atomic owner epoch/revoke-start/capability grant, off-host rollback-resistant CAS before native mutation | #617 source gate / coordination | **BLOCKED**; source flags and one-host SQLite or synthetic witnesses are not independent CAS |

### Required binding if a native provider is ever implemented

All privileged operations must consume **one immutable admission** joining:
signed installed release and rollback manifest; protected anchor handle /
root FileID+volume; complete module+ancestor handle/signer/ACL closure;
exact owner/device/issuer/requestId/logicalMutationId/sourceSha/epoch;
OS-created installed Broker process PID+FILETIME+image FileID and HIGH
token; independent *lower-user* effective denial of write/delete/WRITE_DAC,
`PROCESS_DUP_HANDLE` and privileged Job-handle duplication; and independent
atomic CAS/revoke fence. Missing, stale, aliased, mismatched, recycled or
UNKNOWN evidence MUST refuse execution and require readback. Never infer
proof from a caller-supplied JSON, JavaScript Boolean, synthetic Windows
TEMP fixture or Job member marker. Owner #05 owns native filesystem
boundary; #03 only owns Broker process/Job consumer seam; #00 owns
integration/release.

### What the source tests DO prove

#829 NWJOB5 volatile+durable listener ordering, output-before-exited
and test-native PID+FILETIME; #763 exact JSON primitive type validation;
#707 transitive image/source contract validation. They DO NOT prove
signed installed HIGH execution, protected importer closure, task-root
filesystem/network sandbox or actual handle DACL. The separate
`CORE_EXECUTOR_DISPATCH_ENABLED=false` gate stays intact. #271
writable elevated tree, #551 signer/rollback, #576 retained Job handle,
#617 native elevated broker and external fencing remain P0 NO-GO.

No main merge, live Agent 1.0.5, Broker installation, UAC, production
ACL/services, Cloudflare D1, user files/processes or VM/ReVoltVPN action.
