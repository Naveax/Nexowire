# P0 Worker #26: #707 intermediate native import-ancestor ACL evidence

**Independent source-only test, DRAFT, production NO-GO.** This child is based on owner #707 exact HEAD 5ac01095e63ba51632cc5166f3a4b2bbf8f2d996; owner CI 39659960377 was independently verified SUCCESS. Previous #26 #723 HEAD 7dc98916538c4f957dad5660ff6d328a2f932d3e, CI 39659567874 SUCCESS.

## Previously covered by owner #707: no duplicated negatives

Existing owner source and p05-transitive-protected-import-negative tests cover per-DLL pinned SHA-256 + signing-cert SHA-256, Authenticode Valid, signed manifest vs complete discovered transitive import inventory, exact dependency edges, missing/extra/duplicate/cyclic modules, same-held-handle post-readback ID and volume, OpenFileById/RootDirectory model, reparse/junction/hardlink/ADS/path aliases, and root + DLL effective ACLs. Prior #723 read-attributes-only TEMP Windows probes already cover real NTFS hardlink/ADS and retained renamed junction identity. No redundant new native TEMP fixtures were added here.

## One independently reproduced source-model gap

An import-relative chain NativeRelativeStep carries a child NativeHandleEvidence and parent file ID, but no mandatory independently observed **effective ACL/security descriptor bound to each intermediate directory handle**. In the valid synthetic graph the pinned source is reached via an intermediate privileged-broker directory below ProgramData Nexowire. Owner #707 validates no-follow, file ID, volume and final path but lacks a per-child-DACL predicate. The protected root's descendantsChecked boolean is not a separately inspectable real DACL for that intermediate directory.

New test: test/p26-owner707-intermediate-ancestor-acl-negative.test.ts
1. Confirms intermediate directory handle carries no per-step effective ACL.
2. Confirms baseline actual owner assertNativeProtectedFileBoundary accepts the synthetic good graph.
3. Adds a **test-only** explicit effectiveAcl object with provider unavailable, untrusted SID, unprotected DACL and a write-DAC ALLOW ACE. The **unchanged #707 owner policy still accepts** because that extra field is not in the relative-step schema.

This is a source evidence-model limitation, NOT a proven real vulnerable Windows ACL, privilege escalation, or an attested bad directory. The injected evidence field is synthetic and untrusted.

The #05 owner should require a trusted native GetSecurityInfo/equivalent protected observer per OS-open intermediate ancestor, bind owner SID, DACL protection, effective untrusted write/delete-child/WRITE_DAC/WRITE_OWNER ACE masks and exact file ID/volume/grant epoch to the same retained handle, and deny provider UNAVAILABLE or changed identity before native handle-relative mutation. Retain all current per-import signer/hash/import inventory tests.

## Production NO-GO

No deployed protected Win32 importer/ACL/Authenticode witness producer, signed installed manifest attestation, actual elevated CORE high token, or atomic relative writer was tested. No #05 source files or previous QA tests were modified. No user file, Agent/Broker, UAC, ACL mutation, VM, ReVoltVPN-Ubuntu-Lab, USB, or 1 GiB allocation. Do not merge or deploy for physical acceptance.

## Exact QA command

Run in an isolated checkout at the final PR HEAD:

~~~powershell
node --test --import tsx test/p26-owner707-intermediate-ancestor-acl-negative.test.ts
npm run typecheck
npm run build
npm run continuation:check
git diff --check 5ac01095e63ba51632cc5166f3a4b2bbf8f2d996...HEAD
~~~

Only claim hosted CI for the exact final SHA once its workflow completes. Do not restart active same-SHA CI. This is a source contract QA proof, not a physical Windows importer proof.
