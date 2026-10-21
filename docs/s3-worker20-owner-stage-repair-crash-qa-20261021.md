# Worker #20: independent #672 rollback / import-tree / owner re-pair QA

**Date:** 2026-10-21  
**Repository:** `Naveax/Nexowire`  
**Implementation baseline:** #672 exact SHA `84714bb77ec00a8e79ebb732c1070dda1a331975`, CI `39632489293` SUCCESS (7/7 jobs).  
**Earlier QA:** #655 exact SHA `e258e8eb8a8132f75d350a820da816dfd3f0fa07`, CI `39630947296` completed FAILURE; six other jobs SUCCESS, Windows `browser-live` failed `Windows Job preserves separate stdin/stdout/stderr pipes` (`WINJOB_STDOUT` absent). Avoid describing #655 as green.

## New independent QA, not #12 owner implementation

`test/s3-worker20-owner-stage-repair-crash-negative.test.ts` targets the actual #672 exported source-only gates:

- `assessProtectedCoreInstallerStage`: exact Authenticode publisher/certificate/digest for imported native DLLs in **runtime**, **updater**, and **rollback** *subdirectories*, not only the top-level Broker; separately wrong publisher, certificate, SHA, and unavailable signature inspector. Mutated bytes, renamed file identity, reparse, truncated inventory, and unknown import-closure evidence must reject.
- `assessCoreLinkedStageAndDelegation`: re-paired owner epoch cannot be authorized by a stale DPAPI blob or earlier device/Broker binding. Tests re-sign a new owner/command intent in a fixture with a stale DPAPI epoch to avoid a trivial bad-signature-only result. Revoked grant and independent minimum epoch also fail closed.
- Recovery transitions: missing externally witnessed durable journal, `pendingUnknownMutation`, wrong post-recovery running image, forged old rollback digest, invalid Task identity, and invalid OS owner-consent report reject. A crash after native-write dispatch cannot be interpreted as a safe automatic replay.

The fixtures use Ed25519 test-only keys and synthetic bytes. The fake Authenticode inspector and `provider:'trusted-win32-token'` fields are *claims*, not actual Windows OS attestations. A positive **source** fixture must still return `actuallyInstalled:false`, `initialLocalUacApproved:false`, `elevatedCommandMayExecute:false`, and `productionApproved:false`.

## Physical acceptance blockers

The #672 preflight is not a native installer. A fixture claiming complete recursive imports does not establish exhaustive Windows DLL, delay-load, script, and updater dependency discovery. Signed stage bytes do not prove immutable native process handle identity after replacement. A signed local owner enrollment fixture cannot replace OS-owned UAC consent, SYSTEM effective token proof, or native DPAPI unseal under a protected SID.

**Re-pair caveat:** Current source gate validates DPAPI binding against the signed bootstrap record and pinned minimum epoch, but has no independently authenticated, rollback-external owner re-pair history proving an old DPAPI key was actually destroyed. A caller with forged congruent native claims cannot upgrade these fixture results into trusted privilege. Physical re-pair and independent witness remain **BLOCKED**.

**Crash caveat:** The fixture can test missing recovery evidence but cannot certify crash-consistent fsync, atomic replace, authentic external cancellation/rollback receipt or Native Windows postcondition readback.

**P0 #271 remains OPEN:** legacy `ProgramData\\NexowireStack` inherits `Authenticated Users: Modify` on privileged imported code. Source tests do not remediate ACLs.

**Decision: SOURCE QA ONLY. Windows signed installer / real protected ACL / UAC / DPAPI / Agent / VM: NOT TESTED. PRODUCTION NO-GO.**

No files owned by #12 or another worker were edited. No real service, Agent, installer, UAC, ACL, Task Scheduler, DPAPI, Windows VM, user files, or ReVoltVPN-Ubuntu-Lab operation was performed. Keep child DRAFT and no auto-merge.
