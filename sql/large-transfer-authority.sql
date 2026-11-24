-- Operator-only migration, in the SAME independently operated PostgreSQL
-- authority as core_dispatch. Never run from an Agent/Hub startup path.
BEGIN;
CREATE SCHEMA IF NOT EXISTS transfer_authority;
REVOKE ALL ON SCHEMA transfer_authority FROM PUBLIC;
CREATE TABLE IF NOT EXISTS transfer_authority.grants (
 authority_id uuid NOT NULL REFERENCES core_dispatch.authorities,
 owner_id uuid NOT NULL, project_id text NOT NULL,
 source_device_id uuid NOT NULL,target_device_id uuid NOT NULL,
 source_device_epoch uuid NOT NULL,source_session_epoch uuid NOT NULL,
 source_owner_epoch bigint NOT NULL CHECK(source_owner_epoch>0),source_generation bigint NOT NULL CHECK(source_generation>0),
 target_device_epoch uuid NOT NULL,target_session_epoch uuid NOT NULL,
 target_owner_epoch bigint NOT NULL CHECK(target_owner_epoch>0),target_generation bigint NOT NULL CHECK(target_generation>0),
 source_root text NOT NULL,target_root text NOT NULL,target_public_key_pem text NOT NULL,
 state text NOT NULL CHECK(state IN ('ACTIVE','REVOKED')),expires_ms bigint NOT NULL CHECK(expires_ms>0),
 PRIMARY KEY(authority_id,owner_id,project_id,source_device_id,target_device_id),
 FOREIGN KEY(authority_id,source_device_id) REFERENCES core_dispatch.grants,
 FOREIGN KEY(authority_id,target_device_id) REFERENCES core_dispatch.grants,
 CHECK(source_device_id<>target_device_id)
);
CREATE TABLE IF NOT EXISTS transfer_authority.jobs (
 id uuid PRIMARY KEY,authority_id uuid NOT NULL REFERENCES core_dispatch.authorities,
 owner_id uuid NOT NULL,project_id text NOT NULL,source_device_id uuid NOT NULL,target_device_id uuid NOT NULL,
 target_path_key text NOT NULL,binding jsonb NOT NULL CHECK(jsonb_typeof(binding)='object'),
 epoch bigint NOT NULL CHECK(epoch>0),lease_hash text NOT NULL CHECK(lease_hash ~ '^[a-f0-9]{64}$'),
 confirmed_offset bigint NOT NULL DEFAULT 0 CHECK(confirmed_offset>=0),
 stage_created boolean NOT NULL DEFAULT false,pending_id uuid,
 state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','CANCELLED','COMPLETE')),
 final_receipt jsonb,final_commit jsonb,
 FOREIGN KEY(authority_id,owner_id,project_id,source_device_id,target_device_id) REFERENCES transfer_authority.grants,
 UNIQUE(authority_id,target_device_id,target_path_key),
 CHECK((final_receipt IS NULL)=(final_commit IS NULL)),
 CHECK((state='COMPLETE')=(final_receipt IS NOT NULL AND final_commit IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS transfer_authority.claims (
 request_id uuid PRIMARY KEY,job_id uuid NOT NULL REFERENCES transfer_authority.jobs,
 claim_id uuid NOT NULL UNIQUE,epoch bigint NOT NULL CHECK(epoch>0),
 lease_hash text NOT NULL CHECK(lease_hash ~ '^[a-f0-9]{64}$'),
 intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
 intent jsonb NOT NULL CHECK(jsonb_typeof(intent)='object'),
 state text NOT NULL CHECK(state IN ('ACTIVE','SETTLED','UNKNOWN','SEALED','APPLIED','NO_EFFECT'))
);
CREATE INDEX IF NOT EXISTS transfer_claims_job_state ON transfer_authority.claims(job_id,state);
CREATE OR REPLACE FUNCTION transfer_authority.guard_job_history() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'TRANSFER_JOB_HISTORY_DELETE_DENIED'; END IF;
 IF (NEW.id,NEW.authority_id,NEW.owner_id,NEW.project_id,NEW.source_device_id,NEW.target_device_id,NEW.target_path_key,NEW.binding)
    IS DISTINCT FROM
    (OLD.id,OLD.authority_id,OLD.owner_id,OLD.project_id,OLD.source_device_id,OLD.target_device_id,OLD.target_path_key,OLD.binding)
 OR NEW.epoch<OLD.epoch OR NEW.confirmed_offset<OLD.confirmed_offset
 OR (NEW.epoch=OLD.epoch AND NEW.lease_hash<>OLD.lease_hash)
 OR (OLD.stage_created AND NOT NEW.stage_created)
 OR (OLD.state<>'ACTIVE' AND NEW IS DISTINCT FROM OLD)
 OR (OLD.final_receipt IS NOT NULL AND NEW.final_receipt IS DISTINCT FROM OLD.final_receipt)
 OR (OLD.final_commit IS NOT NULL AND NEW.final_commit IS DISTINCT FROM OLD.final_commit)
 THEN RAISE EXCEPTION 'TRANSFER_JOB_HISTORY_REWRITE_DENIED'; END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS immutable_job_history ON transfer_authority.jobs;
CREATE TRIGGER immutable_job_history BEFORE UPDATE OR DELETE ON transfer_authority.jobs
 FOR EACH ROW EXECUTE FUNCTION transfer_authority.guard_job_history();
CREATE OR REPLACE FUNCTION transfer_authority.guard_claim_history() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'TRANSFER_CLAIM_HISTORY_DELETE_DENIED'; END IF;
 IF (NEW.request_id,NEW.job_id,NEW.claim_id,NEW.epoch,NEW.lease_hash,NEW.intent_hash,NEW.intent)
    IS DISTINCT FROM (OLD.request_id,OLD.job_id,OLD.claim_id,OLD.epoch,OLD.lease_hash,OLD.intent_hash,OLD.intent)
 OR NOT ((OLD.state='ACTIVE' AND NEW.state IN ('SETTLED','UNKNOWN','SEALED','APPLIED')) OR
         (OLD.state IN ('SETTLED','UNKNOWN') AND NEW.state IN ('SEALED','APPLIED','NO_EFFECT')) OR
         (OLD.state='SEALED' AND NEW.state IN ('APPLIED','NO_EFFECT')))
 THEN RAISE EXCEPTION 'TRANSFER_CLAIM_HISTORY_REWRITE_DENIED'; END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS immutable_claim_history ON transfer_authority.claims;
CREATE TRIGGER immutable_claim_history BEFORE UPDATE OR DELETE ON transfer_authority.claims
 FOR EACH ROW EXECUTE FUNCTION transfer_authority.guard_claim_history();
REVOKE ALL ON ALL TABLES IN SCHEMA transfer_authority FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA transfer_authority FROM PUBLIC;
COMMIT;

-- Explicit operator provisioning only, with the core_dispatch.authorities
-- row locked FIRST, then scoped grant rows. No auto-grant, delete/truncate,
-- DDL, restore privileges or transfer grant modifications for service role.
-- GRANT USAGE ON SCHEMA transfer_authority TO protected_dispatch_service;
-- GRANT SELECT ON transfer_authority.grants,transfer_authority.jobs,transfer_authority.claims TO protected_dispatch_service;
-- GRANT INSERT ON transfer_authority.jobs,transfer_authority.claims TO protected_dispatch_service;
-- GRANT UPDATE(epoch,lease_hash,confirmed_offset,stage_created,pending_id,state,final_receipt,final_commit) ON transfer_authority.jobs TO protected_dispatch_service;
-- GRANT UPDATE(state) ON transfer_authority.claims TO protected_dispatch_service;
-- Existing core_dispatch SELECT and UPDATE(max_seen_ms) are required for
-- the shared authority-row revoke fence. Explicitly compose drain observer.
