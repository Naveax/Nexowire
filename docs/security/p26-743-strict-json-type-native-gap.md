# W26 against #743: strict JSON type confusion and real importer gates

**Independent P0 QA, DRAFT, production NO-GO.** Exact #743 reviewed HEAD 7bc16b4cd1010803a4b13cdbdf95a1c02578cade (all 3 CI workflows SUCCESS). Exact #707 reviewed HEAD 1ef44efc7b143b152ad178ddd0eef9cd627bade2 (CI 39677122273 SUCCESS). Neither is a deployed signed HIGH Broker or complete native importer.

## #743 versus #707 and existing coverage

#743 read-only scripts/audit-core-broker-protected-tree.ps1 supports two parameter sets: strict UTF-8/base64 JSON envelope and historical named paths. Both normalize to a single version/path/import-array parser and Windows FileSystemAclExtensions.GetAccessControl / GetAccessRules. Import path list is supplied by the caller and the report explicitly marks transitiveImportsIndependentlyEnumerated=false, nativeEffectiveLowPrivilegeAccessCheckCompleted=false, signedImportManifestVerified=false, protectedCompleteImageTreeAttested=false, elevatedCoreDispatchEnabled=false, productionReady=false. Enumerating DACL entries is not token-aware effective AccessCheck and does not attest installed signed imports or held OS handles.

#707's source contract requires independently signed manifest plus complete discovered transitive import closure, per-DLL SHA256, cert SHA256, Authenticode Valid, retained no-follow handle, readback file ID and volume, protected anchored parent-relative chain and effective ACL for protected roots, every intermediate directory and each imported DLL. The producer for independently observed Windows file/signer/ACL facts is not deployed. #743's simple JSON report is not a VerifiedFilesystemBoundary / ProtectedImportGraph attestation or an execution grant.

Already covered by #707/#723/#743: negative transitive graph/signers, reparse/junction/hardlink/ADS, post-rename file ID, inherited insecure TEMP ACE. Do not repeat their tests.

## One uncovered strict-schema negative

In #743 source, the PowerShell check of request.version using -cne 1 permits JSON values with the wrong types through coercion:
- numeric 1: accepted correctly.
- string "1": incorrectly accepted as envelope-v1-readonly.
- boolean true: incorrectly accepted as envelope-v1-readonly.
- numeric 2 and an unknown extra field: rejected as expected.

Only new QA test: test/p26-743-strict-envelope-version-type-negative.test.ts. It reproduces the current invalid acceptance on disposable TEMP files. A PASS means the missing type check was observed, NOT that the input is safe. After #03 corrects this source validation, the QA test must change from documenting the currently accepted wrong types to requiring denial (and the previous assertion should fail). No installed or user file is executed, and all reports remain productionReady=false.

#03 owner fix belongs in #03's own source: require strict JSON INTEGER version === 1 using explicit runtime type validation before comparison, retain common schema for legacy and envelope and preserve all existing negative tests. No #26 owner source edit.

## Physical P0 blockers to #03 and #05

1. Independently authenticated protected signed installed manifest plus full PE normal/delay/dynamically resolved loader import inventory, never selected by request JSON.
2. Actual OS OpenFileById or NtCreateFile RootDirectory importer with held handles, same-open-file post-readback ID/volume/disk/partition, Authenticode signer/cert and SHA256 readback, native owner DACL and low-trust rights at every protected ancestor/import. A path-based FileSystemAclExtensions summary is NOT equivalent.
3. Atomic handle-relative write/rename/delete executor and current owner epoch authorization/readback; no post-preflight pathname mutation. Signed high-token Broker, #271 and #551 remain NO-GO.

No real ACL changes, UAC, live Agent/Broker/service, user files, USB, VM, ReVoltVPN-Ubuntu-Lab or production merge.

## Commands

Run at exact child HEAD on Windows with installed dependencies:
~~~powershell
node --test --import tsx test/p26-743-strict-envelope-version-type-negative.test.ts
npm run typecheck
npm run build
npm run continuation:check
git diff --check 7bc16b4cd1010803a4b13cdbdf95a1c02578cade...HEAD
~~~

Hosted CI must be evaluated on exact final SHA separately from parent #707/#743 successes.
