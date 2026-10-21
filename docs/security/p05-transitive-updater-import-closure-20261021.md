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

## Production block

#271 protected runtime and effective parent ACL, #551 installer/rollback/signed owner high-token Broker, independent Windows native protected witness producer and handle-relative atomic writer remain NO-GO. Existing production elevated files capabilities remain unsupported. No live Agent/Broker/UAC/ACL/USB/VM or user files, no #08 transfer store, and no physical 1 GiB fixture are touched.
