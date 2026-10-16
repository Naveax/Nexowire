-- STAGING ONLY: owner PC / trusted host, never customer's authoritative DB.
CREATE TABLE proposed_owner_rpc_device_keys (
  device_id TEXT PRIMARY KEY,
  public_key_pem TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
);
CREATE TABLE proposed_owner_rpc_clock (
  clock_id INTEGER PRIMARY KEY CHECK(clock_id=1),
  last_seen_ms INTEGER NOT NULL
);
CREATE TABLE proposed_owner_rpc_nonce_ledger (
  device_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER NOT NULL,
  PRIMARY KEY(device_id,nonce)
);
CREATE INDEX proposed_owner_rpc_nonce_time_ix
  ON proposed_owner_rpc_nonce_ledger(consumed_at_ms);
