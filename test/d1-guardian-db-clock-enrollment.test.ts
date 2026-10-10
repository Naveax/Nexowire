import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,sign,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {
  guardianKeyEnrollmentSigningBytes,
} from '../src/protocol/guardian-key-enrollment-proof.js';
import {
  verifyAndConsumeGuardianEnrollmentChallenge,
} from '../src/product/d1-guardian-enrollment-challenge.js';
import type {D1DatabaseLike} from '../src/product/d1-control-plane-store.js';

const key=generateKeyPairSync('ed25519');
const publicKeySpki=key.publicKey.export({format:'der',type:'spki'}).toString('base64url');

function fixture(kind:'live'|'expired-at-execution') {
  const db=new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE devices(
      id TEXT PRIMARY KEY,
      owner_account_id TEXT NOT NULL,
      credential_hash TEXT NOT NULL,
      platform TEXT NOT NULL,
      access_mode TEXT NOT NULL,
      online INTEGER NOT NULL,
      privilege_mode TEXT NOT NULL,
      admin_bridge_ready INTEGER NOT NULL
    );
    CREATE TABLE device_guardian_enrollment_challenges(
      request_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      owner_account_id TEXT NOT NULL,
      credential_binding TEXT NOT NULL,
      nonce_hash TEXT NOT NULL,
      purpose TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    );
  `);
  const now=Date.now();
  const issuedAt=new Date(now-(kind==='live'?20_000:150_000)).toISOString();
  const expiresAt=new Date(now+(kind==='live'?65_000:-35_000)).toISOString();
  const nonce=randomBytes(32).toString('base64url');
  const challenge={
    type:'guardian.key-enrollment-challenge' as const,version:1 as const,
    requestId:'11111111-1111-4111-8111-111111111111',
    deviceId:'device-1',ownerAccountId:'owner-1',
    credentialBinding:'a'.repeat(64),
    nonce,purpose:'bridge-mode-receipts' as const,issuedAt,expiresAt,
  };
  db.prepare(`INSERT INTO devices(
    id,owner_account_id,credential_hash,platform,access_mode,
    online,privilege_mode,admin_bridge_ready
  ) VALUES(?, ?, ?, 'win32', 'full', 1, 'broker', 1)`).run(
    challenge.deviceId,challenge.ownerAccountId,challenge.credentialBinding,
  );
  db.prepare(`INSERT INTO device_guardian_enrollment_challenges(
    request_id,device_id,owner_account_id,credential_binding,nonce_hash,
    purpose,issued_at,expires_at,consumed_at
  ) VALUES(?,?,?,?,?,'bridge-mode-receipts',?,?,NULL)`).run(
    challenge.requestId,challenge.deviceId,challenge.ownerAccountId,
    challenge.credentialBinding,
    createHash('sha256').update(Buffer.from(nonce,'base64url')).digest('hex'),
    issuedAt,expiresAt,
  );
  const proof={
    type:'guardian.key-enrollment-proof' as const,version:1 as const,
    challenge,publicKeySpki,
    signature:sign(null,guardianKeyEnrollmentSigningBytes({
      challenge,publicKeySpki,
    }),key.privateKey).toString('base64url'),
  };
  // Test-only adapter executes the REAL SQL using built-in SQLite. No D1,
  // Worker, public endpoint or production account is touched.
  const d1={
    prepare(sql:string) {
      const prepared=db.prepare(sql);
      return {
        bind(...params:unknown[]) {
          return {
            async run() {
              const result=prepared.run(...params as Array<string|number|null>);
              return {success:true,meta:{changes:Number(result.changes)}};
            },
          };
        },
      };
    },
  } as unknown as D1DatabaseLike;
  const ctx={
    deviceId:challenge.deviceId,
    ownerAccountId:challenge.ownerAccountId,
    currentCredentialBinding:challenge.credentialBinding,
    ownerApprovedRequestId:challenge.requestId,
    // In the expired case emulate a valid proof that was delayed in a queue:
    now:new Date(kind==='live'?now:now-110_000),
  };
  const consumed=()=>db.prepare(
    'SELECT consumed_at FROM device_guardian_enrollment_challenges WHERE request_id=?',
  ).get(challenge.requestId) as {consumed_at:string|null};
  return {db,d1,proof,ctx,consumed};
}

test('real SQLite single conditional UPDATE accepts current one-time enrollment only once',async()=>{
  const f=fixture('live');
  try {
    const result=await verifyAndConsumeGuardianEnrollmentChallenge(
      f.d1,f.proof,f.ctx,
    );
    assert.equal(result.possessionVerified,true);
    assert.equal(result.challengeConsumed,true);
    assert.equal(result.enrollmentAuthorized,false);
    assert.ok(f.consumed().consumed_at);
    await assert.rejects(verifyAndConsumeGuardianEnrollmentChallenge(
      f.d1,f.proof,f.ctx,
    ),/GUARDIAN_ENROLLMENT_CHALLENGE_EXPIRED_CONSUMED_OR_REPAIRED/);
  } finally {f.db.close()}
});

test('real SQLite refuses challenge expired at DB execution despite stale valid application time',async()=>{
  const f=fixture('expired-at-execution');
  try {
    await assert.rejects(verifyAndConsumeGuardianEnrollmentChallenge(
      f.d1,f.proof,f.ctx,
    ),/GUARDIAN_ENROLLMENT_CHALLENGE_EXPIRED_CONSUMED_OR_REPAIRED/);
    assert.equal(f.consumed().consumed_at,null);
  } finally {f.db.close()}
});
