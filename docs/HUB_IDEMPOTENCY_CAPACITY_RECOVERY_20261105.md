# Hub idempotency capacity incident: non-destructive recovery hotfix

**Status:** source hotfix only; live Hub deployment **NOT_RUN**. This is a
bounded, temporary admission increase, not a completed retention/archiving
redesign.

## Root cause and bounded recovery

The Hub's `IdempotencyStore` uses the file
`<stateDir>/idempotency-records.json`. Previously, the default admission
ceiling was **2,000**. The schema has a hard **5,000** record ceiling.
`trim()` deliberately rejects a new reservation with
`IDEMPOTENCY_STORE_FULL`, without retiring historical keys.

A read-only incident check found an active Hub journal exactly at 2,000:
1,958 `succeeded`, 38 `failed`, 4 `unknown`; 2 device identities.
The refused new intent's key was not in that snapshot. An unrelated, stale
80-record journal on another user profile was **not** the active Hub.

This patch raises **only the default admission limit** to 5,000 and
validates the configured limit (1–5,000). All existing records and their
statuses remain in the same v1 JSON schema. An explicit lower limit still
rejects new admissions. Full-capacity and disk-write failures remain
fail-closed. There is **no** pruning of `UNKNOWN`, `IN_PROGRESS`,
`SUCCEEDED`, or `FAILED` tombstones.

## Security invariants

- A historical key/fingerprint/operationId always blocks a second mutation
  with the same key, including after Hub restart.
- A mismatched fingerprint for the same key is denied.
- An in-progress record recovered after crash becomes `unknown`.
- Exhaustion at 5,000 refuses the 5,001st reservation and retains the
  journal byte-for-byte.
- This hotfix does not synthesize responses or attempt the originally
  rejected file write. A missing Hub reservation **alone** is not physical
  proof of what another subsystem did.
- No device, credential, scheduled task, running process or production
  database is changed by the source PR.

## Deployment and downgrade warning

**Do not deploy without a controlled maintenance/rollback plan.**

1. Verify exact deployed Hub version, journal path, file hash, current record
   count, backup location/ACL, and that active mutations are not interrupted.
2. Preserve a byte-for-byte, access-controlled backup of the original journal
   and its identity. Never delete the originals to create free slots.
3. Validate the patched package and synthetic 2,000→2,001 and 5,000→5,001
   tests on disposable infrastructure before deployment.
4. Install the approved patched Hub only during a coordinated safe cutover;
   restart/swap of a live Hub is **not authorized by this source patch**.
5. Verify unchanged prior keys/fingerprints/UNKNOWN states after restart and
   confirm a new synthetic reservation, not the real user file write.
6. **Downgrade risk:** legacy Hub code with the 2,000-record limit will
   fail closed on a journal with 2,001+ records. Do not restore old binaries
   expecting them to serve mutations. Rollback needs a compatible Hub build
   that recognizes the expanded journal; never truncate the journal.
7. Run the original, explicitly authorized file-write intent only after
   the Hub is healthy and its exact prior key/operation evidence is reconciled.

## Permanent solution still required

The JSON journal rewrites the whole file on every reservation/completion;
5,000 is not scalable and the store can fill again. Replace it with a
transactional, indexed durable idempotency authority (e.g. SQLite WAL/FULL)
that retains all key + fingerprint + operationId + status anti-replay
tombstones. Archive only terminal metadata after independent reconciliation;
`UNKNOWN` and `IN_PROGRESS` must never be evicted. Implement and test
crash-safe legacy migration, single-writer ownership, fail-closed disk-full
and corruption recovery, key reuse across restart, backup/restore, and a
**downgrade guard** before any production migration. Do not implement simple
TTL-based replay-key deletion.
