-- Trusted Guardian signing keys are never provisioned through the public
-- owner/device API. A separately owner-approved and authenticated installer
-- must enroll them after verifying protected local private-key storage.
CREATE TABLE IF NOT EXISTS device_guardian_signing_keys (
  key_id TEXT PRIMARY KEY NOT NULL CHECK(length(key_id) = 64),
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  owner_account_id TEXT NOT NULL REFERENCES accounts(id),
  credential_binding TEXT NOT NULL CHECK(length(credential_binding) = 64),
  public_key_spki TEXT NOT NULL,
  enrolled_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK(revoked_at IS NULL OR revoked_at >= enrolled_at)
);
-- At most one active signer per paired device, including during key rotation.
CREATE UNIQUE INDEX IF NOT EXISTS idx_guardian_active_signer_per_device
  ON device_guardian_signing_keys(device_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_guardian_signing_owner
  ON device_guardian_signing_keys(owner_account_id,device_id);
