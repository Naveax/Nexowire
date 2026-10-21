# P0 Worker #28: narrow Broker recovery acceptance

21 October 2026. New isolated source-only QA stacked on PR #644 exact baseline `669e0779562e15f8b5f22306eb0d5c4f06eca71f`.
Ancestors: PR #632 HEAD `ea4229b9ed34c06f5bcb0d52048b25f591cbb040` and PR #551 HEAD `9fdee36897ded643594795ba354fc25e894b65c3`.

## Boundaries

Only independent `test/fixtures/s3-worker28-recovery-narrow.test.ts` and this file are changed. No #12 installer implementation, native Broker, elevated shell, user data, UAC, ACL, Task Scheduler, Agent, VM or ReVoltVPN-Ubuntu-Lab modification. Synthetic Ed25519 fixture keys and injected Authenticode inspector are NOT real first-party signed binaries or Windows OS evidence.

## Four narrow source acceptance cases

1. Signed target mid-copy interruption: drive the actual `upgradeIsolatedAgent` stage/readback contract using a deliberately truncated in-memory target copy with a complete signed old rollback. Require `S3_STAGED_TARGET_HASH_MISMATCH`, exactly one lock release and ZERO stop, cutover or start. `assessS3CrashRecovery` rejects restored/stale journal and interrupted post-stop phases. No real process crash, fsync, durable CAS or file handle is claimed.
2. Rollback manifest publisher mismatch: sign a synthetically valid old 1.0.5 release using the fixture signing key with a foreign publisher but exact rollback payload SHA-256. Actual `preflightAgentUpgrade` and `upgradeIsolatedAgent` must reject `S3_PUBLISHER_MISMATCH` before staging or disruption. An injected verifier does not prove native Authenticode.
3. Updater/import ACL: call actual #632 `assessCoreInstalledBrokerSource` using a full synthetic ancestor tree. A writable updater executable, imported DLL, inherited writable updater parent, missing protected updater/import record or reparse point must fail closed. In-memory SID/ACE evaluation is not actual effective-access or file-handle enforcement, and issue #271 remains OPEN.
4. Re-pair while Broker offline: correctly signed new owner epoch paired with stale DPAPI epoch/key blob, offline/UNKNOWN task state, or older owner epoch must be refused. Offline revoke cannot succeed without independently verified disabled/deleted task and inaccessible key. Even a complete synthetic fixture and synthetic revocation response must say `elevatedCommandMayExecute:false`, `commandAllowed:false`, `productionAccepted:false`.

## Reproduction

Node 22 source checkout, no additional workflow and no CI rerun:

    npm run typecheck
    node --test --import tsx test/fixtures/s3-worker28-recovery-narrow.test.ts

Existing `npm test` glob includes `test/fixtures/*.test.ts`; the tests are not skip-gated. Capture actual exact-SHA GitHub Actions run/job IDs and distinguish SUCCESS / FAIL / QUEUED.

## Gates that stay BLOCKED

Real first-party signed installer/Broker/updater; independently retained complete signed 1.0.5 rollback archive; protected ancestor/import/updater ACL on an authorized Windows host and physical unprivileged write denial; real local owner UAC enrollment; SYSTEM DPAPI key isolation; actual high-token task/image identity and durable off-host anti-rollback journal; authorized physical crash/reboot and rollback acceptance. Source tests cannot change the production NO-GO decision. Keep DRAFT.
