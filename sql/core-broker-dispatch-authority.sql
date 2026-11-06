-- Explicit operator migration only, on the separately operated authority DB.
-- PostgreSQL transactions protect crash consistency, not an administrator's
-- restore of this DB together with Agent/Hub state. Independent custody and
-- restore admission remain mandatory. No application auto-provisioning.
BEGIN;
CREATE SCHEMA IF NOT EXISTS core_dispatch;
REVOKE ALL ON SCHEMA core_dispatch FROM PUBLIC;
CREATE TABLE IF NOT EXISTS core_dispatch.authorities (
 authority_id uuid PRIMARY KEY,
 sequence bigint NOT NULL DEFAULT 0 CHECK(sequence>=0),
 max_seen_ms bigint NOT NULL CHECK(max_seen_ms>0)
);
CREATE TABLE IF NOT EXISTS core_dispatch.grants (
 authority_id uuid NOT NULL REFERENCES core_dispatch.authorities,
 device_id uuid NOT NULL, owner_id uuid NOT NULL,
 device_epoch uuid NOT NULL, session_epoch uuid NOT NULL,
 owner_epoch bigint NOT NULL CHECK(owner_epoch>0),
 generation bigint NOT NULL CHECK(generation>0),
 broker_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('ACTIVE','REVOKING','REVOKED')),
 core_enabled boolean NOT NULL DEFAULT false,
 root_expires_ms bigint CHECK(root_expires_ms>0),
 PRIMARY KEY(authority_id,device_id)
);
CREATE TABLE IF NOT EXISTS core_dispatch.claims (
 request_id uuid PRIMARY KEY,
 authority_id uuid NOT NULL,
 device_id uuid NOT NULL,
 dispatch_id uuid NOT NULL UNIQUE,
 broker_id uuid NOT NULL,
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
 sequence bigint NOT NULL CHECK(sequence>0),
 reserved_at_ms bigint NOT NULL CHECK(reserved_at_ms>0),
 reserve_expires_ms bigint NOT NULL CHECK(reserve_expires_ms>reserved_at_ms),
 begin_nonce text NOT NULL CHECK(begin_nonce ~ '^[a-f0-9]{64}$'),
 commit_nonce text CHECK(commit_nonce ~ '^[a-f0-9]{64}$'),
 commit_expires_ms bigint,
 state text NOT NULL CHECK(state IN ('RESERVED','COMMITTED','RELEASED')),
 FOREIGN KEY(authority_id,device_id) REFERENCES core_dispatch.grants,
 UNIQUE(authority_id,sequence),
 CHECK((commit_nonce IS NULL)=(commit_expires_ms IS NULL))
);
CREATE INDEX IF NOT EXISTS claims_device_state
 ON core_dispatch.claims(authority_id,device_id,state);

CREATE OR REPLACE FUNCTION core_dispatch.guard_claim_history() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'CORE_DISPATCH_HISTORY_DELETE_DENIED';
 END IF;
 IF (NEW.request_id,NEW.authority_id,NEW.device_id,NEW.dispatch_id,NEW.broker_id,
     NEW.request,NEW.sequence,NEW.reserved_at_ms,NEW.reserve_expires_ms,NEW.begin_nonce)
    IS DISTINCT FROM
    (OLD.request_id,OLD.authority_id,OLD.device_id,OLD.dispatch_id,OLD.broker_id,
     OLD.request,OLD.sequence,OLD.reserved_at_ms,OLD.reserve_expires_ms,OLD.begin_nonce)
 OR (OLD.commit_nonce IS NOT NULL AND
     (NEW.commit_nonce,NEW.commit_expires_ms) IS DISTINCT FROM
     (OLD.commit_nonce,OLD.commit_expires_ms))
 OR NOT ((OLD.state='RESERVED' AND NEW.state IN ('COMMITTED','RELEASED')) OR
         (OLD.state='COMMITTED' AND NEW.state='RELEASED')) THEN
  RAISE EXCEPTION 'CORE_DISPATCH_HISTORY_REWRITE_DENIED';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS immutable_claim_history ON core_dispatch.claims;
CREATE TRIGGER immutable_claim_history BEFORE UPDATE OR DELETE
 ON core_dispatch.claims FOR EACH ROW
 EXECUTE FUNCTION core_dispatch.guard_claim_history();
REVOKE ALL ON ALL TABLES IN SCHEMA core_dispatch FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA core_dispatch FROM PUBLIC;
COMMIT;

-- A separate migration operator provisions authority/grant rows only after
-- independent owner approval and native enrollment. The service role must
-- NOT own the schema/tables, be superuser/BYPASSRLS, or hold DELETE/TRUNCATE,
-- DDL, replication, backup/restore or grant-provisioning permissions.
-- Explicit minimum service grants (replace the role under operator control):
-- GRANT USAGE ON SCHEMA core_dispatch TO protected_dispatch_service;
-- GRANT SELECT ON core_dispatch.authorities,core_dispatch.grants,
--   core_dispatch.claims TO protected_dispatch_service;
-- GRANT UPDATE(sequence,max_seen_ms) ON core_dispatch.authorities TO protected_dispatch_service;
-- GRANT UPDATE(state,generation,core_enabled,root_expires_ms)
--   ON core_dispatch.grants TO protected_dispatch_service;
-- GRANT INSERT ON core_dispatch.claims TO protected_dispatch_service;
-- GRANT UPDATE(state,commit_nonce,commit_expires_ms)
--   ON core_dispatch.claims TO protected_dispatch_service;
