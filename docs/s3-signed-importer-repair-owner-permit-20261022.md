# Nexowire #12: signed importer root, rollback identity and stale owner permit fence
2026-10-22 | own staged child of PR #739 | SOURCE-ONLY / PRODUCTION NO-GO

## Cross-review exact independent evidence
- Parent #739 HEAD aec8a331ab6e3b673ffe59abcb98134e46dfebde exact GitHub CI 39677691555 SUCCESS.
- #743 Windows importer HEAD 7bc16b4cd1010803a4b13cdbdf95a1c02578cade: regular CI 39678489196 SUCCESS; independent QA17 39678489203 SUCCESS; QA03 integrated Windows 39678489269 SUCCESS. It preserves legacy read-only caller parameter compatibility without weakening the strict ACL inspection, and tests real disposable TEMP inherited Modify, nested import and PID creation-time identity. BUT physical effective AccessCheck, independently complete dynamic loader imports and real signed installed HIGH Broker are explicitly unproven.
- #712 nonce/CAS HEAD 1d78a7a9174e91e3b6baaa1319a063917391a64f: CI 39676838080 SUCCESS. Source binds nonce, ownerEpoch and grantGeneration to a signed permit. A physically off-host non-restorable single-use CAS and elevated Broker remain NO-GO.
- #745 worker #28 unchanged signed import/rollback QA HEAD 8a4722341355ee2edd680a35321f9f946c175657: CI 39733783135 FAILURE overall, inherited Physical Windows Job; do not edit or skip worker QA or claim it GREEN.

## Only missing installer-owner contract repaired
Existing #739 native ACL/nonce fence accepted a signed permit tied to Broker SHA and creation identity while leaving release manifest, complete signed importer DAG, signed prior rollback and current DPAPI blob OUTSIDE the permit's signed scope. A stale permit for unchanged Broker bytes could thus be combined with newly signed DLL dependency graph or old owner key snapshots inside a source-only assessment. This was not an execution path; every source result already denied privilege, but it was a genuine consistency gap.
Updated scripts/s3-core-bootstrap-delegation-audit.ts uses a deliberately incompatible signed source permit schema v2 (old v1 receipt fails closed), and signs and checks four extra independent hashes in its source permit: exact pinned stageManifestSha256, pinned signedImportDagSha256, old rollbackSha256 and current DPAPI blobSha256. Expected manifest and DAG pins are separate out-of-band inputs. The ACL report's protectedRoot must equal the release-pinned trustedProtectedRoot, and every signed stage file and SYSTEM DPAPI blob must be inside that exact root. Missing or out-of-root native ancestors still fail closed.
The facade additionally refuses any UNRESOLVED atomic phase, missing journal/postcondition, changed new Broker volume/file identity, mismatched protected updater volume/file identity, replaced signed old rollback file or stale DPAPI owner epoch, even if a single SHA or formerly signed nonce still matches.

## New narrow negative test groups
1. Swapped native protected root / report or DPAPI blob located outside release-pinned root.
2. Re-signed new manifest or import DAG with a formerly signed valid nonce/CORE permit; independent expected source pins inconsistent.
3. Old DPAPI blob, unsigned/replaced previous rollback or foreign post-cutover rollback hash, including a re-signed bad source permit.
4. UNKNOWN native write, same-hash different file identity and stale SYSTEM DPAPI epoch across re-pair.
These extend only the existing owner test file. No duplicate #706/#745 synthetic QA files or #03/#01 owner code modified.

## Truth and physical blockers
The source positive fixture still returns nativeHighTokenAttested:false, ownerOsConsentPhysicallyConfirmed:false, executionApproved:false, productionApproved:false. The new signed source permit is a contract fixture, not real #712 CAS integration, Windows Authenticode physical issuer attestation or a native #743 immutable handle provider.
Open P0 #271: actual privileged C:\ProgramData\NexowireStack imported code remains inherited Authenticated Users Modify. The signed first-party native Broker installer, complete signed Agent 1.0.5 rollback archive, OS-owned one-time approved UAC, protected SYSTEM DPAPI, real high token, physical external CAS and VM crash/recovery remain unaccepted. Production NO-GO. No live installer, Broker/service, Agent, UAC, ACL, DPAPI or VM changes. No #596/#608 deployment.