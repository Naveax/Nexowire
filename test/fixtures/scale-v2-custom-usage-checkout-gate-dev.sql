-- DEV/STAGING ONLY. Trusted owner-controlled SQLite; do not run on user PCs
-- as a commercial entitlement authority or migrate into live Cloudflare D1.
CREATE TABLE proposed_custom_checkout_offers (
  authenticated_subject_id TEXT NOT NULL,
  offer_nonce TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),
  signed_offer_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  checkout_reserved_at TEXT,
  PRIMARY KEY(authenticated_subject_id,offer_nonce)
);
CREATE INDEX proposed_custom_checkout_by_expiry
  ON proposed_custom_checkout_offers(expires_at);
