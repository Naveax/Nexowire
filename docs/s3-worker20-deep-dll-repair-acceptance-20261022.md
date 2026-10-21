# #20 independent transitive leaf / rollback-repair QA

Date: 2026-10-22. Source-only child of #714 exact HEAD `d7e5f98b5b286d9884381edc6bb38eae036a8449` (not #709's branch). #706 exact HEAD `6a2a1d8a2b04549a051db86291cadd99cddc82ea`, CI #39658875463 **SUCCESS**. #709 exact HEAD `b083004b9ab8c18125a428cf74f3e97f7adf4e88` verified protected Windows ACL/ancestor readback on disposable fixtures, NOT an independently enumerated or Authenticode-signed full transitive graph. #714 adds post-switch volume/file/native image identity checks but is still source-only.

## Narrow new independent negatives

- Build a **two-hop** signed import fixture: signed Broker imports `runtime/native.dll`; that DLL imports `runtime/plugins/provider.dll`; this imports `runtime/plugins/deep/crypto.dll`. Stage manifest SHA/signature and independently signed import DAG are freshly computed using **test-only** Ed25519 keys. Native DAG reports full closure and stage ACL path inventory includes every ancestor.
- A forged **publisher Subject** or executable SHA256 reported for the deep leaf, or changed deep bytes with the original independent signed manifest, must be rejected. The parent Broker/first-hop DLL signatures stay valid. A missing *second-hop* edge in native readback must be rejected even if the signed stage lists the DLL.
- After owner re-pair, old signed **Agent 1.0.5** rollback may not silently change Windows volume provenance between before/after readback while preserving SHA and file ID. Wrong rollback Authenticode publisher also fails. Distinct from existing #714 fileIdentity-only rollback cases.
- A signed new owner epoch with distinct new DPAPI blob still rejects old SYSTEM DPAPI owner-key epoch on re-pair, despite source witness claiming previous task disabled, previous owner revoked, and previous key unusable. Distinct from previous old/new blob hash reuse.
- Positive source fixture must still report `physicalSwitchAccepted:false`, `realWindowsUacEnrolled:false`, `canResume:false`, `canRollbackAutomatically:false`, `canDispatchCore:false`, `productionApproved:false`.

The fixture scaffolding mirrors public #714 exported contract shapes without touching owner files. None of this establishes trustworthy Windows import discovery, Authenticode trust, physical signed old Agent rollback, externally non-restorable epoch/CAS, genuine local UAC, DPAPI key destruction, atomic switch, or HIGH token. Signed mock records are never OS authority.

## Compared with #709 source

`scripts/audit-core-broker-protected-tree.ps1` reads Windows ACL and path/ancestor evidence for explicitly provided imported modules and intentionally reports `importListIndependentlyEnumerated:false`, `publisherOfEveryImportVerified:false`, `signedImportManifestVerified:false`, and `protectedCompleteImageTreeAttested:false`. No joining a seemingly clean #709 ACL readback to a signed #714 graph without independent full native loader attestations.

**PRODUCTION NO-GO; P0 #271 remains unremediated.** Only QA/test and this document added in an isolated branch. No installer, live ACL, UAC, Agent, Broker, service, DPAPI, VM, native file mutation or ReVoltVPN-Ubuntu-Lab. No owner #12/#03 changes, no merge or deployment.
