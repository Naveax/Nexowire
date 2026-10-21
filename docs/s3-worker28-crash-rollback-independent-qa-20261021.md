# P0 Worker #28: independent Broker crash / rollback / revoke source QA

Date: 2026-10-21. Parent #632 (which stacks on #551). Issue #271 remains OPEN.

## Exact reviewed base and ownership

- Main at review: 754cc4364822be5fda528f54042fb22a84f19924.
- #551: 9fdee36897ded643594795ba354fc25e894b65c3, DRAFT.
- #632: ea4229b9ed34c06f5bcb0d52048b25f591cbb040, DRAFT.
- Scope: only this new test and documentation. Installer/Agent/Broker/task implementations owned by #12 are unchanged.
- Workloads: Node 22 source-only synthetic fixtures; no OS elevation, install, UAC, ACL writes, DPAPI decryption, task/service/Agent/VM operations or ReVoltVPN-Ubuntu-Lab.

## Acceptance evidence (source only)

The new QA imports the actual #551/#632 assessment functions rather than asserting an unrelated mock gate:

1. Exact broker/helper/updater SHA-256, signer status, pinned Authenticode certificate and publisher; tampered bytes, false inspector identity and old Agent 1.0.5 incompatibility are denied. Synthetic issuer/inspector DOES NOT verify real Windows Authenticode.
2. Complete parent/import/updater/DPAPI ACL coverage; inherited Authenticated Users Modify and reparse points are denied. In-memory ACL records are NOT physical effective-access tests. Issue #271 remains a hard prerequisite.
3. All S3 journal phases deny automatic restart/rollback, including crash after stop/cutover and restored local journal, older independent sequence, altered device/invalid phase. A local digest cannot establish monotonic authority.
4. Stale DPAPI owner/device/epoch/blob or Medium-exportable key, forged native task image/readback, failed signed OLD rollback and unknown in-flight mutation deny source privileges.
5. Enrollment with unknown OS consent, revoked/re-paired owner epoch and stale signed commands deny CORE. Offline revoke requires a higher independent epoch, verified task disable/deletion and inaccessible key.
6. Even fixture-positive source outputs explicitly have productionAccepted=false and no elevated execution authority.

## Source vs physical acceptance

SOURCE NEGATIVE TESTS != installed Broker proof. There is no first-party Nexowire-signed installer+Broker/updater archive, independently provisioned complete signed Agent 1.0.5 rollback archive, native immutable installed/running binary identity and task high-token attestation, real DPAPI SYSTEM unseal, Windows owner UAC receipt, durable external anti-rollback witness, or physical Windows 10/11 crash/reboot test.

The exact Windows image handle/creation identity must be verified against the pinned signed binary after cutover. Installed executable hash, process version, PID, port, or an injected status alone cannot prove this. Never grant a command or replay a mutation because consent.exe is visible, or because a synthetic receipt claims approval. #271 protected executable/import/updater parent ACL and physical test must pass before rollout.

## Reproduce

- npm run typecheck
- node --test --import tsx test/s3-broker-crash-rollback-independent-qa.test.ts

This PR intentionally does not introduce a new CLI or workflow and must remain DRAFT. Record only exact-HEAD GitHub CI results as hosted CI; GitHub source fixture PASS is not an Agent/OS-level PASS.
