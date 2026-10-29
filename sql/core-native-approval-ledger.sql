-- Explicit migration by the independent operator, NEVER application startup.
-- Durable SQL transactions are not proof against an operator restoring this DB.
-- Every service operation also requires the separately protected restore gate.
BEGIN;
CREATE SCHEMA IF NOT EXISTS core_approval;
REVOKE ALL ON SCHEMA core_approval FROM PUBLIC;
CREATE TABLE IF NOT EXISTS core_approval.authorities (
 authority_id uuid PRIMARY KEY,
 max_seen_ms bigint NOT NULL CHECK(max_seen_ms>0)
);
CREATE TABLE IF NOT EXISTS core_approval.bindings (
 authority_id uuid NOT NULL REFERENCES core_approval.authorities,
 device_id text NOT NULL,
 binding jsonb NOT NULL CHECK(jsonb_typeof(binding)='object'),
 state text NOT NULL CHECK(state IN ('ACTIVE','REVOKED')),
 PRIMARY KEY(authority_id,device_id)
);
-- PostgreSQL row-locking SELECT requires UPDATE on at least one column. Give
-- the runtime only a permanently false sentinel, NEVER owner/epoch/state.
ALTER TABLE core_approval.bindings ADD COLUMN IF NOT EXISTS read_lock_guard boolean
 NOT NULL DEFAULT false CHECK(read_lock_guard=false);
CREATE TABLE IF NOT EXISTS core_approval.credentials (
 credential_id text PRIMARY KEY,
 authority_id uuid NOT NULL,device_id text NOT NULL,
 rp_id text NOT NULL,public_key_pem text NOT NULL,user_handle text,
 credential_binding jsonb NOT NULL CHECK(jsonb_typeof(credential_binding)='object'),
 signature_counter bigint NOT NULL CHECK(signature_counter BETWEEN 0 AND 4294967295),
 active boolean NOT NULL,
 FOREIGN KEY(authority_id,device_id) REFERENCES core_approval.bindings
);
-- No legacy owner/credential binding is invented during migration.
ALTER TABLE core_approval.credentials ADD COLUMN IF NOT EXISTS credential_binding jsonb;
CREATE TABLE IF NOT EXISTS core_approval.challenges (
 challenge_id uuid PRIMARY KEY,
 nonce text NOT NULL UNIQUE CHECK(nonce ~ '^[a-f0-9]{64}$'),
 authority_id uuid NOT NULL,device_id text NOT NULL,
 credential_id text NOT NULL REFERENCES core_approval.credentials,
 intent jsonb NOT NULL CHECK(jsonb_typeof(intent)='object'),
 intent_sha256 text NOT NULL UNIQUE CHECK(intent_sha256 ~ '^[a-f0-9]{64}$'),
 issued_ms bigint NOT NULL,expires_ms bigint NOT NULL CHECK(expires_ms>issued_ms),
 state text NOT NULL DEFAULT 'ISSUED' CHECK(state IN ('ISSUED','CONSUMED')),
 receipt_id uuid UNIQUE,assertion_sha256 text,assertion jsonb,
 previous_counter bigint,next_counter bigint,consumed_ms bigint,
 FOREIGN KEY(authority_id,device_id) REFERENCES core_approval.bindings,
 CHECK((state='ISSUED' AND receipt_id IS NULL AND assertion_sha256 IS NULL AND assertion IS NULL
   AND previous_counter IS NULL AND next_counter IS NULL AND consumed_ms IS NULL)
 OR (state='CONSUMED' AND receipt_id IS NOT NULL AND assertion_sha256 IS NOT NULL
   AND assertion IS NOT NULL AND jsonb_typeof(assertion)='object'
   AND consumed_ms IS NOT NULL AND previous_counter IS NOT NULL AND next_counter IS NOT NULL
   AND assertion_sha256 ~ '^[a-f0-9]{64}$' AND consumed_ms>=issued_ms
   AND consumed_ms<expires_ms AND previous_counter BETWEEN 0 AND 4294967295
   AND next_counter BETWEEN previous_counter AND 4294967295))
);
-- Earlier experimental records without authenticator bytes remain unusable:
-- the verifier fails closed instead of synthesizing or resetting their proof.
ALTER TABLE core_approval.challenges ADD COLUMN IF NOT EXISTS assertion jsonb;
CREATE OR REPLACE FUNCTION core_approval.guard_challenge_history() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CORE_APPROVAL_HISTORY_DELETE_DENIED'; END IF;
 IF (NEW.challenge_id,NEW.nonce,NEW.authority_id,NEW.device_id,NEW.credential_id,
     NEW.intent,NEW.intent_sha256,NEW.issued_ms,NEW.expires_ms)
    IS DISTINCT FROM
    (OLD.challenge_id,OLD.nonce,OLD.authority_id,OLD.device_id,OLD.credential_id,
     OLD.intent,OLD.intent_sha256,OLD.issued_ms,OLD.expires_ms)
 OR OLD.state<>'ISSUED' OR NEW.state<>'CONSUMED' THEN
  RAISE EXCEPTION 'CORE_APPROVAL_HISTORY_REWRITE_DENIED';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS immutable_approval_history ON core_approval.challenges;
CREATE TRIGGER immutable_approval_history BEFORE UPDATE OR DELETE
 ON core_approval.challenges FOR EACH ROW EXECUTE FUNCTION core_approval.guard_challenge_history();
CREATE OR REPLACE FUNCTION core_approval.guard_credential_counter() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (NEW.credential_id,NEW.authority_id,NEW.device_id,NEW.rp_id,NEW.public_key_pem,NEW.user_handle,NEW.credential_binding)
    IS DISTINCT FROM
    (OLD.credential_id,OLD.authority_id,OLD.device_id,OLD.rp_id,OLD.public_key_pem,OLD.user_handle,OLD.credential_binding)
 OR NEW.signature_counter<OLD.signature_counter THEN
  RAISE EXCEPTION 'CORE_APPROVAL_CREDENTIAL_REWRITE_DENIED';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS immutable_credential_pin ON core_approval.credentials;
CREATE TRIGGER immutable_credential_pin BEFORE UPDATE ON core_approval.credentials
 FOR EACH ROW EXECUTE FUNCTION core_approval.guard_credential_counter();
REVOKE ALL ON ALL TABLES IN SCHEMA core_approval FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA core_approval FROM PUBLIC;
COMMIT;

-- Independently enroll and provision binding/credential rows before use. The
-- runtime role must not own tables, provision/rebind owners, replace keys,
-- reset counters, delete/truncate history or bypass the external restore gate.
-- GRANT USAGE ON SCHEMA core_approval TO protected_approval_service;
-- GRANT SELECT ON ALL TABLES IN SCHEMA core_approval TO protected_approval_service;
-- GRANT UPDATE(max_seen_ms) ON core_approval.authorities TO protected_approval_service;
-- GRANT UPDATE(read_lock_guard) ON core_approval.bindings TO protected_approval_service;
-- GRANT UPDATE(signature_counter) ON core_approval.credentials TO protected_approval_service;
-- GRANT INSERT(challenge_id,nonce,authority_id,device_id,credential_id,intent,intent_sha256,issued_ms,expires_ms)
--   ON core_approval.challenges TO protected_approval_service;
-- GRANT UPDATE(state,receipt_id,assertion_sha256,assertion,previous_counter,next_counter,consumed_ms)
--   ON core_approval.challenges TO protected_approval_service;
