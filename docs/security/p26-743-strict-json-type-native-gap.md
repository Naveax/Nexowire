# W26 against #743: strict JSON type confusion and real importer gates

**Independent P0 QA, DRAFT, production NO-GO.** Exact #743 reviewed HEAD 7bc16b4cd1010803a4b13cdbdf95a1c02578cade (all 3 CI workflows SUCCESS). Exact #707 reviewed HEAD 1ef44efc7b143b152ad178ddd0eef9cd627bade2 (CI 39677122273 SUCCESS). Neither is a deployed signed HIGH Broker or complete native importer.

## #743 versus #707 and existing coverage

#743 read-only scripts/audit-core-broker-protected-tree.ps1 supports two parameter sets: strict UTF-8/base64 JSON envelope and historical named paths. Both normalize to a single version/path/import-array parser and Windows FileSystemAclExtensions.GetAccessControl / GetAccessRules. Import path list is supplied by the caller and the report explicitly marks transitiveImportsIndependentlyEnumerated=false, nativeEffectiveLowPrivilegeAccessCheckCompleted=false, signedImportManifestVerified=false, protectedCompleteImageTreeAttested=false, elevatedCoreDispatchEnabled=false, productionReady=false. Enumerating DACL entries is not token-aware effective AccessCheck and does not attest installed signed imports or held OS handles.

#707's source contract requires independently signed manifest plus complete discovered transitive import closure, per-DLL SHA256, cert SHA256, Authenticode Valid, retained no-follow handle, readback file ID and volume, protected anchored parent-relative chain and effective ACL for protected roots, every intermediate directory and each imported DLL. The producer for independently observed Windows file/signer/ACL facts is not deployed. #743's simple JSON report is not a VerifiedFilesystemBoundary / ProtectedImportGraph attestation or an execution grant.

Already covered by #707/#723/#743: negative transitive graph/signers, reparse/junction/hardlink/ADS, post-rename file ID, inherited insecure TEMP ACE. Do not repeat their tests.

## Independent P0 strict-schema negative is now an actual fail-closed RED gate

Original #743 exact source contains PowerShell version check `$request.version -cne 1`, which permits wrong JSON types through implicit comparison coercion. Exact read-only audit PowerShell blob `87c18f60a36149df3798a2d3911c004ffbe38668` is byte-identical on #743, #756 and this #753 QA child; **no #03 source fix was present during this audit**.

- JSON numeric `1`: accepted correctly with readonly envelope-v1 report.
- JSON string `"1"`: **accepted incorrectly**; should deny.
- JSON boolean `true`: **accepted incorrectly**; should deny.
- JSON array `[1]`: **accepted incorrectly**; should deny.
- JSON object as version: denied.
- Numeric `2`, extra keys, missing version: denied.

Test `test/p26-743-strict-envelope-version-type-negative.test.ts` changed from an informational *reproduce-and-pass* assertion to an ACTUAL fail-closed acceptance gate that **must reject all wrong version types**. It deliberately stays **RED on original #743 source**. A green result from the old HEAD is historical and does NOT pass this new acceptance requirement.

Second *new* independent test `test/p26-753-envelope-malformed-legacy-negative.test.ts` checks that malformed root documents (null, scalar, list, truncated JSON), extra and case-confusable keys, wrong import-list types and shapes, missing fields, and incomplete legacy switch args are rejected. It also proves the same TEMP fixture is inspected via both a strictly numeric v1 JSON envelope and the legacy `-ProtectedInstallRoot`, `-LauncherPath`, `-UpdaterPath`, `-ImportedModulePaths` PowerShell interface. Both successful read-only reports must keep every production authority flag false.

**Observed independent Windows Node22, isolated TEMP** on test-only SHA `bf638ae49342299d8e2b0be9ef468536684a40a6`: 2 tests, **1 PASS (malformed/legacy), 1 expected P0 FAIL (string/true/[1] misaccepted), 0 SKIP**, typecheck PASS; no OS ACL changes. These test cases do NOT modify production source. Child exact-head CI must be inspected and will be RED until #03 implements and verifies a strict typed integer v1 validator.

#03 owner fix belongs in #03's own branch: test JSON numeric *type*, integral value and exact supported version before coercive equality or cast; reject string, bool and arrays. Preserve BOTH legacy parameter set and current base64 envelope routing into a shared fail-closed schema validator, retain unchanged QA17/QA19 and return `productionReady=false`. Never weaken rejection assertions merely to make CI green.

## Physical P0 blockers to #03 and #05

1. Independently authenticated protected signed installed manifest plus full PE normal/delay/dynamically resolved loader import inventory, never selected by request JSON.
2. Actual OS OpenFileById or NtCreateFile RootDirectory importer with held handles, same-open-file post-readback ID/volume/disk/partition, Authenticode signer/cert and SHA256 readback, native owner DACL and low-trust rights at every protected ancestor/import. A path-based FileSystemAclExtensions summary is NOT equivalent.
3. Atomic handle-relative write/rename/delete executor and current owner epoch authorization/readback; no post-preflight pathname mutation. Signed high-token Broker, #271 and #551 remain NO-GO.

No real ACL changes, UAC, live Agent/Broker/service, user files, USB, VM, ReVoltVPN-Ubuntu-Lab or production merge.

## Commands

Run at exact child HEAD on Windows with installed dependencies:
~~~powershell
node --test --import tsx test/p26-743-strict-envelope-version-type-negative.test.ts test/p26-753-envelope-malformed-legacy-negative.test.ts
npm run typecheck
npm run build
npm run continuation:check
git diff --check 7bc16b4cd1010803a4b13cdbdf95a1c02578cade...HEAD
~~~

Hosted CI must be evaluated on exact final SHA separately from parent #707/#743 successes. Any RED due strict-version misacceptance is a real unresolved fail-closed acceptance defect, not a reason to drop the test.
