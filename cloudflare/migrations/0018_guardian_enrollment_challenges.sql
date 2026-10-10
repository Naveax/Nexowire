-- Enrollment records are not issued by any public endpoint.
-- A future protected owner-confirmed issuer must generate CSPRNG nonces and
-- insert a 120s one-use challenge bound to the current paired Windows device.
CREATE TABLE IF NOT EXISTS device_guardian_enrollment_challenges (
  request_id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  owner_account_id TEXT NOT NULL REFERENCES accounts(id),
  credential_binding TEXT NOT NULL CHECK(length(credential_binding)=64),
  nonce_hash TEXT NOT NULL CHECK(length(nonce_hash)=64),
  purpose TEXT NOT NULL CHECK(purpose='bridge-mode-receipts'),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK(expires_at > issued_at),
  CHECK(consumed_at IS NULL OR consumed_at >= issued_at)
);
CREATE INDEX IF NOT EXISTS idx_guardian_challenges_device
  ON device_guardian_enrollment_challenges(device_id,expires_at);
