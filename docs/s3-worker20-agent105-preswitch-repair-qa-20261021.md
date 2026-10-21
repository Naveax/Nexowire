# Worker #20, independent #696 signed DAG + re-pair + pre-switch QA

Date 2026-10-21. New **source-only** child based exactly on #696 SHA `0b43332289a478a3285673f43f6bb54da5325459`, GitHub CI `39645131289` **7/7 SUCCESS**. Earlier independent #678 SHA `807725eadece998fc4928a0a3898e71afa828da8` CI `39644040656` **SUCCESS**. Changes only to new Worker #20 test and docs; owner #12's installer/CORE implementation is untouched.

## Distinct source-level negative acceptance

The new `test/s3-worker20-agent105-preswitch-dag-qa.test.ts` calls **actual #696 exports** `assessCoreSignedWindowsImportDag` and `assessCoreOfflineRePairBootstrap`, rather than a separate invented installer authorization adapter.

- Nested updater DLL: injected signature evidence with wrong **publisher**, wrong DER certificate SHA256, or altered **file bytes**; correct signed Broker at parent cannot excuse the wrong nested signer. Independent signed DAG vs native readback extra updater edge, missing native handles, unknown system dependency, and incomplete import resolution are refused.
- Offline revoked-owner re-pair: even when a synthetic witness says `previousOwnerRevoked:true`, `previousTaskState:'disabled'` and `previousDpapiKeyUnusable:true`, reusing the old DPAPI blob SHA for the new owner is rejected. A still-accessible old DPAPI key, old transaction/UAC claim and nonmonotonic owner epoch are also refused.
- Signed **Agent 1.0.5** rollback: named old rollback fixture is in the signed import graph, checks pinned Authenticode publisher and exact image hash, fails for mid-copy torn bytes, alternate file identity, foreign SHA, absent signed prior rollback receipt.
- **Crash before atomic switch**: incomplete file traversal/import readback, pending `UNKNOWN` native mutation, old task still running, task/image mismatch, missing immutable journal and missing independent epoch/revocation CAS evidence all fail closed. No automatic replay or false success. The test does **not** pretend to know whether an actual on-disk atomic switch occurred.

A passing synthetic baseline always returns `actuallyInstalled:false`, `genuineNativeLoaderEvidence:false`, `canInstall:false`, `canExecuteElevated:false`, `productionApproved:false`, `productionAccepted:false`. Neither a forged native provider flag nor a signed test-only Ed25519 manifest constitutes genuine Windows native or first-party signature evidence.

## Physical production gate remains NO-GO

The owner #696 source path still depends on a native import enumerator, protected handle and Authenticode OS attestation, actual SYSTEM-owned DPAPI key revoke, independently nonrestorable durable CAS readback, OS-verified single local owner UAC consent, crash-consistent old/new Agent1.0.5 switch with signed rollback material, and real protected ancestor/updater/DLL ACL inspection and denial. The old privileged `C:\ProgramData\NexowireStack` inherited Authenticated Users Modify described by #271 is not remediated by source tests. All mock system-high-token/consent fields remain synthetic.

**No real installer, UAC, ACL, Agent, service, Broker, task, DPAPI, USB, VM, user files or ReVoltVPN-Ubuntu-Lab touched.** QA child stays Draft, unmerged and does not authorize production.
