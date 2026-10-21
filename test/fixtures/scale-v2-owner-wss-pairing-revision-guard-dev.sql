-- STAGING-ONLY monotonic pairing-revision fences. The owner-signed v1 WSS
-- receipt does not directly sign the device's key fingerprint. Every key
-- replacement, revoke/re-enable or owner-device pairing change therefore
-- MUST advance the independently read minimumProfileRevision. Otherwise
-- a previously issued but unused receipt could be accepted after re-pair.
-- These triggers are part of the disposable operator SQLite fixture ONLY.
CREATE TRIGGER proposed_owner_wss_key_change_revision
AFTER UPDATE OF public_key_pem,enabled ON proposed_owner_rpc_device_keys
WHEN OLD.public_key_pem IS NOT NEW.public_key_pem OR OLD.enabled <> NEW.enabled
BEGIN
  UPDATE proposed_owner_wss_profile_revisions
  SET revision=revision+1 WHERE device_id=NEW.device_id;
END;
CREATE TRIGGER proposed_owner_wss_key_insert_revision
AFTER INSERT ON proposed_owner_rpc_device_keys
BEGIN
  UPDATE proposed_owner_wss_profile_revisions
  SET revision=revision+1 WHERE device_id=NEW.device_id;
END;
CREATE TRIGGER proposed_owner_wss_key_delete_revision
AFTER DELETE ON proposed_owner_rpc_device_keys
BEGIN
  UPDATE proposed_owner_wss_profile_revisions
  SET revision=revision+1 WHERE device_id=OLD.device_id;
END;
CREATE TRIGGER proposed_owner_wss_device_pair_change_revision
AFTER UPDATE OF owner_account_id,enabled ON proposed_owner_quota_devices
WHEN OLD.owner_account_id IS NOT NEW.owner_account_id OR OLD.enabled <> NEW.enabled
BEGIN
  UPDATE proposed_owner_wss_profile_revisions
  SET revision=revision+1 WHERE device_id=NEW.device_id;
END;

-- A pairing row may be REPLACED rather than UPDATED. SQLite fires INSERT
-- for INSERT OR REPLACE but does not fire the UPDATE trigger. In addition,
-- a deleted and re-inserted device ID must never inherit a previous signed
-- enrollment receipt simply because its device ID and public key are equal.
CREATE TRIGGER proposed_owner_wss_device_pair_insert_revision
AFTER INSERT ON proposed_owner_quota_devices
BEGIN
  UPDATE proposed_owner_wss_profile_revisions
  SET revision=revision+1 WHERE device_id=NEW.device_id;
END;
CREATE TRIGGER proposed_owner_wss_device_pair_delete_revision
AFTER DELETE ON proposed_owner_quota_devices
BEGIN
  UPDATE proposed_owner_wss_profile_revisions
  SET revision=revision+1 WHERE device_id=OLD.device_id;
END;
