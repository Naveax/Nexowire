-- DEV ONLY. User-submitted checkboxes are not proof without the exact
-- server-issued signed offer snapshot, authoritative user identity and clock.
-- Do NOT add to Cloudflare production migrations. Not used by live checkout.
CREATE TABLE proposed_disclosure_receipts (
  subject_id TEXT NOT NULL,
  flow TEXT NOT NULL CHECK (flow IN ('signup','custom-usage-checkout')),
  offer_nonce TEXT NOT NULL,
  version TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash)=64),
  recorded_at TEXT NOT NULL,
  marketing_opt_in INTEGER NOT NULL CHECK (marketing_opt_in IN (0,1)),
  PRIMARY KEY(subject_id,flow,offer_nonce)
);
CREATE INDEX proposed_disclosure_receipts_lookup
  ON proposed_disclosure_receipts(subject_id,flow,snapshot_hash);
