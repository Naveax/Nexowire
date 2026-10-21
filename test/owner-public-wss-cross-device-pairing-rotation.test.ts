import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  ProposedOwnerWssEnrollmentIssuer,serializeOwnerWssDeviceProof,
  type DeviceOwnerWssEnrollmentRequest,
} from '../src/product/owner-public-wss-device-issuer-proposal.js';
import {createOwnerWssSqliteTrustedStateReader}
  from '../src/product/owner-public-wss-owner-state-reader-proposal.js';
import {
  ProposedOwnerPublicWssEnrollmentLease,ProposedOwnerWssSqliteReceiptJournal,
} from '../src/product/owner-public-wss-enrollment-lease-proposal.js';
import type {KeyObject} from 'node:crypto';

const now=1_800_000_000_000;
const account='trusted-account-alpha';
const foreign='foreign-account-beta';
const a='device-alpha-physical';
const b='device-beta-physical';
const token='nwx_test_owner_alpha_oauth_fake_token_001';
const foreignToken='nwx_test_owner_beta_oauth_fake_token_002';
const operator=generateKeyPairSync('ed25519');
const keysA=generateKeyPairSync('ed25519');
const keysB=generateKeyPairSync('ed25519');
const pem=(key:KeyObject)=>key.export({format:'pem',type:'spki'}).toString();
const privatePem=(key:KeyObject)=>key.export({format:'pem',type:'pkcs8'}).toString();
const fingerprint=(key:KeyObject)=>createHash('sha256')
  .update(key.export({format:'der',type:'spki'})).digest('hex');
const profile={
  endpoint:'wss://edge.example.com/internal/owner-quota/v1/outbound',
  expectedHostname:'edge.example.com',caMode:'system' as const,
  trustedSpkiSha256:['a'.repeat(64)],
};
function setup(databasePath=':memory:'){
  const db=new DatabaseSync(databasePath);
  for(const f of [
    'scale-v2-owner-shared-quota-dev.sql',
    'scale-v2-owner-quota-rpc-dev.sql',
    'scale-v2-owner-wss-device-enrollment-dev.sql',
  ])db.exec(readFileSync(path.join(process.cwd(),'test','fixtures',f),'utf8'));
  // Load pairing epoch guards only after all owner tables exist.
  db.exec(readFileSync(path.join(process.cwd(),'test','fixtures',
    'scale-v2-owner-wss-pairing-revision-guard-dev.sql'),'utf8'));
  for(const ownerId of [account,foreign]){
    db.prepare('INSERT INTO proposed_owner_quota_accounts VALUES(?,?,?,?,?)')
      .run(ownerId,'free',null,1,7);
  }
  for(const [deviceId,ownerId,key] of [
    [a,account,keysA.publicKey],[b,account,keysB.publicKey],
  ] as const){
    db.prepare('INSERT INTO proposed_owner_quota_devices VALUES(?,?,?,?)')
      .run(deviceId,ownerId,1,'full');
    db.prepare('INSERT INTO proposed_owner_rpc_device_keys VALUES(?,?,?)')
      .run(deviceId,pem(key),1);
    db.prepare('INSERT INTO proposed_owner_wss_profile_revisions VALUES(?,?,?)')
      .run(deviceId,5,1);
  }
  return db;
}
function issuer(db:DatabaseSync,operatorKey=operator.privateKey,keyId='operator-root-01'){
  return new ProposedOwnerWssEnrollmentIssuer(db,async bearer=>{
    if(bearer===token)return {accountId:account,sessionGeneration:7};
    if(bearer===foreignToken)return {accountId:foreign,sessionGeneration:7};
    return null;
  },{
    operatorId:'wss-owner-operator-001',keyId,
    operatorPrivateKeyPem:privatePem(operatorKey),publicWssProfile:profile,
    validForMs:120_000,clock:()=>now,
  });
}
function proof(deviceId:string,key:KeyObject,nonce:string,bearer=token):
DeviceOwnerWssEnrollmentRequest {
  const input={bearerToken:bearer,deviceId,nonce,signedAtMs:now,
    deviceSignature:''};
  input.deviceSignature=sign(null,serializeOwnerWssDeviceProof(input),key)
    .toString('base64url');
  return input;
}
function stateReader(db:DatabaseSync,deviceId:string,signer:KeyObject,
  accountId=account,operatorKey=operator.publicKey,keyId='operator-root-01'){
  return createOwnerWssSqliteTrustedStateReader(db,{
    operatorId:'wss-owner-operator-001',keyId,
    operatorPublicKeyPem:pem(operatorKey),accountId,deviceId,
    deviceKeySpkiSha256:fingerprint(signer),nowMs:()=>now,
  });
}
const nonce=()=>randomBytes(18).toString('base64url');

test('same nonce on two independent device signing keys is isolated per device, replay denied on each',async()=>{
  const db=setup();
  try{
    const n=nonce();
    const i=issuer(db);
    const envA=await i.issue(proof(a,keysA.privateKey,n));
    const envB=await i.issue(proof(b,keysB.privateKey,n));
    assert.notEqual(envA.signature,envB.signature);
    const journal=new ProposedOwnerWssSqliteReceiptJournal(db);
    await ProposedOwnerPublicWssEnrollmentLease.establishOnce(
      envA,stateReader(db,a,keysA.publicKey),journal,
    );
    await ProposedOwnerPublicWssEnrollmentLease.establishOnce(
      envB,stateReader(db,b,keysB.publicKey),journal,
    );
    for(const [deviceId,key] of [
      [a,keysA.privateKey],[b,keysB.privateKey],
    ] as const){
      await assert.rejects(i.issue(proof(deviceId,key,n)));
    }
    assert.equal((db.prepare(
      'SELECT COUNT(*) AS n FROM proposed_owner_wss_enrollment_nonces'
    ).get() as {n:number}).n,2);
    assert.equal((db.prepare(
      'SELECT COUNT(*) AS n FROM proposed_owner_wss_consumed_receipts'
    ).get() as {n:number}).n,2);
  }finally{db.close()}
});

test('a stale unredeemed WSS receipt does not survive physical device re-pair with a new signing key',async()=>{
  const db=setup();
  try{
    const i=issuer(db);
    const old=await i.issue(proof(a,keysA.privateKey,nonce()));
    const freshKey=generateKeyPairSync('ed25519');
    // Simulate authorized re-pair: same identity ID, new physical key.
    db.prepare('UPDATE proposed_owner_rpc_device_keys SET public_key_pem=? WHERE device_id=?')
      .run(pem(freshKey.publicKey),a);
    const newReader=stateReader(db,a,freshKey.publicKey);
    await assert.rejects(
      ProposedOwnerPublicWssEnrollmentLease.establishOnce(
        old,newReader,new ProposedOwnerWssSqliteReceiptJournal(db),
      ),/revision|mismatch|revoked|expired/);
    assert.equal((db.prepare(
      'SELECT COUNT(*) AS n FROM proposed_owner_wss_consumed_receipts'
    ).get() as {n:number}).n,0);
    const next=await i.issue(proof(a,freshKey.privateKey,nonce()));
    assert.ok(next.profileRevision>old.profileRevision);
    const lease=await ProposedOwnerPublicWssEnrollmentLease.establishOnce(
      next,newReader,new ProposedOwnerWssSqliteReceiptJournal(db),
    );
    await lease.requireCurrent();
  }finally{db.close()}
});

test('issuer public-key rotation rejects old signed receipt, new signer and fresh independent trust admit',async()=>{
  const db=setup();
  try{
    const first=await issuer(db).issue(proof(a,keysA.privateKey,nonce()));
    const rotatedOperator=generateKeyPairSync('ed25519');
    const rotated=stateReader(db,a,keysA.publicKey,account,
      rotatedOperator.publicKey,'operator-root-02');
    await assert.rejects(
      ProposedOwnerPublicWssEnrollmentLease.establishOnce(
        first,rotated,new ProposedOwnerWssSqliteReceiptJournal(db),
      ),/mismatch|signature/);
    const next=await issuer(db,rotatedOperator.privateKey,'operator-root-02')
      .issue(proof(a,keysA.privateKey,nonce()));
    const lease=await ProposedOwnerPublicWssEnrollmentLease.establishOnce(
      next,rotated,new ProposedOwnerWssSqliteReceiptJournal(db),
    );
    await lease.requireCurrent();
    assert.equal((db.prepare(
      'SELECT COUNT(*) AS n FROM proposed_owner_wss_consumed_receipts'
    ).get() as {n:number}).n,1);
  }finally{db.close()}
});

test('foreign owner signed receipt cannot reconnect under another owner even with valid operator signature',async()=>{
  const db=setup();
  try{
    const signedForA=await issuer(db).issue(proof(a,keysA.privateKey,nonce()));
    db.prepare('UPDATE proposed_owner_quota_devices SET owner_account_id=? WHERE device_id=?')
      .run(foreign,a);
    const otherReader=stateReader(db,a,keysA.publicKey,foreign);
    await assert.rejects(
      ProposedOwnerPublicWssEnrollmentLease.establishOnce(
        signedForA,otherReader,new ProposedOwnerWssSqliteReceiptJournal(db),
      ),/mismatch|revoked|owner/);
    await assert.rejects(
      issuer(db).issue(proof(a,keysA.privateKey,nonce())),
      /revoked/,
    );
    const ownReader=stateReader(db,a,keysA.publicKey);
    await assert.rejects(
      ProposedOwnerPublicWssEnrollmentLease.establishOnce(
        signedForA,ownReader,new ProposedOwnerWssSqliteReceiptJournal(db),
      ),/revoked|owner/);
    assert.equal((db.prepare(
      'SELECT COUNT(*) AS n FROM proposed_owner_wss_consumed_receipts'
    ).get() as {n:number}).n,0);
  }finally{db.close()}
});

test('revoke and restore original device key does not resurrect an unused signed receipt',async()=>{
  const db=setup();
  try{
    const old=await issuer(db).issue(proof(a,keysA.privateKey,nonce()));
    db.prepare('UPDATE proposed_owner_rpc_device_keys SET enabled=0 WHERE device_id=?')
      .run(a);
    await assert.rejects(
      ProposedOwnerPublicWssEnrollmentLease.establishOnce(old,
        stateReader(db,a,keysA.publicKey),
        new ProposedOwnerWssSqliteReceiptJournal(db),
      ),/revoked/);
    db.prepare('UPDATE proposed_owner_rpc_device_keys SET enabled=1 WHERE device_id=?')
      .run(a);
    await assert.rejects(
      ProposedOwnerPublicWssEnrollmentLease.establishOnce(old,
        stateReader(db,a,keysA.publicKey),
        new ProposedOwnerWssSqliteReceiptJournal(db),
      ),/mismatch|revision/);
    assert.equal((db.prepare(
      'SELECT COUNT(*) AS n FROM proposed_owner_wss_consumed_receipts'
    ).get() as {n:number}).n,0);
  }finally{db.close()}
});

test('owner pairing moves away then back; original old owner receipt stays revoked despite restored name',async()=>{
  const db=setup();
  try{
    const old=await issuer(db).issue(proof(a,keysA.privateKey,nonce()));
    db.prepare('UPDATE proposed_owner_quota_devices SET owner_account_id=? WHERE device_id=?')
      .run(foreign,a);
    db.prepare('UPDATE proposed_owner_quota_devices SET owner_account_id=? WHERE device_id=?')
      .run(account,a);
    const reader=stateReader(db,a,keysA.publicKey);
    await assert.rejects(
      ProposedOwnerPublicWssEnrollmentLease.establishOnce(old,reader,
        new ProposedOwnerWssSqliteReceiptJournal(db)),
      /revision|mismatch|revoked/);
    const fresh=await issuer(db).issue(proof(a,keysA.privateKey,nonce()));
    assert.ok(fresh.profileRevision>old.profileRevision);
    await ProposedOwnerPublicWssEnrollmentLease.establishOnce(fresh,reader,
      new ProposedOwnerWssSqliteReceiptJournal(db));
  }finally{db.close()}
});

test('replacing key row rather than updating it also advances profile revision',async()=>{
  const db=setup();
  try{
    const old=await issuer(db).issue(proof(a,keysA.privateKey,nonce()));
    const replacement=generateKeyPairSync('ed25519');
    db.prepare('INSERT OR REPLACE INTO proposed_owner_rpc_device_keys VALUES(?,?,?)')
      .run(a,pem(replacement.publicKey),1);
    await assert.rejects(
      ProposedOwnerPublicWssEnrollmentLease.establishOnce(
        old,stateReader(db,a,replacement.publicKey),
        new ProposedOwnerWssSqliteReceiptJournal(db)),
      /mismatch|revision/);
    const fresh=await issuer(db).issue(proof(a,replacement.privateKey,nonce()));
    assert.ok(fresh.profileRevision>old.profileRevision);
  }finally{db.close()}
});

test('legitimate foreign-owner signed receipt is rejected by the former owner but accepted by foreign owner',async()=>{
  const db=setup();
  try{
    db.prepare('UPDATE proposed_owner_quota_devices SET owner_account_id=? WHERE device_id=?')
      .run(foreign,a);
    const foreignReceipt=await issuer(db).issue(
      proof(a,keysA.privateKey,nonce(),foreignToken));
    await assert.rejects(
      ProposedOwnerPublicWssEnrollmentLease.establishOnce(
        foreignReceipt,stateReader(db,a,keysA.publicKey,account),
        new ProposedOwnerWssSqliteReceiptJournal(db)),
      /revoked|owner|mismatch/);
    assert.equal((db.prepare(
      'SELECT COUNT(*) AS n FROM proposed_owner_wss_consumed_receipts'
    ).get() as {n:number}).n,0);
    await ProposedOwnerPublicWssEnrollmentLease.establishOnce(
      foreignReceipt,stateReader(db,a,keysA.publicKey,foreign),
      new ProposedOwnerWssSqliteReceiptJournal(db));
    assert.equal((db.prepare(
      'SELECT COUNT(*) AS n FROM proposed_owner_wss_consumed_receipts'
    ).get() as {n:number}).n,1);
  }finally{db.close()}
});

test('SQLite INSERT OR REPLACE of existing device pairing cannot resurrect a stale same-owner receipt',async()=>{
  const db=setup();
  try{
    const old=await issuer(db).issue(proof(a,keysA.privateKey,nonce()));
    const revBefore=(db.prepare('SELECT revision FROM proposed_owner_wss_profile_revisions WHERE device_id=?')
      .get(a) as {revision:number}).revision;
    // A pairing migration may REPLACE instead of UPDATE. SQLite does NOT
    // execute the existing AFTER UPDATE device owner trigger for this path.
    db.prepare('INSERT OR REPLACE INTO proposed_owner_quota_devices VALUES(?,?,?,?)')
      .run(a,foreign,1,'full');
    db.prepare('INSERT OR REPLACE INTO proposed_owner_quota_devices VALUES(?,?,?,?)')
      .run(a,account,1,'full');
    const revAfter=(db.prepare('SELECT revision FROM proposed_owner_wss_profile_revisions WHERE device_id=?')
      .get(a) as {revision:number}).revision;
    assert.ok(revAfter>revBefore,'every device re-pair must advance trusted WSS revision');
    await assert.rejects(
      ProposedOwnerPublicWssEnrollmentLease.establishOnce(
        old,stateReader(db,a,keysA.publicKey),
        new ProposedOwnerWssSqliteReceiptJournal(db)),
      /revision|mismatch|revoked/);
    assert.equal((db.prepare(
      'SELECT COUNT(*) AS n FROM proposed_owner_wss_consumed_receipts'
    ).get() as {n:number}).n,0);
  }finally{db.close()}
});

test('device row DELETE then INSERT with same ID must not restore a stale signed receipt',async()=>{
  const db=setup();
  try{
    const old=await issuer(db).issue(proof(a,keysA.privateKey,nonce()));
    const revBefore=(db.prepare('SELECT revision FROM proposed_owner_wss_profile_revisions WHERE device_id=?')
      .get(a) as {revision:number}).revision;
    db.prepare('DELETE FROM proposed_owner_quota_devices WHERE device_id=?').run(a);
    db.prepare('INSERT INTO proposed_owner_quota_devices VALUES(?,?,?,?)')
      .run(a,account,1,'full');
    const revAfter=(db.prepare('SELECT revision FROM proposed_owner_wss_profile_revisions WHERE device_id=?')
      .get(a) as {revision:number}).revision;
    assert.ok(revAfter>revBefore,'deletion and recreated pairing must advance WSS revision');
    await assert.rejects(
      ProposedOwnerPublicWssEnrollmentLease.establishOnce(
        old,stateReader(db,a,keysA.publicKey),
        new ProposedOwnerWssSqliteReceiptJournal(db)),
      /revision|mismatch|revoked/);
  }finally{db.close()}
});

test('repaired device signing key epoch survives SQLite close/reopen and fences old receipt reconnect',async()=>{
  const folder=mkdtempSync(path.join(tmpdir(),'nexowire-13-pairing-replace-'));
  const dbPath=path.join(folder,'owner-staging.sqlite');
  let first:DatabaseSync|undefined;
  let second:DatabaseSync|undefined;
  try{
    first=setup(dbPath);
    const before=await issuer(first).issue(proof(a,keysA.privateKey,nonce()));
    const changed=generateKeyPairSync('ed25519');
    first.prepare('INSERT OR REPLACE INTO proposed_owner_rpc_device_keys VALUES(?,?,?)')
      .run(a,pem(changed.publicKey),1);
    const bumped=(first.prepare(
      'SELECT revision FROM proposed_owner_wss_profile_revisions WHERE device_id=?'
    ).get(a) as {revision:number}).revision;
    assert.ok(bumped>before.profileRevision);
    first.close();first=undefined;
    second=new DatabaseSync(dbPath);
    const persisted=(second.prepare(
      'SELECT revision FROM proposed_owner_wss_profile_revisions WHERE device_id=?'
    ).get(a) as {revision:number}).revision;
    assert.equal(persisted,bumped);
    await assert.rejects(
      ProposedOwnerPublicWssEnrollmentLease.establishOnce(
        before,stateReader(second,a,changed.publicKey),
        new ProposedOwnerWssSqliteReceiptJournal(second),
      ),/revision|mismatch/);
    assert.equal((second.prepare(
      'SELECT COUNT(*) AS n FROM proposed_owner_wss_consumed_receipts'
    ).get() as {n:number}).n,0);
    const fresh=await issuer(second).issue(proof(a,changed.privateKey,nonce()));
    await ProposedOwnerPublicWssEnrollmentLease.establishOnce(
      fresh,stateReader(second,a,changed.publicKey),
      new ProposedOwnerWssSqliteReceiptJournal(second),
    );
  }finally{
    if(first)first.close();
    if(second)second.close();
    rmSync(folder,{recursive:true,force:true});
  }
});
