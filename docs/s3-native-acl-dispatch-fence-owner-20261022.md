# Nexowire #12: protected Windows ACL and owner permit source fence
2026-10-22 | child of #714 | PRODUCTION NO-GO

## Reviewed independent results
- #714 HEAD d7e5f98b5b286d9884381edc6bb38eae036a8449, exact CI 39659270493 SUCCESS; its signed import DAG, rollback, offline DPAPI owner re-pair and atomic-source postconditions were already green and not duplicated.
- #706 HEAD 6a2a1d8a2b04549a051db86291cadd99cddc82ea, independent signed nested updater DLL / Agent 1.0.5 rollback / offline owner DPAPI negative QA, exact CI SUCCESS.
- #709 HEAD b083004b9ab8c18125a428cf74f3e97f7adf4e88, Windows read-only protected tree v2, versioned base64 JSON envelope, actual .NET ACL, accepted import paths and ancestor evidence. Provider deliberately reports importListIndependentlyEnumerated:false and productionReady:false.
- #712 HEAD 62800af17d2a9ce18670dba6a8ac861a5d7f4ba5, remotely signed ownerEpoch + grantGeneration + fresh 32-byte challengeNonce, external single-use CAS reserve/revoke. Real external authority and installed HIGH Broker remain physically blocked.
- #713 inherited Windows Physical Job test failure is independent and must not be masked or attributed to #12.

## Narrow owner source gate
scripts/s3-core-bootstrap-delegation-audit.ts now provides assessCoreNativeAclAndDispatchSource:
1. Compare the #709 v2 accepted paths and native inspected paths against EVERY signed imported PE/DLL/config file, the protected SYSTEM DPAPI blob path and every Windows ancestor. Incomplete, alias-mismatched, missing, writable Authenticated Users or reparse-positive reports fail closed.
2. Verify independently pinned Ed25519 signature on the #712-compatible source permit envelope, binding owner, device, transaction, ownerEpoch, grantGeneration, challengeNonce, Broker SHA256, process creation identity and external sequence. Expected nonce/epoch/generation/minimum sequence are separate source inputs, not taken as authority from signed receipt alone.
3. Reject revoked, unknown, non-single-use or stale permits even when prior local installer/rollback fixture signatures are consistent.
4. Even a positive source record returns nativeHighTokenAttested:false, ownerOsConsentPhysicallyConfirmed:false, executionApproved:false and productionApproved:false. This is an interface/source preflight, not a deployed native inspector or CAS.

## Physical acceptance blockers
#271 real privileged NexowireStack ProgramData code and imported DLL parents inherit Authenticated Users: Modify. No first-party signed native installer/Broker/helper and complete signed Agent 1.0.5 rollback, physical trusted importer/immutable OS image handles, owner-approved one-time Windows UAC, protected SYSTEM DPAPI/task high token, independently non-restorable off-host CAS or real VM crash recovery are accepted. CORE intent remains one legitimate OS-approved Broker enrollment followed by properly scoped CORE admin requests without per-command UAC. This source code never installs, elevates, executes admin tasks, clicks UAC, modifies ACL/service/Agent/DPAPI/VM or deploys #596/#608.