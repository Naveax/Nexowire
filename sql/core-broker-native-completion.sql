-- Operator-only migration after core-broker-dispatch-authority.sql.
-- A distinct protected OS observer writes completion receipts; neither the
-- caller nor dispatch runtime may write, replace or delete them.
BEGIN;
CREATE TABLE IF NOT EXISTS core_dispatch.native_completion_policy (
 authority_id uuid PRIMARY KEY REFERENCES core_dispatch.authorities,
 signer_spki_sha256 text NOT NULL CHECK(signer_spki_sha256 ~ '^[a-f0-9]{64}$')
);
CREATE TABLE IF NOT EXISTS core_dispatch.native_effect_completions (
 request_id uuid PRIMARY KEY REFERENCES core_dispatch.claims,
 authority_id uuid NOT NULL REFERENCES core_dispatch.native_completion_policy,
 dispatch_id uuid NOT NULL,
 commit_nonce text NOT NULL CHECK(commit_nonce ~ '^[a-f0-9]{64}$'),
 payload text NOT NULL CHECK(length(payload) BETWEEN 1 AND 16384),
 signature text NOT NULL CHECK(length(signature)=86)
);
CREATE OR REPLACE FUNCTION core_dispatch.guard_native_completion_history()
 RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 RAISE EXCEPTION 'DISPATCH_NATIVE_COMPLETION_HISTORY_IMMUTABLE';
END;
$$;
DROP TRIGGER IF EXISTS immutable_native_completion_policy ON core_dispatch.native_completion_policy;
CREATE TRIGGER immutable_native_completion_policy BEFORE UPDATE OR DELETE
 ON core_dispatch.native_completion_policy FOR EACH ROW
 EXECUTE FUNCTION core_dispatch.guard_native_completion_history();
DROP TRIGGER IF EXISTS immutable_native_completion_history ON core_dispatch.native_effect_completions;
CREATE TRIGGER immutable_native_completion_history BEFORE UPDATE OR DELETE
 ON core_dispatch.native_effect_completions FOR EACH ROW
 EXECUTE FUNCTION core_dispatch.guard_native_completion_history();

-- Exact committed claim identity is mandatory. A proof may arrive after
-- credential revocation or a lost HTTP release acknowledgement.
CREATE OR REPLACE FUNCTION core_dispatch.guard_native_completion_insert()
 RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM core_dispatch.claims c
  WHERE c.request_id=NEW.request_id AND c.authority_id=NEW.authority_id
   AND c.dispatch_id=NEW.dispatch_id AND c.commit_nonce=NEW.commit_nonce
   AND c.state='COMMITTED') THEN
  RAISE EXCEPTION 'DISPATCH_NATIVE_COMPLETION_CLAIM_MISMATCH';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS native_completion_insert_scope ON core_dispatch.native_effect_completions;
CREATE TRIGGER native_completion_insert_scope BEFORE INSERT
 ON core_dispatch.native_effect_completions FOR EACH ROW
 EXECUTE FUNCTION core_dispatch.guard_native_completion_insert();

-- An explicitly provisioned authority must never release a committed claim
-- without a distinct observer record. The service additionally checks the
-- Ed25519 signature and all receipt fields; SQL existence is not that check.
CREATE OR REPLACE FUNCTION core_dispatch.guard_committed_release()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF OLD.state='COMMITTED' AND NEW.state='RELEASED'
  AND EXISTS(SELECT 1 FROM core_dispatch.native_completion_policy p WHERE p.authority_id=OLD.authority_id)
  AND NOT EXISTS(SELECT 1 FROM core_dispatch.native_effect_completions c
   WHERE c.request_id=OLD.request_id AND c.authority_id=OLD.authority_id
    AND c.dispatch_id=OLD.dispatch_id AND c.commit_nonce=OLD.commit_nonce) THEN
  RAISE EXCEPTION 'DISPATCH_NATIVE_COMPLETION_REQUIRED';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS committed_release_requires_native_completion ON core_dispatch.claims;
CREATE TRIGGER committed_release_requires_native_completion BEFORE UPDATE
 ON core_dispatch.claims FOR EACH ROW
 EXECUTE FUNCTION core_dispatch.guard_committed_release();

REVOKE ALL ON core_dispatch.native_completion_policy,core_dispatch.native_effect_completions FROM PUBLIC;
REVOKE ALL ON FUNCTION core_dispatch.guard_native_completion_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION core_dispatch.guard_native_completion_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION core_dispatch.guard_committed_release() FROM PUBLIC;
COMMIT;
-- Explicit operator grants only. The dispatch runtime receives SELECT on
-- both tables, never INSERT/UPDATE/DELETE/TRUNCATE/ownership.
-- A separately protected observer writer receives SELECT on claims and
-- INSERT on native_effect_completions, never grant or claim updates.
-- Independent signer custody and capability-specific physical completion
-- evidence are mandatory; the migration does not manufacture a receipt.
