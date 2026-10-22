# #03 P0 physical Windows ACL / PID / PROCESS_DUP_HANDLE observations

**Own isolated branch, source-and-synthetic-only. Production elevated CORE/ROOT NO-GO.**

## Precise trust separation

1. Source `scripts/audit-core-broker-protected-tree.ps1` (base #743)
   enumerates declared EXE, imports, updater and ancestor DACL with native
   `GetAccessRules`. Its boolean `nativeEffectiveLowPrivilegeAccessCheckCompleted=false`
   is accurate: DACL enumeration is not an actual OS access check or
   complete dependency enumeration.
2. New `scripts/audit-core-broker-fixture-effective-access.ps1` uses
   `CreateFileW` with `OPEN_EXISTING` and `FILE_SHARE_READ|WRITE|DELETE`
   to ask the actual Windows kernel whether the **calling test token** can
   open synthetic EXE/import/updater files for WRITE_DATA, APPEND, DELETE,
   WRITE_DAC and TEMP parent directories for ADD_FILE, DELETE_CHILD,
   DELETE, WRITE_DAC. It immediately disposes each opened handle and never
   writes or deletes data. An explicit test-owned Authenticated Users
   deny-write switches actual access from ALLOW to DENIED.
   **Only marked TEMP-owned synthetic fixture paths are accepted.**
3. New `scripts/audit-core-broker-fixture-pid-handle.ps1` obtains actual
   `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)`,
   `GetProcessTimes` FILETIME and `QueryFullProcessImageName` on a
   test-created, uniquely marked disposable PowerShell child. It separately
   requests `OpenProcess(PROCESS_DUP_HANDLE)` **without duplicating a
   handle**. The same inspector token's integrity RID and elevation come
   from `GetTokenInformation`. Synthetic PID/time spoof attempts fail.
   The script refuses unrelated processes, any unmarked TEMP root and
   arbitrary image types. Its only child can be stopped by its creating
   test after exact fixture identity proof.
4. There is no real Nexowire-signed HIGH installed Broker to query, and
   no distinct restricted-token effective AccessCheck or complete OS
   transitive import-closure witness. A same-user synthetic
   `PROCESS_DUP_HANDLE` ALLOW result demonstrates why a real guarded
   process handle DACL is necessary; it is **not** verification that
   protected Job handles cannot be retained or duplicated.

## Physical boundaries not implied by local PASS

- `fullTransitiveImportInventoryVerified=false`
- `separateLowPrivilegeTokenBoundaryVerified=false`
- `protectedJobHandleInheritanceAndDaclVerified=false`
- `installedBrokerProcessAttested=false`
- `actualKernelHandleWasDuplicated=false`
- `signedReleaseAndRollbackManifestVerified=false`
- `productionReady=false`
- `elevatedDispatchEnabled=false`

An observed HIGH token on a hosted runner, if any, is the **test
inspector's** token. It must never be attributed to a Nexowire Broker.
It may therefore be insufficient to establish a medium-integrity
adversary denial. Likewise a successful CreateFile write-access opening
requests access only and performs no actual writes; denial and access
unknown are not silently converted to trusted status.

## Regression and owner coordination

- Base #743 HEAD `7bc16b4cd1010803a4b13cdbdf95a1c02578cade`
  has **3/3 hosted workflows SUCCESS**, including unchanged QA17,
  unchanged QA19 Windows 100-cycle fast-exit and real guardian PID FILETIME.
- New independent Windows workflow tests the kernel file-access and
  synthetic process-handle probes plus unchanged #709 tree/witness source
  tests. Hosted CI results must be checked at the new exact SHA.
- #271 current inherited writable elevated ProgramData ACL is not touched
  and remains production P0 NO-GO.
- #551 real pinned Nexowire-signed EXE/import/update installer and signed
  rollback/provenance are unaccepted.
- #576 same-user kernel Job guardian `PROCESS_DUP_HANDLE` retained-handle
  gap is not fixed by opening a test-owned process.
- #323 and #617 CORE enrollment/high token, independent owner epoch,
  external CAS and local physical one-time UAC bootstrap remain blocked.
- #19 QA untouched; do not merge into main independently of #00.

**No live Broker, elevated shell, UAC automation, Agent/service, VM,
ReVoltVPN, real ProgramData ACL changes, or existing user process kills.**
