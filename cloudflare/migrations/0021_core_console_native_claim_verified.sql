-- P0 coordinator schema gate: a signed complete() must not acknowledge success
-- before independent native currentReadback and a durable winning-claim CAS.
-- Additive, no backfill: existing records retain native_claim_verified=0.
-- D1 DB state alone is NOT a physical owner/OS/effect authorization.
ALTER TABLE device_core_console_operations
  ADD COLUMN native_claim_verified INTEGER NOT NULL DEFAULT 0
  CHECK (native_claim_verified IN (0, 1));

-- Never accept an imported or explicitly pre-authorized operation.
CREATE TRIGGER IF NOT EXISTS core_console_native_claim_insert_unverified
BEFORE INSERT ON device_core_console_operations
WHEN NEW.native_claim_verified <> 0
BEGIN
  SELECT RAISE(ABORT, 'CORE_NATIVE_CLAIM_INSERT_DENIED');
END;

-- New operations must enter as reserved; a direct terminal INSERT with the
-- default unverified marker must not create an apparently completed record.
-- Historical terminal rows migrated from old schema remain untouched.
CREATE TRIGGER IF NOT EXISTS core_console_new_operation_reserved_only
BEFORE INSERT ON device_core_console_operations
WHEN NEW.native_claim_verified = 0 AND NEW.state <> 'reserved'
BEGIN
  SELECT RAISE(ABORT, 'CORE_NEW_OPERATION_MUST_BEGIN_RESERVED');
END;

-- Verification is a second transaction/CAS, AFTER native readback. A caller
-- cannot turn a reserved, UNKNOWN, or terminal row into a verified claim.
-- The trusted Worker must additionally check immutable owner/device/session,
-- current readiness, revoke generation and a protected native OS witness.
CREATE TRIGGER IF NOT EXISTS core_console_native_claim_mark_only_dispatched
BEFORE UPDATE OF native_claim_verified ON device_core_console_operations
WHEN NEW.native_claim_verified = 1
 AND (OLD.state <> 'dispatched' OR NEW.state <> 'dispatched'
      OR OLD.native_claim_verified <> 0)
BEGIN
  SELECT RAISE(ABORT, 'CORE_NATIVE_CLAIM_MARK_DENIED');
END;

-- Never reset a verified in-flight claim to "unverified dispatched": it must
-- instead be quarantined as UNKNOWN on revoke/uncertain or failed readback.
CREATE TRIGGER IF NOT EXISTS core_console_native_claim_no_silent_downgrade
BEFORE UPDATE OF native_claim_verified ON device_core_console_operations
WHEN OLD.native_claim_verified = 1
 AND NEW.native_claim_verified = 0 AND NEW.state <> 'unknown'
BEGIN
  SELECT RAISE(ABORT, 'CORE_NATIVE_CLAIM_DOWNGRADE_DENIED');
END;

-- Legacy Workers which still complete from state='dispatched' will now fail
-- closed. A new Worker must atomically set the marker only AFTER fresh native
-- readback, then complete via exact immutable request and current scope.
CREATE TRIGGER IF NOT EXISTS core_console_completion_requires_native_claim
BEFORE UPDATE OF state ON device_core_console_operations
WHEN NEW.state IN ('succeeded','denied')
 AND (OLD.state <> 'dispatched'
      OR OLD.native_claim_verified <> 1
      OR NEW.native_claim_verified <> 1)
BEGIN
  SELECT RAISE(ABORT, 'CORE_NATIVE_CLAIM_NOT_VERIFIED');
END;

-- An authenticated operation's tuple is a permanent replay identity. Its
-- request ID, exact fingerprint, owner/device/enrollment generations and
-- reservation timestamp may not be rewritten even while reserved. Without
-- this the same stored ID can be rebound to a different effect scope.
CREATE TRIGGER IF NOT EXISTS core_console_operation_identity_immutable
BEFORE UPDATE OF request_id,device_id,installation_id,enrollment_id,
  owner_epoch,grant_generation,revoke_epoch,fingerprint,reserved_at_ms
ON device_core_console_operations
WHEN NEW.request_id IS NOT OLD.request_id
  OR NEW.device_id IS NOT OLD.device_id
  OR NEW.installation_id IS NOT OLD.installation_id
  OR NEW.enrollment_id IS NOT OLD.enrollment_id
  OR NEW.owner_epoch IS NOT OLD.owner_epoch
  OR NEW.grant_generation IS NOT OLD.grant_generation
  OR NEW.revoke_epoch IS NOT OLD.revoke_epoch
  OR NEW.fingerprint IS NOT OLD.fingerprint
  OR NEW.reserved_at_ms IS NOT OLD.reserved_at_ms
BEGIN
  SELECT RAISE(ABORT, 'CORE_OPERATION_IDENTITY_IMMUTABLE');
END;

-- A completed/denied effect may only be conservatively quarantined as
-- UNKNOWN; it must never be dispatched or reserved again. A new operation
-- must use a fresh, separately admitted request identity and CAS.
CREATE TRIGGER IF NOT EXISTS core_console_completed_terminal_no_replay
BEFORE UPDATE OF state ON device_core_console_operations
WHEN OLD.state IN ('succeeded','denied')
 AND NEW.state <> OLD.state AND NEW.state <> 'unknown'
BEGIN
  SELECT RAISE(ABORT, 'CORE_COMPLETED_OPERATION_TERMINAL');
END;

-- Also refuse rollback from a consumed claim to the reusable reserve state.
CREATE TRIGGER IF NOT EXISTS core_console_dispatched_cannot_be_reserved
BEFORE UPDATE OF state ON device_core_console_operations
WHEN OLD.state='dispatched' AND NEW.state='reserved'
BEGIN
  SELECT RAISE(ABORT, 'CORE_DISPATCHED_REPLAY_DENIED');
END;

-- UNKNOWN is terminal across reboot, retry and restore.
CREATE TRIGGER IF NOT EXISTS core_console_unknown_remains_terminal
BEFORE UPDATE OF state ON device_core_console_operations
WHEN OLD.state = 'unknown' AND NEW.state <> 'unknown'
BEGIN
  SELECT RAISE(ABORT, 'CORE_UNKNOWN_TERMINAL');
END;
