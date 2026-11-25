-- Operator-only migration in the independent CORE authority database.
-- No runtime auto-provisioning, expiry-based lease release or deletion.
BEGIN;
CREATE SCHEMA IF NOT EXISTS helper_selection;
REVOKE ALL ON SCHEMA helper_selection FROM PUBLIC;
CREATE TABLE IF NOT EXISTS helper_selection.selections (
 authority_id uuid NOT NULL, device_id uuid NOT NULL,
 owner_id uuid NOT NULL, device_epoch uuid NOT NULL, session_epoch uuid NOT NULL,
 owner_epoch bigint NOT NULL CHECK(owner_epoch>0),
 generation bigint NOT NULL CHECK(generation>0), broker_id uuid NOT NULL,
 revision uuid NOT NULL,
 sha256 text CHECK(sha256 ~ '^[a-f0-9]{64}$' AND length(sha256)=64),
 signer_sha256 text CHECK(signer_sha256 ~ '^[a-f0-9]{64}$' AND length(signer_sha256)=64),
 PRIMARY KEY(authority_id,device_id),
 FOREIGN KEY(authority_id,device_id) REFERENCES core_dispatch.grants,
 CHECK((sha256 IS NULL)=(signer_sha256 IS NULL))
);
CREATE TABLE IF NOT EXISTS helper_selection.leases (
 id uuid PRIMARY KEY, request_id uuid NOT NULL UNIQUE,
 authority_id uuid NOT NULL, device_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('RUNTIME','DEPLOYMENT')),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$' AND length(request_hash)=64),
 expected_revision uuid NOT NULL, committed_revision uuid,
 state text NOT NULL CHECK(state IN ('ACTIVE','COMMITTED','RELEASED')),
 FOREIGN KEY(authority_id,device_id) REFERENCES helper_selection.selections,
 CHECK(kind='DEPLOYMENT' OR committed_revision IS NULL),
 CHECK(state<>'COMMITTED' OR committed_revision IS NOT NULL),
 CHECK(state<>'ACTIVE' OR committed_revision IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS helper_one_unreleased_lease
 ON helper_selection.leases(authority_id,device_id) WHERE state<>'RELEASED';
CREATE OR REPLACE FUNCTION helper_selection.guard_lease_history() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'HELPER_LEASE_HISTORY_DELETE_DENIED'; END IF;
 IF (NEW.id,NEW.request_id,NEW.authority_id,NEW.device_id,NEW.kind,NEW.request_hash,NEW.expected_revision)
 IS DISTINCT FROM (OLD.id,OLD.request_id,OLD.authority_id,OLD.device_id,OLD.kind,OLD.request_hash,OLD.expected_revision)
 OR NOT ((OLD.state='ACTIVE' AND NEW.state='COMMITTED' AND OLD.kind='DEPLOYMENT' AND NEW.committed_revision IS NOT NULL)
   OR (OLD.state IN ('ACTIVE','COMMITTED') AND NEW.state='RELEASED' AND NEW.committed_revision IS NOT DISTINCT FROM OLD.committed_revision))
 THEN RAISE EXCEPTION 'HELPER_LEASE_HISTORY_REWRITE_DENIED'; END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS immutable_lease_history ON helper_selection.leases;
CREATE TRIGGER immutable_lease_history BEFORE UPDATE OR DELETE ON helper_selection.leases
 FOR EACH ROW EXECUTE FUNCTION helper_selection.guard_lease_history();
REVOKE ALL ON ALL TABLES IN SCHEMA helper_selection FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA helper_selection FROM PUBLIC;
COMMIT;
-- Operator provisions detached selection row with exact current grant identity.
-- Service role: SELECT on core_dispatch.authorities,grants;
-- UPDATE(max_seen_ms) on core_dispatch.authorities; USAGE on both schemas;
-- SELECT on both helper_selection tables; INSERT on leases;
-- UPDATE(state,committed_revision) on leases;
-- UPDATE(revision,sha256,signer_sha256) on selections.
-- No selection INSERT/DELETE, no grant mutation, no schema/table ownership,
-- no lease DELETE/TRUNCATE, no restore privileges. Re-pair/recovery requires
-- independent operator reconciliation and permanent native drain proof.
