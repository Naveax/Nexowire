-- Operator-only migration. Run after core-broker-dispatch-authority.sql.
-- The separate credential reader role receives SELECT only. No enrollment,
-- secret generation, grant creation or credential recovery is automatic.
BEGIN;
CREATE TABLE IF NOT EXISTS core_dispatch.broker_credentials (
 authority_id uuid NOT NULL,
 credential_sha256 text NOT NULL CHECK(credential_sha256 ~ '^[a-f0-9]{64}$'),
 certificate_sha256 text NOT NULL CHECK(certificate_sha256 ~ '^[a-f0-9]{64}$'),
 broker_id uuid NOT NULL,
 owner_id uuid NOT NULL,
 device_id uuid NOT NULL,
 installation_id uuid NOT NULL,
 device_epoch uuid NOT NULL,
 session_epoch uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('ACTIVE','REVOKED')),
 not_before_ms bigint NOT NULL CHECK(not_before_ms>=0),
 expires_at_ms bigint NOT NULL CHECK(expires_at_ms>not_before_ms),
 PRIMARY KEY(authority_id,credential_sha256),
 FOREIGN KEY(authority_id,device_id) REFERENCES core_dispatch.grants
);
CREATE OR REPLACE FUNCTION core_dispatch.guard_broker_credential_history()
 RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'DISPATCH_CREDENTIAL_HISTORY_DELETE_DENIED';
 END IF;
 IF (NEW.authority_id,NEW.credential_sha256,NEW.certificate_sha256,
     NEW.broker_id,NEW.owner_id,NEW.device_id,NEW.installation_id,
     NEW.device_epoch,NEW.session_epoch,NEW.not_before_ms,NEW.expires_at_ms)
    IS DISTINCT FROM
    (OLD.authority_id,OLD.credential_sha256,OLD.certificate_sha256,
     OLD.broker_id,OLD.owner_id,OLD.device_id,OLD.installation_id,
     OLD.device_epoch,OLD.session_epoch,OLD.not_before_ms,OLD.expires_at_ms)
 OR NOT (OLD.state='ACTIVE' AND NEW.state='REVOKED') THEN
  RAISE EXCEPTION 'DISPATCH_CREDENTIAL_HISTORY_REWRITE_DENIED';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS immutable_broker_credential_history
 ON core_dispatch.broker_credentials;
CREATE TRIGGER immutable_broker_credential_history BEFORE UPDATE OR DELETE
 ON core_dispatch.broker_credentials FOR EACH ROW
 EXECUTE FUNCTION core_dispatch.guard_broker_credential_history();
REVOKE ALL ON core_dispatch.broker_credentials FROM PUBLIC;
REVOKE ALL ON FUNCTION core_dispatch.guard_broker_credential_history() FROM PUBLIC;
COMMIT;

-- Separate independent operator must provision a new digest for rotation and
-- revoke the old one; no reactivation or identity rewrite. Database restore
-- remains outside this schema's guarantee; independent provenance is required.
-- Reader role (operator chooses actual role name):
-- GRANT USAGE ON SCHEMA core_dispatch TO protected_dispatch_credential_reader;
-- GRANT SELECT ON core_dispatch.broker_credentials,core_dispatch.grants
--   TO protected_dispatch_credential_reader;
-- No membership in mutation/DDL/provisioning roles, and no table ownership.
