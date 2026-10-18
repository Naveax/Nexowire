-- DEVELOPMENT/ISOLATED STAGING ONLY. Never deploy to Cloudflare D1 or live owners.
CREATE TABLE s5_fair_policy (
 scope TEXT PRIMARY KEY,
 policy_hash TEXT NOT NULL
);
CREATE TABLE s5_fair_clock (
 scope TEXT PRIMARY KEY,
 last_seen_ms INTEGER NOT NULL
);
CREATE TABLE s5_fair_window (
 id INTEGER PRIMARY KEY, scope TEXT NOT NULL, tenant_id TEXT NOT NULL,
 admitted_at_ms INTEGER NOT NULL
);
CREATE INDEX s5_fair_window_ix ON s5_fair_window(scope,admitted_at_ms,tenant_id);
-- Never silently expire replays: retention needs a signed, bounded invocation TTL contract.
CREATE TABLE s5_fair_invocations (
 scope TEXT NOT NULL, invocation_id TEXT NOT NULL,
 tenant_id TEXT NOT NULL, request_sha256 TEXT NOT NULL,
 PRIMARY KEY(scope, invocation_id)
);
