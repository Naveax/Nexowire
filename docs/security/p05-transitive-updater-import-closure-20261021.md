# P0 #05: Transitive native imported updater DLL closure

Scope: separate source-only child of #690 (b0e0fb30d908cc255e60cb30dedb4b6099e2c646), opened after independent #26 #694 (76a88b22a76d72d1824559dbd4f741c7f2da1b7d) identified an unattested extra updater import being ignored by the old root-only booleans.

## The new fail-closed source authorization contract

Every transitive imported module requires TWO independent sources of evidence: a trusted signed installed-manifest entry (exact role, protected path, SHA-256 bytes, signing cert SHA-256 and explicit import edges) and an independent retained native OS handle/ACL/image-witness entry. The two inventories must contain precisely the same file keys. Discovered imports, including PE delay-load and an independently enumerated dynamically resolved load policy, must exactly equal the signed manifest graph. Missing, injected, duplicated, orphaned or cyclic references deny.

Each entry must be opened relative to a verified protected parent/updater/import-tree HANDLE, witnessed as either NtCreateFile with RootDirectory or OpenFileById; its derived path, held file ID, volume serial/GUID, disk and partition must match the expected immutable source pin. No junction/reparse traversal, hardlink alias, ADS or crossing a volume boundary is accepted. Native file ID and volume are reread after hash/signature readback on the SAME retained handle. Role-wide ACL/signing booleans cannot replace an imported DLL's independent effective ACL rights, exact SHA-256 and authenticode signing certificate fingerprint.

Policy remains source-only. This module does NOT invoke NtCreateFile or OpenFileById itself. No independent, protected Windows provider has been connected to build signed-manifest or OS handle/DACL/Authenticode witnesses; mock objects can lie. Real dynamic LoadLibrary/LoadLibraryEx resolution under native Windows loader semantics and all OS DLLs require an exhaustive publisher-enforced trusted inventory before any production grant can be considered. An absent inventory explicitly denies, not enables, an elevated operation.

## QA

- New test: test/p05-transitive-protected-import-negative.test.ts
- Existing source and temporary Windows tests remain in the parent chain.
- Independent #26 #694 findings and its exact-head CI SUCCESS are inputs for design, not proof of this child HEAD.
- Exact child SHA and Actions run tracked in DRAFT child PR after opening.

## #723 independent QA versus #709 protected-tree audit

Independent #26 #723 at 7dc98916538c4f957dad5660ff6d328a2f932d3e (hosted CI 39659567874 SUCCESS) verifies the weakness in the earlier #690 root-wide Boolean acceptance, including Windows TEMP CreateFileW junction/ADS/hardlink and grant-volume/parent changes. Current #707 handles the transitive DLL manifest through mandatory per-import witnesses; #723 was based on #690 and is not a source implementation of #707.

#709 at b083004b9ab8c18125a428cf74f3e97f7adf4e88 (hosted CI 39658979397 SUCCESS) runs read-only Windows security descriptor/ancestor checks on its own explicit JSON-envelope list of import paths. This is useful separate native TEMP ACL evidence, but the caller chooses the list and the report explicitly sets importListIndependentlyEnumerated=false, signedImportManifestVerified=false, publisherOfEveryImportVerified=false and productionReady=false. Consequently, its readable path booleans and wide SID filter do NOT meet the privileged #05 typed NativeEffectiveAcl and retained-handle signed-manifest requirements. No files or imports from #709 were copied into #707 or executed as an ACL audit on this device.

The #707 closure now additionally requires a **separate effective ACL witness for each directory strictly between its protected anchor and every imported binary**. This witness must be bound to that open directory handle's file ID, correctly pinned parent chain and physical volume. Missing or mismatched intermediate security descriptors, inherited low-trust write/delete-child rights, reparse/junction and post-open rename changes deny. Parent/updater/import root ACLs are checked as well. Merely attesting the top-level updater directory cannot authorize a user-writable child directory.

Native file ID remaining unchanged is NOT evidence that a writable file's contents remained unchanged after the first hash. For each DLL, source policy now demands a second SHA-256 digest and signer-cert fingerprint bound explicitly to the retained native image *after* readback; missing, changed or unbound receipts deny, even when observedAfter.fileId matches. This is a **contract**, not a real kernel-backed data-integrity or Authenticode implementation.

## 2026-10-22: #753 strict JSON version and #756 native kernel ACL/PID evidence cross-check

Independent #26 #753 (HEAD 72ff16a23881c9dfde52f7bb5190bdf6185457e5, hosted CI SUCCESS) found that #743 PowerShell JSON `version: "1"` and `version: true` were accepted as version 1. That is a distinct #03 legacy/envelope parser bug, NOT a reason for #05 to modify #743 or duplicate #753 native QA. The #05 source graph now demands **exact numeric schemaVersion 1**, manifestSignatureVerified===true and every per-import inventory/retained-handle/no-reparse attribute exactly equal to true/false as declared. Missing, string, numeric truthy or object flags deny: no loose Boolean coercion from serialized native-witness envelopes. These tests do not implement the external authenticated witness issuer.

Independent #03 #756 (HEAD d4ed32f72701e5157929cbb9d36bdf0a90fc0d57, exact-head CI SUCCESS) demonstrates *real TEMP-only same-caller* Win32 effective write/create/delete access and read-only native process PID+FILETIME/PROCESS_DUP_HANDLE probes. Their own output explicitly leaves installed high-integrity Broker, separate lowpriv caller token, owner epoch, protected Job/handle rights, complete signed DLL inventory and physical native importer unverified. #05 must not replace source native per-DLL retained-handle/ACL/Authenticode proof with those fixture outputs, and must not claim physical Windows protected importer or actual AccessCheck is integrated.

Existing per-DLL signer/hash, ancestor effective ACL, reparse/junction/ADS, volume, readback identity and scoped grant tests are retained; no duplicate native QA PR created. Production high-integrity issuer and independent Windows native protected import/provider/writer acceptance remain BLOCKED (#271/#551).

## Production block

#271 protected runtime and effective parent ACL, #551 installer/rollback/signed owner high-token Broker, independent Windows native protected witness producer and handle-relative atomic writer remain NO-GO. Existing production elevated files capabilities remain unsupported. No live Agent/Broker/UAC/ACL/USB/VM or user files, no #08 transfer store, and no physical 1 GiB fixture are touched.
