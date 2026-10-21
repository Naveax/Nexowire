# Nexowire #12 CORE atomic rollback/source QA, 2026-10-21

## Independent QA and CI
Parent PR #696 exact HEAD 0b43332289a478a3285673f43f6bb54da5325459 CI 39645131289 SUCCESS. #20 QA #678 exact HEAD 807725eadece998fc4928a0a3898e71afa828da8 CI 39644040656 SUCCESS: signed nested DLL, identity swap with same digest, crash UNKNOWN, stale DPAPI owner. #28 QA #685 exact HEAD 536fce89c4197335c0eab7fa286bc1c3015b4545 CI 39644586410 SUCCESS: mid-copy crash, unsigned old rollback, task/DPAPI stale owner epoch and duplicate rollback no-replay. Both independent QA files remain unchanged.

## New #12 owner source
scripts/s3-core-bootstrap-delegation-audit.ts adds assessCoreAtomicRollbackSwitchSource: this source-only assessor first verifies independent signed installer/import DAG, protected importer/parent/updater ACL, signed old rollback and separately witnessed offline owner re-pair. It then checks the before/after atomic source evidence.

- Exact post-cutover-readback only. A reserved, mid-native-write UNKNOWN, stale journal, late rollback dispatch or fabricated completed receipt never resumes or replays.
- Independently monotonic journal sequence, signed readback and owner transaction bound to one genuinely OS-owned local consent record (source contract only).
- Before-install image SHA equals the signed old rollback SHA; after-install SHA and volume/file identity equal the signed new Broker, with replaced previous identity.
- Signed old rollback file identity, volume and SHA remain unchanged before and after; protected updater identity also unchanged. No hash-only acceptance of renamed/replaced hardlink objects.
- Post-switch protected ACL, exact signed import DAG, signer, process creation identity and trustworthy loaded executable handle are mandatory claims but not physically attested by this module.
- Offline re-pair requires old task disabled/deleted, old SYSTEM DPAPI key unusable, independent new owner epoch and a NEW consent/transaction. A stale key or old UAC receipt never authorizes CORE.

Even a full synthetic fixture returns physicalSwitchAccepted:false, realWindowsUacEnrolled:false, canResume:false, canRollbackAutomatically:false, canDispatchCore:false, productionApproved:false. This module does not create or start a Windows service, register a task, unseal a DPAPI blob, install anything, automate Secure Desktop consent or touch a VM.

## Hard production blocker
#271 legacy elevated NexowireStack ProgramData executable/import code inherits Authenticated Users Modify: P0 still OPEN. No accepted first-party signed installer/Broker/helper, complete signed Agent1.0.5 rollback bundle, physical Windows immutable loader/handle and UAC provenance, non-restorable external journal, protected SYSTEM DPAPI task or isolated VM reboot/canary. CORE target remains one Windows-approved installation followed by authorized existing elevated Broker use without per-command UAC; not generic Medium shell elevation. Keep DRAFT, no #596/#608 rollout or live Agent/Broker/ACL/UAC/VM writes.
