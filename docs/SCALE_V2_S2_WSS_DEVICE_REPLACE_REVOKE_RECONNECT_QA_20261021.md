# S2 #13 WSS pairing replacement/reconnect replay negative QA

21 October 2026. Parent: #701 exact HEAD 61ef8373ab98904b4aef4b9d44d1c5bd4ccc0afa,
Actions 39646018390 SUCCESS. #701 is a DRAFT child of OPEN DRAFT #671.
SOURCE-ONLY / STAGING SQLITE / PRODUCTION NO-GO.

## Independently reproduced failure

The #701 opt-in pairing guard increments signed receipt minimumProfileRevision
for normal UPDATE of owner or enabled status, and device signer key changes.
But owner/device pairing table proposed_owner_quota_devices had only an
AFTER UPDATE trigger. A row INSERT OR REPLACE, or DELETE followed by INSERT
with the original device ID/key, does not fire that UPDATE trigger.
Owner account A->B->A using REPLACE thereby left a signed old unused WSS
receipt admissible on reconnect.

Two negative tests FAILED on pristine #701 head with assertions:
"every device re-pair must advance trusted WSS revision" and
"deletion and recreated pairing must advance WSS revision".

This is a staging source revocation weakness, not a proven external exploit.

## Narrow mitigation

Only the explicitly opt-in disposable staging guard fixture
test/fixtures/scale-v2-owner-wss-pairing-revision-guard-dev.sql adds:
1. AFTER INSERT ON proposed_owner_quota_devices: increment persisted
   independent WSS profile revision for the inserted device ID.
2. AFTER DELETE ON proposed_owner_quota_devices: increment persisted
   independent WSS profile revision for the deleted device ID.

No native Agent, WSS issuer, #612 async proof, #671 receipt journal,
Broker, production DB migration or Cloudflare source is changed.

## Evidence and gates

- Two new test-first negative cases fail before and pass after fix.
- Two independent simulated devices using the same nonce still obtain
  individually signed WSS enrollment receipts once each; replay per
  device denies.
- Issuer Ed25519 public key/keyID rotation rejects stale receipts.
- Foreign owner real operator-signed receipt cannot authorize old owner.
- Signer re-pair/rotation, revoked key restore, owner A->B->A and
  key INSERT OR REPLACE fence the old unused signed receipt.
- A new disposable disk SQLite test closes and reopens the database
  after signer rotation; revised epoch persists and rejects old
  receipt on reconnect, while fresh signed receipt succeeds.
- Expanded own suite 11/11 PASS; broad local WSS+quota+CORE/pairing
  171/171 PASS with bounded concurrency=2.
- Source tests do NOT equal physical TLS certificate, TPM or signed
  installer acceptance. Host exact-HEAD CI is required.

## Strict production non-acceptance

Guard only loads in opt-in staging SQL. Real owner pairing lifecycle,
non-restorable monotonically increasing revision, global distributed CAS,
OAuth operator rotation, protected persistent Windows device signer/TPM,
named Cloudflare Tunnel TLS/cert and native HIGH-token Broker are all
unverified. Restoring an old database image can resurrect old revisions
unless separate external monotonic authority prevents it.

WSS enrollment and device login NEVER confer Windows CORE HIGH integrity.
No live OAuth/Cloudflare/Agent/UAC/VM/TPM changes were made.

Verdict: isolated source regression fix only, PRODUCTION NO-GO.
