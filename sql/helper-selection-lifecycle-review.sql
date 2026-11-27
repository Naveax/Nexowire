-- REVIEW ONLY. Do not run on production or wire into runtime.
-- Base: helper-selection-authority.sql 32338077c0cd85789f475b1a76e93ad4a1351863
-- Base: core-broker-dispatch-authority.sql a120585a92d7ab41bb2d1a3aaf5c0bc31f9ca74b
BEGIN;
-- Migration must be performed by operator after global writer freeze/drain.
-- No implicit genesis: existing rows stay NULL until separately anchored enrollment.
ALTER TABLE core_dispatch.authorities
 ADD COLUMN lifecycle_store_id uuid,
 ADD COLUMN lifecycle_sequence bigint,
 ADD COLUMN lifecycle_head text,
 ADD CONSTRAINT lifecycle_anchor_shape CHECK (
 (lifecycle_store_id IS NULL AND lifecycle_sequence IS NULL AND lifecycle_head IS NULL) OR
 (lifecycle_store_id IS NOT NULL AND lifecycle_sequence IS NOT NULL AND lifecycle_sequence >= 0
 AND lifecycle_head IS NOT NULL AND lifecycle_head ~ '^[a-f0-9]{64}$'));
ALTER TABLE helper_selection.leases
 ADD COLUMN lifecycle_scope jsonb,
 ADD COLUMN transaction_sha256 text,
 ADD COLUMN authorization_id uuid,
 ADD COLUMN lifecycle_generation bigint,
 ADD COLUMN consume_sequence bigint,
 ADD COLUMN consume_head text,
 ADD COLUMN terminal_sequence bigint,
 ADD COLUMN terminal_head text,
 ADD COLUMN terminal_evidence_sha256 text,
 ADD COLUMN terminal_outcome text;
-- Legacy FK remains semantically identical for legacy rows. Independent
-- lifecycle rows reference common authority, not a fabricated CORE grant.
ALTER TABLE helper_selection.leases
 ADD COLUMN legacy_authority_id uuid GENERATED ALWAYS AS
 (CASE WHEN kind IN ('RUNTIME','DEPLOYMENT') THEN authority_id END) STORED,
 ADD COLUMN legacy_device_id uuid GENERATED ALWAYS AS
 (CASE WHEN kind IN ('RUNTIME','DEPLOYMENT') THEN device_id END) STORED;
ALTER TABLE helper_selection.leases
 ADD CONSTRAINT lifecycle_common_authority_fk FOREIGN KEY(authority_id) REFERENCES core_dispatch.authorities,
 ADD CONSTRAINT legacy_selection_fk FOREIGN KEY(legacy_authority_id,legacy_device_id) REFERENCES helper_selection.selections;
-- Default constraint names derived from checked-in DDL; fail transaction if drift.
ALTER TABLE helper_selection.leases
 DROP CONSTRAINT leases_authority_id_device_id_fkey,
 DROP CONSTRAINT leases_kind_check,
 ALTER COLUMN expected_revision DROP NOT NULL,
 ADD CONSTRAINT lease_kind_v2 CHECK(kind IN ('RUNTIME','DEPLOYMENT','RECOVERY')),
 ADD CONSTRAINT lifecycle_shape CHECK (
 (kind IN ('RUNTIME','DEPLOYMENT') AND expected_revision IS NOT NULL
 AND lifecycle_scope IS NULL AND transaction_sha256 IS NULL AND authorization_id IS NULL
 AND lifecycle_generation IS NULL AND consume_sequence IS NULL AND consume_head IS NULL
 AND terminal_sequence IS NULL AND terminal_head IS NULL AND terminal_evidence_sha256 IS NULL AND terminal_outcome IS NULL)
 OR (kind='RECOVERY' AND expected_revision IS NULL AND committed_revision IS NULL
 AND lifecycle_scope IS NOT NULL AND jsonb_typeof(lifecycle_scope)='object'
 AND transaction_sha256 IS NOT NULL AND transaction_sha256 ~ '^[a-f0-9]{64}$'
 AND authorization_id IS NOT NULL AND lifecycle_generation IS NOT NULL AND lifecycle_generation>0
 AND consume_sequence IS NOT NULL AND consume_sequence>0 AND consume_head IS NOT NULL AND consume_head ~ '^[a-f0-9]{64}$'
 AND ((state='ACTIVE' AND terminal_sequence IS NULL AND terminal_head IS NULL AND terminal_evidence_sha256 IS NULL AND terminal_outcome IS NULL)
 OR (state='RELEASED' AND terminal_sequence IS NOT NULL AND terminal_sequence>consume_sequence
 AND terminal_head IS NOT NULL AND terminal_head ~ '^[a-f0-9]{64}$'
 AND terminal_evidence_sha256 IS NOT NULL AND terminal_evidence_sha256 ~ '^[a-f0-9]{64}$'
 AND terminal_outcome IS NOT NULL AND terminal_outcome IN ('APPLIED','NO_EFFECT')))));
CREATE UNIQUE INDEX lifecycle_transaction_once ON helper_selection.leases(authority_id,transaction_sha256) WHERE kind='RECOVERY';
CREATE UNIQUE INDEX lifecycle_authorization_once ON helper_selection.leases(authority_id,authorization_id) WHERE kind='RECOVERY';
CREATE UNIQUE INDEX lifecycle_generation_once ON helper_selection.leases(authority_id,device_id,lifecycle_generation) WHERE kind='RECOVERY';
CREATE UNIQUE INDEX lifecycle_consume_sequence_once ON helper_selection.leases(authority_id,consume_sequence) WHERE kind='RECOVERY';
-- Existing helper_one_unreleased_lease remains intact (device-wide exclusion).
CREATE OR REPLACE FUNCTION helper_selection.guard_lease_history() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'HELPER_LEASE_HISTORY_DELETE_DENIED'; END IF;
 IF (NEW.id,NEW.request_id,NEW.authority_id,NEW.device_id,NEW.kind,NEW.request_hash,NEW.expected_revision,
 NEW.lifecycle_scope,NEW.transaction_sha256,NEW.authorization_id,NEW.lifecycle_generation,NEW.consume_sequence,NEW.consume_head)
 IS DISTINCT FROM (OLD.id,OLD.request_id,OLD.authority_id,OLD.device_id,OLD.kind,OLD.request_hash,OLD.expected_revision,
 OLD.lifecycle_scope,OLD.transaction_sha256,OLD.authorization_id,OLD.lifecycle_generation,OLD.consume_sequence,OLD.consume_head)
 THEN RAISE EXCEPTION 'HELPER_LEASE_HISTORY_REWRITE_DENIED'; END IF;
 IF OLD.kind='RECOVERY' THEN
  IF NOT (OLD.state='ACTIVE' AND NEW.state='RELEASED' AND NEW.committed_revision IS NULL
    AND NEW.terminal_outcome IN ('APPLIED','NO_EFFECT') AND NEW.terminal_sequence>OLD.consume_sequence)
  THEN RAISE EXCEPTION 'LIFECYCLE_TERMINAL_TRANSITION_DENIED'; END IF;
 ELSE
  IF NOT ((OLD.state='ACTIVE' AND NEW.state='COMMITTED' AND OLD.kind='DEPLOYMENT' AND NEW.committed_revision IS NOT NULL)
   OR (OLD.state IN ('ACTIVE','COMMITTED') AND NEW.state='RELEASED' AND NEW.committed_revision IS NOT DISTINCT FROM OLD.committed_revision))
  THEN RAISE EXCEPTION 'HELPER_LEASE_HISTORY_REWRITE_DENIED'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
-- Explicit pre-created, distinct NOLOGIN roles, never granted to legacy users:
-- nx_lifecycle_sql_owner (function owner), nx_lifecycle_consume,
-- nx_lifecycle_reconcile (EXECUTE-only group roles for dedicated service logins).
-- No role creation, enrollment or implicit anchor genesis here.
DO $$
DECLARE r record; n integer;
BEGIN
 SELECT count(*) INTO n FROM pg_catalog.pg_roles WHERE rolname IN
 ('nx_lifecycle_sql_owner','nx_lifecycle_consume','nx_lifecycle_reconcile');
 IF n<>3 THEN RAISE EXCEPTION 'LIFECYCLE_ROLES_MISSING'; END IF;
 FOR r IN SELECT * FROM pg_catalog.pg_roles WHERE rolname IN
 ('nx_lifecycle_sql_owner','nx_lifecycle_consume','nx_lifecycle_reconcile') LOOP
  IF r.rolcanlogin OR r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls
  THEN RAISE EXCEPTION 'LIFECYCLE_ROLE_UNSAFE'; END IF;
 END LOOP;
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.roleid WHERE r.rolname='nx_lifecycle_sql_owner')
 THEN RAISE EXCEPTION 'LIFECYCLE_OWNER_MEMBERSHIP_DENIED'; END IF;
 IF pg_has_role('nx_lifecycle_consume','nx_lifecycle_reconcile','MEMBER') OR pg_has_role('nx_lifecycle_reconcile','nx_lifecycle_consume','MEMBER')
 THEN RAISE EXCEPTION 'LIFECYCLE_ROLE_COLLISION'; END IF;
END $$;
-- SECURITY INVOKER: current_user is the dedicated function owner ONLY inside
-- the protected SECURITY DEFINER function. Legacy column/table grants cannot
-- manufacture a lifecycle row or release one. No caller-controlled GUC.
CREATE FUNCTION helper_selection.guard_lifecycle_admission() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE a uuid; anchored uuid;
BEGIN
 a:=NEW.authority_id;
 SELECT lifecycle_store_id INTO anchored FROM core_dispatch.authorities WHERE authority_id=a FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'LIFECYCLE_AUTHORITY_MISSING'; END IF;
 IF NEW.kind='RECOVERY' OR (TG_OP='UPDATE' AND OLD.kind='RECOVERY') THEN
  IF current_user<>'nx_lifecycle_sql_owner' OR anchored IS NULL THEN RAISE EXCEPTION 'LIFECYCLE_DIRECT_WRITE_DENIED'; END IF;
 ELSE
  IF current_user='nx_lifecycle_sql_owner' THEN RAISE EXCEPTION 'LIFECYCLE_LEGACY_ROLE_DENIED'; END IF;
  -- No legacy writer has implemented witness participation yet. Existing
  -- unanchored authorities retain behavior; anchored ones deliberately freeze.
  IF anchored IS NOT NULL THEN RAISE EXCEPTION 'LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER lifecycle_admission BEFORE INSERT OR UPDATE ON helper_selection.leases
 FOR EACH ROW EXECUTE FUNCTION helper_selection.guard_lifecycle_admission();
CREATE FUNCTION helper_selection.guard_lifecycle_anchor() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.lifecycle_store_id IS NOT NULL THEN RAISE EXCEPTION 'LIFECYCLE_ANCHOR_DELETE_DENIED'; END IF;
  RETURN OLD;
 ELSIF TG_OP='INSERT' THEN
  IF NEW.lifecycle_store_id IS NOT NULL THEN RAISE EXCEPTION 'LIFECYCLE_GENESIS_REQUIRES_OPERATOR'; END IF;
 ELSIF (NEW.lifecycle_store_id,NEW.lifecycle_sequence,NEW.lifecycle_head) IS DISTINCT FROM
 (OLD.lifecycle_store_id,OLD.lifecycle_sequence,OLD.lifecycle_head) THEN
  IF current_user<>'nx_lifecycle_sql_owner' OR OLD.lifecycle_store_id IS NULL OR
     NEW.lifecycle_store_id IS DISTINCT FROM OLD.lifecycle_store_id OR
     NEW.lifecycle_sequence IS DISTINCT FROM OLD.lifecycle_sequence+1
  THEN RAISE EXCEPTION 'LIFECYCLE_ANCHOR_DIRECT_WRITE_DENIED'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER lifecycle_anchor_guard BEFORE INSERT OR UPDATE OR DELETE ON core_dispatch.authorities
 FOR EACH ROW EXECUTE FUNCTION helper_selection.guard_lifecycle_anchor();
-- Prevent a legacy direct selection write from changing helper identity behind
-- an anchored lifecycle authority. Lock order is authority before mutation;
-- out-of-order direct SQL may deadlock and abort, never admit an effect.
CREATE FUNCTION helper_selection.guard_anchored_selection() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE anchored uuid;
BEGIN
 SELECT lifecycle_store_id INTO anchored FROM core_dispatch.authorities WHERE authority_id=OLD.authority_id FOR UPDATE;
 IF NOT FOUND OR anchored IS NOT NULL THEN RAISE EXCEPTION 'LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF (NEW.authority_id,NEW.device_id) IS DISTINCT FROM (OLD.authority_id,OLD.device_id) THEN
  RAISE EXCEPTION 'LIFECYCLE_SELECTION_IDENTITY_REWRITE_DENIED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER lifecycle_selection_guard BEFORE UPDATE OR DELETE ON helper_selection.selections
 FOR EACH ROW EXECUTE FUNCTION helper_selection.guard_anchored_selection();
-- Stage only. Neither function authenticates an external signature or emits
-- an effect ACK. Caller holds the transaction across independent witness CAS.
-- Role is trusted service boundary, NOT an Agent credential.
CREATE FUNCTION helper_selection.stage_recovery_consume(s jsonb, lease uuid, prev_seq bigint, prev_hash text, next_hash text)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a core_dispatch.authorities%ROWTYPE; aid uuid; did uuid; inserted uuid;
BEGIN
 IF NOT pg_has_role(session_user,'nx_lifecycle_consume','MEMBER') OR pg_has_role(session_user,'nx_lifecycle_reconcile','MEMBER')
 THEN RAISE EXCEPTION 'LIFECYCLE_CONSUME_ROLE_DENIED'; END IF;
 IF s IS NULL OR jsonb_typeof(s)<>'object' OR NOT (s ?& ARRAY[
 'authorityId','storeId','ownerAccountId','ownerEpoch','directoryHead','deviceId','installationLineageId','resourceId','bootId','sessionEpoch','generation','purpose','transactionSha256','authorizationId','attemptId','requestId','challenge','requestSha256','bindingSha256','envelopeSha256','signerSpkiSha256','deadlineMs'])
 OR (SELECT count(*) FROM jsonb_object_keys(s))<>22
 OR EXISTS (SELECT 1 FROM unnest(ARRAY['authorityId','storeId','ownerAccountId','deviceId','installationLineageId','resourceId','bootId','sessionEpoch','authorizationId','attemptId','requestId']) AS k(key)
   WHERE jsonb_typeof(s->k.key) IS DISTINCT FROM 'string' OR (s->>k.key) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
 OR EXISTS (SELECT 1 FROM unnest(ARRAY['directoryHead','transactionSha256','challenge','requestSha256','bindingSha256','envelopeSha256','signerSpkiSha256']) AS k(key)
   WHERE jsonb_typeof(s->k.key) IS DISTINCT FROM 'string' OR (s->>k.key) !~ '^[0-9a-f]{64}$')
 OR EXISTS (SELECT 1 FROM unnest(ARRAY['ownerEpoch','generation']) AS k(key)
   WHERE jsonb_typeof(s->k.key) IS DISTINCT FROM 'string' OR (s->>k.key) !~ '^[1-9][0-9]{0,18}$')
 OR jsonb_typeof(s->'deadlineMs') IS DISTINCT FROM 'number'
 THEN RAISE EXCEPTION 'LIFECYCLE_SCOPE_SHAPE_DENIED'; END IF;
 aid:=(s->>'authorityId')::uuid; did:=(s->>'deviceId')::uuid;
 SELECT * INTO a FROM core_dispatch.authorities WHERE authority_id=aid FOR UPDATE;
 IF NOT FOUND OR a.lifecycle_store_id IS NULL OR a.lifecycle_store_id IS DISTINCT FROM (s->>'storeId')::uuid OR
 a.lifecycle_sequence IS DISTINCT FROM prev_seq OR a.lifecycle_head IS DISTINCT FROM prev_hash OR next_hash IS NULL OR next_hash=prev_hash OR
 jsonb_typeof(s->'purpose') IS DISTINCT FROM 'string' OR s->>'purpose' NOT IN ('rollback','coordinated-uninstall') OR
 s->>'ownerAccountId' IS NULL OR s->>'ownerEpoch' IS NULL OR s->>'directoryHead' IS NULL OR
 s->>'installationLineageId' IS NULL OR s->>'resourceId' IS NULL OR
 (s->>'deadlineMs')::bigint IS NULL OR (s->>'deadlineMs')::bigint<=floor(extract(epoch from clock_timestamp())*1000) OR
 (s->>'deadlineMs')::bigint>floor(extract(epoch from clock_timestamp())*1000)+30000
 THEN RAISE EXCEPTION 'LIFECYCLE_SCOPE_OR_ANCHOR_DENIED'; END IF;
 IF EXISTS (SELECT 1 FROM helper_selection.leases WHERE authority_id=aid AND device_id=did AND state<>'RELEASED')
 THEN RAISE EXCEPTION 'LIFECYCLE_OCCUPIED'; END IF;
 INSERT INTO helper_selection.leases(id,request_id,authority_id,device_id,kind,request_hash,state,lifecycle_scope,transaction_sha256,authorization_id,lifecycle_generation,consume_sequence,consume_head)
 VALUES(lease,(s->>'requestId')::uuid,aid,did,'RECOVERY',s->>'requestSha256','ACTIVE',s,s->>'transactionSha256',(s->>'authorizationId')::uuid,(s->>'generation')::bigint,prev_seq+1,next_hash)
 ON CONFLICT DO NOTHING RETURNING id INTO inserted;
 IF inserted IS DISTINCT FROM lease THEN RAISE EXCEPTION 'LIFECYCLE_REPLAY_OR_CONFLICT'; END IF;
 UPDATE core_dispatch.authorities SET lifecycle_sequence=prev_seq+1,lifecycle_head=next_hash WHERE authority_id=aid;
 RETURN inserted;
END $$;
CREATE FUNCTION helper_selection.stage_recovery_terminal(s jsonb, lease uuid, original_seq bigint, original_hash text, prev_seq bigint, prev_hash text, next_hash text, outcome text, evidence_hash text)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a core_dispatch.authorities%ROWTYPE; aid uuid; released uuid;
BEGIN
 IF NOT pg_has_role(session_user,'nx_lifecycle_reconcile','MEMBER') OR pg_has_role(session_user,'nx_lifecycle_consume','MEMBER')
 THEN RAISE EXCEPTION 'LIFECYCLE_RECONCILE_ROLE_DENIED'; END IF;
 aid:=(s->>'authorityId')::uuid;
 SELECT * INTO a FROM core_dispatch.authorities WHERE authority_id=aid FOR UPDATE;
 IF NOT FOUND OR a.lifecycle_store_id IS NULL OR a.lifecycle_store_id IS DISTINCT FROM (s->>'storeId')::uuid OR
 a.lifecycle_sequence IS DISTINCT FROM prev_seq OR a.lifecycle_head IS DISTINCT FROM prev_hash OR next_hash IS NULL OR next_hash=prev_hash
 THEN RAISE EXCEPTION 'LIFECYCLE_ANCHOR_CAS_FAILED'; END IF;
 UPDATE helper_selection.leases SET state='RELEASED',terminal_sequence=prev_seq+1,terminal_head=next_hash,terminal_evidence_sha256=evidence_hash,terminal_outcome=outcome
 WHERE id=lease AND authority_id=aid AND device_id=(s->>'deviceId')::uuid AND kind='RECOVERY' AND state='ACTIVE'
 AND lifecycle_scope=s AND consume_sequence=original_seq AND consume_head=original_hash RETURNING id INTO released;
 IF released IS DISTINCT FROM lease THEN RAISE EXCEPTION 'LIFECYCLE_TERMINAL_CAS_FAILED'; END IF;
 UPDATE core_dispatch.authorities SET lifecycle_sequence=prev_seq+1,lifecycle_head=next_hash WHERE authority_id=aid;
 RETURN released;
END $$;
REVOKE ALL ON FUNCTION helper_selection.stage_recovery_consume(jsonb,uuid,bigint,text,text),helper_selection.stage_recovery_terminal(jsonb,uuid,bigint,text,bigint,text,text,text,text) FROM PUBLIC;
ALTER FUNCTION helper_selection.stage_recovery_consume(jsonb,uuid,bigint,text,text) OWNER TO nx_lifecycle_sql_owner;
ALTER FUNCTION helper_selection.stage_recovery_terminal(jsonb,uuid,bigint,text,bigint,text,text,text,text) OWNER TO nx_lifecycle_sql_owner;
GRANT USAGE ON SCHEMA core_dispatch,helper_selection TO nx_lifecycle_sql_owner,nx_lifecycle_consume,nx_lifecycle_reconcile;
GRANT SELECT ON core_dispatch.authorities,helper_selection.leases TO nx_lifecycle_sql_owner,nx_lifecycle_consume,nx_lifecycle_reconcile;
GRANT UPDATE(lifecycle_sequence,lifecycle_head) ON core_dispatch.authorities TO nx_lifecycle_sql_owner;
GRANT INSERT ON helper_selection.leases TO nx_lifecycle_sql_owner;
GRANT UPDATE(state,terminal_sequence,terminal_head,terminal_evidence_sha256,terminal_outcome) ON helper_selection.leases TO nx_lifecycle_sql_owner;
-- SELECT FOR UPDATE by service roles needs UPDATE on at least one column;
-- keep it inside a dedicated definer read-lock function, not a direct grant.
CREATE FUNCTION helper_selection.lock_recovery_anchor(aid uuid)
 RETURNS TABLE(lifecycle_store_id uuid,lifecycle_sequence bigint,lifecycle_head text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT a.lifecycle_store_id,a.lifecycle_sequence,a.lifecycle_head FROM core_dispatch.authorities a WHERE a.authority_id=aid FOR UPDATE
$$;
ALTER FUNCTION helper_selection.lock_recovery_anchor(uuid) OWNER TO nx_lifecycle_sql_owner;
REVOKE ALL ON FUNCTION helper_selection.lock_recovery_anchor(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helper_selection.lock_recovery_anchor(uuid) TO nx_lifecycle_consume,nx_lifecycle_reconcile;
GRANT EXECUTE ON FUNCTION helper_selection.stage_recovery_consume(jsonb,uuid,bigint,text,text) TO nx_lifecycle_consume;
GRANT EXECUTE ON FUNCTION helper_selection.stage_recovery_terminal(jsonb,uuid,bigint,text,bigint,text,text,text,text) TO nx_lifecycle_reconcile;
REVOKE ALL ON FUNCTION helper_selection.guard_lifecycle_admission(),helper_selection.guard_lifecycle_anchor(),helper_selection.guard_anchored_selection() FROM PUBLIC;
-- Abort on unexpected default ACLs, mixed role membership or inherited raw
-- writes for service principals that already exist at migration time. Repeat
-- this audit after every provisioning/role change; this is not an admin fence.
DO $$
DECLARE r record; c boolean; t boolean;
BEGIN
 FOR r IN SELECT oid,rolname,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls FROM pg_catalog.pg_roles
 WHERE NOT rolsuper AND rolname<>'nx_lifecycle_sql_owner' LOOP
  c:=pg_has_role(r.oid,'nx_lifecycle_consume','MEMBER');
  t:=pg_has_role(r.oid,'nx_lifecycle_reconcile','MEMBER');
  IF c AND t THEN RAISE EXCEPTION 'LIFECYCLE_SERVICE_ROLE_COLLISION'; END IF;
  IF (has_function_privilege(r.oid,'helper_selection.stage_recovery_consume(jsonb,uuid,bigint,text,text)','EXECUTE') AND NOT c)
   OR (has_function_privilege(r.oid,'helper_selection.stage_recovery_terminal(jsonb,uuid,bigint,text,bigint,text,text,text,text)','EXECUTE') AND NOT t)
   OR (has_function_privilege(r.oid,'helper_selection.lock_recovery_anchor(uuid)','EXECUTE') AND NOT (c OR t))
  THEN RAISE EXCEPTION 'LIFECYCLE_UNEXPECTED_FUNCTION_ACL'; END IF;
  IF (c OR t) AND (r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls
   OR has_any_column_privilege(r.oid,'helper_selection.leases','INSERT,UPDATE')
   OR has_any_column_privilege(r.oid,'helper_selection.selections','INSERT,UPDATE')
   OR has_any_column_privilege(r.oid,'core_dispatch.authorities','INSERT,UPDATE')
   OR has_table_privilege(r.oid,'helper_selection.leases','DELETE,TRUNCATE,TRIGGER')
   OR has_table_privilege(r.oid,'helper_selection.selections','DELETE,TRUNCATE,TRIGGER')
   OR has_table_privilege(r.oid,'core_dispatch.authorities','DELETE,TRUNCATE,TRIGGER')
   OR has_schema_privilege(r.oid,'helper_selection','CREATE') OR has_schema_privilege(r.oid,'core_dispatch','CREATE'))
  THEN RAISE EXCEPTION 'LIFECYCLE_SERVICE_DIRECT_PRIVILEGE_DENIED'; END IF;
 END LOOP;
END $$;
-- Deployment MUST audit all inherited memberships, table/column grants, schema
-- owners, trigger bypass/replication and PUBLIC. No existing runtime role may
-- be a member of these service groups. No production login GRANT here.
-- Bootstrap intentionally withheld pending all-writer drain and external genesis.
COMMIT;
