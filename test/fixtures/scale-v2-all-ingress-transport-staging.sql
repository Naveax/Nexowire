-- DEV-only transport incoming-request accounting, hosted on a trusted OWNER DB.
-- NEVER applied as a production Cloudflare migration or customer PC quota.
CREATE TABLE proposed_ingress_transport_clock (
  scope_id TEXT PRIMARY KEY,
  last_seen_ms INTEGER NOT NULL
);
CREATE TABLE proposed_ingress_transport_admissions (
  row_id INTEGER PRIMARY KEY,
  scope_id TEXT NOT NULL,
  admitted_at_ms INTEGER NOT NULL
);
CREATE INDEX proposed_ingress_transport_window_ix
  ON proposed_ingress_transport_admissions(scope_id, admitted_at_ms);
CREATE TABLE proposed_ingress_transport_totals (
  scope_id TEXT PRIMARY KEY,
  observed INTEGER NOT NULL DEFAULT 0 CHECK(observed >= 0),
  admitted INTEGER NOT NULL DEFAULT 0 CHECK(admitted >= 0),
  rejected INTEGER NOT NULL DEFAULT 0 CHECK(rejected >= 0)
);
