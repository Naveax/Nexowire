-- Explicit operator migration, after core-broker-dispatch-authority.sql and
-- core-broker-dispatch-credentials.sql. Never apply automatically at startup.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS claims_authority_request_unique
 ON core_dispatch.claims(authority_id,request_id);
CREATE TABLE IF NOT EXISTS core_dispatch.claim_credentials (
 authority_id uuid NOT NULL,
 request_id uuid NOT NULL,
 credential_sha256 text NOT NULL CHECK(credential_sha256 ~ '^[a-f0-9]{64}$'),
 certificate_sha256 text NOT NULL CHECK(certificate_sha256 ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(authority_id,request_id),
 FOREIGN KEY(authority_id,request_id) REFERENCES core_dispatch.claims(authority_id,request_id),
 FOREIGN KEY(authority_id,credential_sha256) REFERENCES core_dispatch.broker_credentials
);
CREATE OR REPLACE FUNCTION core_dispatch.guard_claim_credential_history()
 RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 RAISE EXCEPTION 'DISPATCH_CLAIM_CREDENTIAL_HISTORY_IMMUTABLE';
END;
$$;
DROP TRIGGER IF EXISTS immutable_claim_credential_history ON core_dispatch.claim_credentials;
CREATE TRIGGER immutable_claim_credential_history BEFORE UPDATE OR DELETE
 ON core_dispatch.claim_credentials FOR EACH ROW
 EXECUTE FUNCTION core_dispatch.guard_claim_credential_history();

-- This function's narrowly scoped definer rights permit a shared row lock
-- without granting credential UPDATE to the dispatch role. The owner must
-- be a protected operator, not the runtime role. No dynamic SQL or raw token.
-- The row lock is retained by the caller's transaction until commit/rollback.
-- In READ COMMITTED an UPDATE that wins the row lock is observed after waiting.
CREATE OR REPLACE FUNCTION core_dispatch.lock_active_broker_credential(
 a uuid, digest text, cert text, broker uuid, owner_id_arg uuid, device uuid,
 device_epoch_arg uuid, session_epoch_arg uuid)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 c core_dispatch.broker_credentials%ROWTYPE;
 now_ms bigint;
BEGIN
 SELECT * INTO c FROM core_dispatch.broker_credentials
 WHERE authority_id=a AND credential_sha256=digest
 FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 now_ms := floor(extract(epoch from clock_timestamp())*1000)::bigint;
 RETURN c.state='ACTIVE' AND c.certificate_sha256=cert
  AND c.broker_id=broker AND c.owner_id=owner_id_arg AND c.device_id=device
  AND c.device_epoch=device_epoch_arg AND c.session_epoch=session_epoch_arg
  AND c.not_before_ms<=now_ms AND c.expires_at_ms>now_ms;
END;
$$;
REVOKE ALL ON core_dispatch.claim_credentials FROM PUBLIC;
REVOKE ALL ON FUNCTION core_dispatch.guard_claim_credential_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION core_dispatch.lock_active_broker_credential(uuid,text,text,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC;
COMMIT;

-- Explicit minimum additional runtime permissions (replace role name under
-- operator control; runtime must not own tables, schema or functions):
-- GRANT SELECT, INSERT ON core_dispatch.claim_credentials TO protected_dispatch_service;
-- GRANT EXECUTE ON FUNCTION core_dispatch.lock_active_broker_credential(uuid,text,text,uuid,uuid,uuid,uuid,uuid) TO protected_dispatch_service;
-- No UPDATE, DELETE, TRUNCATE, TRIGGER or credential provisioning privileges.
-- Revocation of a credential fences new reservations/commits, not an already
-- committed effect. Native drain and scoped release remain separate gates.
