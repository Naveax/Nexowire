-- S2 PROPOSAL ONLY. NEVER put into cloudflare/migrations or deploy it.
-- Closed-world cutover fixture for canonical hosted MCP event IDs. Apply
-- transactionally AFTER all old writers are quiesced at a trusted admission
-- boundary. Nothing here enables a public/production route.
CREATE TABLE mcp_global_replay_fence (
  event_id TEXT PRIMARY KEY NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('legacy-monthly','legacy-daily','dual'))
);

-- Do NOT IGNORE conflicting historical IDs across periods/subjects: abort
-- the cutover so an operator must investigate ambiguous prior execution.
INSERT INTO mcp_global_replay_fence (event_id, origin)
SELECT event_id, 'legacy-monthly'
FROM quota_usage_events
WHERE length(event_id) = 68 AND substr(event_id,1,4) = 'mcp-'
  AND substr(event_id,5) NOT GLOB '*[^0-9a-f]*';

-- Preserve daily-only accepted IDs, but avoid adding the same event twice
-- when a legitimately combined reservation is present in BOTH ledgers.
INSERT INTO mcp_global_replay_fence (event_id, origin)
SELECT d.invocation_id, 'legacy-daily'
FROM daily_request_invocations AS d
WHERE length(d.invocation_id) = 68
  AND substr(d.invocation_id,1,4) = 'mcp-'
  AND substr(d.invocation_id,5) NOT GLOB '*[^0-9a-f]*'
  AND NOT EXISTS (
    SELECT 1 FROM quota_usage_events AS m
    WHERE m.quota_subject_id=d.quota_subject_id AND m.event_id=d.invocation_id
  );

-- A new dual reservation is the ONLY allowed writer of canonical MCP event
-- IDs after this staging cutover. The fence spans subject and UTC periods.
-- Its violation aborts the entire top-level INSERT and BOTH quota ledgers.
CREATE TRIGGER trg_staging_dual_global_mcp_replay
AFTER INSERT ON dual_quota_reservations
BEGIN
  SELECT RAISE(ABORT, 'noncanonical_hosted_mcp_event_id')
  WHERE length(NEW.invocation_id) <> 68
    OR substr(NEW.invocation_id,1,4) <> 'mcp-'
    OR substr(NEW.invocation_id,5) GLOB '*[^0-9a-f]*';
  INSERT INTO mcp_global_replay_fence(event_id,origin)
  VALUES (NEW.invocation_id,'dual');
END;

-- The legacy monthly-only hosted MCP route must NOT bypass the new fence.
-- Nested writes from the dual parent are permitted; standalone writes fail.
CREATE TRIGGER trg_staging_block_old_monthly_hosted_mcp
BEFORE INSERT ON quota_usage_events
WHEN length(NEW.event_id)=68 AND substr(NEW.event_id,1,4)='mcp-'
  AND substr(NEW.event_id,5) NOT GLOB '*[^0-9a-f]*'
  AND NOT EXISTS (
    SELECT 1 FROM dual_quota_reservations AS q
    WHERE q.quota_subject_id=NEW.quota_subject_id
      AND q.invocation_id=NEW.event_id
  )
BEGIN
  SELECT RAISE(ABORT,'legacy_monthly_hosted_mcp_path_closed');
END;

CREATE TRIGGER trg_staging_block_old_daily_hosted_mcp
BEFORE INSERT ON daily_request_invocations
WHEN length(NEW.invocation_id)=68
  AND substr(NEW.invocation_id,1,4)='mcp-'
  AND substr(NEW.invocation_id,5) NOT GLOB '*[^0-9a-f]*'
  AND NOT EXISTS (
    SELECT 1 FROM dual_quota_reservations AS q
    WHERE q.quota_subject_id=NEW.quota_subject_id
      AND q.invocation_id=NEW.invocation_id
  )
BEGIN
  SELECT RAISE(ABORT,'legacy_daily_hosted_mcp_path_closed');
END;
