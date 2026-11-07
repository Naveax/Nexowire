-- Persist the exact native owner/logon proof independently of Agent-local DPAPI state.
ALTER TABLE device_core_console_authority ADD COLUMN native_consent_receipt_id TEXT;
ALTER TABLE device_core_console_authority ADD COLUMN windows_user_sid TEXT;
ALTER TABLE device_core_console_authority ADD COLUMN windows_session_id INTEGER;
ALTER TABLE device_core_console_authority ADD COLUMN windows_logon_luid TEXT;
ALTER TABLE device_core_console_authority ADD COLUMN windows_logon_session_epoch TEXT;

-- Pairing, grant generation, enrollment identity or revoke changes invalidate
-- all previously attested logon bindings. The native receipt itself is never
-- an authorization without a fresh verifier readback.
CREATE TRIGGER IF NOT EXISTS core_console_clear_native_logon_binding
AFTER UPDATE OF owner_epoch,grant_generation,revoke_epoch,installation_id,enrollment_id,public_key_spki
ON device_core_console_authority
WHEN NEW.owner_epoch<>OLD.owner_epoch OR
     NEW.grant_generation<>OLD.grant_generation OR
     NEW.revoke_epoch<>OLD.revoke_epoch OR
     NEW.installation_id IS NULL OR NEW.enrollment_id IS NULL OR NEW.public_key_spki IS NULL
BEGIN
  UPDATE device_core_console_authority SET native_consent_receipt_id=NULL,
    windows_user_sid=NULL,windows_session_id=NULL,windows_logon_luid=NULL,
    windows_logon_session_epoch=NULL WHERE device_id=NEW.device_id;
END;
