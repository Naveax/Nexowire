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

-- UNKNOWN is terminal across reboot, retry and restore.
CREATE TRIGGER IF NOT EXISTS core_console_unknown_remains_terminal
BEFORE UPDATE OF state ON device_core_console_operations
WHEN OLD.state = 'unknown' AND NEW.state <> 'unknown'
BEGIN
  SELECT RAISE(ABORT, 'CORE_UNKNOWN_TERMINAL');
END;
