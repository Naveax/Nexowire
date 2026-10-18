# Nexowire Artifact Bridge physical acceptance and storage recovery, 2026-10-18

**Scope:** Merged PR #552, commit 340494f49ad52277cddf09cbf71d7b6bb5d9b661. The follow-up branch is isolated from main and initially based on 8660ac1fa9ec38fd81488a48b34affcb7d71fe65. No production deployment or main merge.

## Evidence classes

- PHYSICAL: two actual 1.0.5 Agents (Work PC and Naveax), using only freshly created synthetic files in separate acceptance folders. No user file was modified, deleted or overwritten.
- ISOLATED HUB: real bytes obtained from both devices were committed to a local ArtifactBridgeStore on Work PC. This was NOT an authenticated hosted Hub deployment.
- HERMETIC: restart, retention, backup/restore, concurrency and injected disk-full tests on disposable local state.

## SHA-256 physical transfer proof

| Direction | File/size | Source and final destination SHA-256 | Result |
|---|---|---|---|
| Work PC to Naveax | same-name.bin, 32,773 bytes | 8f355ed9cfbd965519c9ab4b122c4984a56dc5bcc34afc291c6a8c011cdb314d | PASS |
| Naveax to Work PC | same-name.bin, 32,773 bytes | bc52cd57ef9a834b6ace8a36aac6e1bbf80fcf862eb6957835717a88abbf3806 | PASS |
| Work PC to Naveax | resume-proof.bin, 65,537 bytes | b2df98062574c113c91b9e42363d2904134ef9f78a2bc36e0e99c90d115543d9 | PASS |
| Naveax to Work PC | resume-proof.bin, 65,537 bytes | b7ba0f7c41ccf48b688c8de51b09ee4593a1bab5a4556ca2ff1b09fb55b90a6d | PASS |

For both larger files, the live Nexowire file tools wrote exactly 32,766 bytes, then continued with 32,771 bytes. The destination was explicitly statted after the first write and rehashed after the second. Same-named files had DIFFERENT payloads and were kept in isolated directories. This proves live tool-level continuation, not yet hosted Artifact Bridge resume.

## Isolated Artifact Bridge on real physical-file bytes

The reproducible script at scripts/artifact-two-device-acceptance.ts requires two explicit source-file paths and a previously nonexistent output folder. It never overwrites existing directories. Both 65,537-byte physical fixtures were stored under identical relative logical names in different account/project/device namespaces.

**Both device scopes:** initial 32,766-byte chunk committed to durable session, reconstructed independent store instance, resume offset 32,766 verified, duplicate first chunk accepted as ALREADY_WRITTEN, invalid future offset rejected, remainder uploaded and full SHA-256 verified. Wrong device/project returns no artifact; checkpoint imported from existing workspace store was retrievable in another store instance.

**CAS:** wrong previous digest denied, correct previous digest permitted, and the old checkpoint correctly detected replacement of a pinned manifest. Synthetic replacement SHA-256: adb873a954560516933a4d142036d259d64d70838d4c88a11c6d58f66203a925.

Evidence JSON retained on Work PC under the synthetic lab folder: hub-bridge-acceptance-01/artifact-acceptance-evidence.json. **JSON SHA-256: 3638587adc06b01a94205bff9a73a520bba4dda9daaf58c3b62687596b0b79aa.**

## New recovery, retention and backup tests

File: test/artifact-recovery-acceptance.test.ts.

1. Separate Node child created a lock and exited abnormally. New store was blocked; operator-pinned matching lock UUID, local host, aged mtime and dead PID allowed explicit quarantine and exact-session resume. No automatic live lock stealing.
2. Owner process alive: recovery denied and lock preserved. Incorrect owner UUID also denied.
3. Retention dry-run identified only old incomplete sessions. Actual deletion required explicit offline operator acknowledgement. Published objects and manifests stayed intact, and orphaned stages were not deleted automatically.
4. Offline backup into a different temporary directory could be restored and rehashed. Deliberate corruption of the restored object was detected, without altering the original.
5. Simulated ENOSPC during manifest persistence prevented publication; after I/O was restored the existing verified session could be retried. Real disk exhaustion was NOT performed.
6. Two concurrent same-name writes on distinct device scopes succeeded independently; competing writers on a single scope/path could not silently publish two different digests.

## New-chat retrieval

Existing live Nexowire checkpoint_list and checkpoint_get accessed the prior workspace ID Nexowire-parallel-08-artifact-continuity-20261018 and returned its device, update time (2026-10-18T17:36:43.892Z) and completed/remaining work. The isolated new checkpoint adapter also retrieved pinned artifacts through an independently constructed store. This does NOT imply that ChatGPT automatically accesses previous chats' temporary uploads. The connected live plugin currently does NOT expose the new artifact_bridge tools.

## Operator-only recovery / retention

A lock records a random UUID, local hostname, PID and timestamp. All normal writes remain fail-closed when a lock is present. Operators must stop all Hub writers, inspect the owner identity, and explicitly call recoverAbandonedLock with its expected ID, confirmedHubOffline=true and an age threshold. The method refuses active PIDs, foreign host/UUID and young or malformed locks; on success the former lock is quarantined for review rather than silently deleted. The offline assertion is not independently verified by this library.

pruneExpiredSessions is dry-run by default and only scans verified staged uploads. Deletion requires explicit confirmedHubOffline=true and an age threshold of at least 60 seconds. Published blobs/manifests/checkpoints are never deleted by this API. Backups must be taken consistently while writers are stopped; an online directory copy is not necessarily coherent.

## Remaining production blockers

- Confirm authenticated hosted Hub deployment and new MCP tool visibility and permissions, account/device ownership and revocation; no live hosted acceptance yet.
- Exercise signed TLS/WSS over the real two-device WAN route and verify the new direct Agent-to-Hub ingest end-to-end.
- Define monitored Hub backups, encryption/keys, durability, quota limits, restoration objectives and completed-artifact retention policies.
- Real ENOSPC, low disk and sustained high volume have not been physically simulated on production hardware. Only bounded synthetic injection was used.
- Offline operator claim is external to the runtime. Legacy/unversioned locks, foreign-host locks and abandoned recovery markers need documented manual incident handling.
- Git SHA, operation ID and test/acceptance metadata remain caller-asserted without an independent upstream attestation.

**Decision:** physical transfer PASS, isolated source Artifact Bridge PASS, hermetic resilience PASS; hosted production acceptance NOT PROVEN. Keep the follow-up DRAFT pending independent review.
