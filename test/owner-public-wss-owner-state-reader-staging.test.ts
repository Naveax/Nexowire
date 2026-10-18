import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,sign}
  from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {ProposedOwnerWssEnrollmentIssuer,serializeOwnerWssDeviceProof}
  from '../src/product/owner-public-wss-device-issuer-proposal.js';
import {ProposedOwnerPublicWssEnrollmentLease}
  from '../src/product/owner-public-wss-enrollment-lease-proposal.js';
import {createOwnerWssSqliteTrustedStateReader}
  from '../src/product/owner-public-wss-owner-state-reader-proposal.js';

const now=1_800_000_000_000;
const accountId='test-revocation-account-001';
const deviceId='test-revocation-device-001';
const bearer='nwx_test_owner_reader_secret_only';
function setup(){
  const db=new DatabaseSync(':memory:');
  for(const f of [
    'scale-v2-owner-shared-quota-dev.sql',
    'scale-v2-owner-quota-rpc-dev.sql',
    'scale-v2-owner-wss-device-enrollment-dev.sql',
  ]){
    db.exec(readFileSync(path.join(process.cwd(),'test','fixtures',f),'utf8'));
  }
  const operatorKey=generateKeyPairSync('ed25519');
  const deviceKey=generateKeyPairSync('ed25519');
  const pem=(k:typeof operatorKey.publicKey)=>k.export({
    type:'spki',format:'pem',
  }).toString();
  db.prepare('INSERT INTO proposed_owner_quota_accounts VALUES(?,?,?,?,?)')
    .run(accountId,'free',null,1,8);
  db.prepare('INSERT INTO proposed_owner_quota_devices VALUES(?,?,?,?)')
    .run(deviceId,accountId,1,'safe');
  db.prepare('INSERT INTO proposed_owner_rpc_device_keys VALUES(?,?,1)')
    .run(deviceId,pem(deviceKey.publicKey));
  db.prepare('INSERT INTO proposed_owner_wss_profile_revisions VALUES(?,?,1)')
    .run(deviceId,5);
  const issuer=new ProposedOwnerWssEnrollmentIssuer(
    db,async token=>token===bearer?{accountId,sessionGeneration:8}:null,
    {
      operatorId:'revocation-operator',
      keyId:'revocation-operator-key-01',
      operatorPrivateKeyPem:operatorKey.privateKey.export({
        type:'pkcs8',format:'pem',
      }).toString(),
      publicWssProfile:{
        endpoint:'wss://edge.example.com/internal/owner-quota/v1/outbound',
        expectedHostname:'edge.example.com',caMode:'system',
        trustedSpkiSha256:['b'.repeat(64)],
      },validForMs:120_000,clock:()=>now,
    },
  );
  const reader=createOwnerWssSqliteTrustedStateReader(db,{
    operatorId:'revocation-operator',
    keyId:'revocation-operator-key-01',
    operatorPublicKeyPem:pem(operatorKey.publicKey),
    accountId,deviceId,
    deviceKeySpkiSha256:createHash('sha256').update(
      deviceKey.publicKey.export({type:'spki',format:'der'}),
    ).digest('hex'),nowMs:()=>now,
  });
  const request={
    bearerToken:bearer,deviceId,
    nonce:randomBytes(18).toString('base64url'),
    signedAtMs:now,deviceSignature:'',
  };
  request.deviceSignature=sign(null,serializeOwnerWssDeviceProof(request),
    deviceKey.privateKey).toString('base64url');
  return {db,issuer,reader,request};
}

test('issuer enrolls physical device key and trusted fresh SQLite reader admits',async()=>{
  const s=setup();
  try{
    const envelope=await s.issuer.issue(s.request);
    const lease=await ProposedOwnerPublicWssEnrollmentLease.establish(
      envelope,s.reader,
    );
    assert.equal(lease.profile.expectedHostname,'edge.example.com');
    await lease.requireCurrent();
  }finally{s.db.close()}
});

test('session revocation invalidates lease, even if the row is restored',async()=>{
  const s=setup();
  try{
    const env=await s.issuer.issue(s.request);
    const lease=await ProposedOwnerPublicWssEnrollmentLease.establish(
      env,s.reader,
    );
    s.db.exec('UPDATE proposed_owner_quota_accounts SET session_generation=9');
    await assert.rejects(lease.requireCurrent(),/revoked|unavailable/);
    s.db.exec('UPDATE proposed_owner_quota_accounts SET session_generation=8');
    await assert.rejects(lease.requireCurrent(),/invalidated/);
  }finally{s.db.close()}
});

test('live account/device/revision/key/owner revocation denies new and old grants',async()=>{
  const mutations=[
    'UPDATE proposed_owner_quota_accounts SET enabled=0',
    'UPDATE proposed_owner_quota_devices SET enabled=0',
    "UPDATE proposed_owner_quota_devices SET owner_account_id='another-account'",
    'UPDATE proposed_owner_wss_profile_revisions SET enabled=0',
    'UPDATE proposed_owner_wss_profile_revisions SET revision=6',
    'UPDATE proposed_owner_rpc_device_keys SET enabled=0',
  ];
  for(const sql of mutations){
    const s=setup();
    try{
      const env=await s.issuer.issue(s.request);
      const lease=await ProposedOwnerPublicWssEnrollmentLease.establish(
        env,s.reader,
      );
      s.db.exec(sql);
      await assert.rejects(lease.requireCurrent(),/revoked|unavailable/);
      await assert.rejects(
        ProposedOwnerPublicWssEnrollmentLease.establish(env,s.reader),
      );
    }finally{s.db.close()}
  }
});

test('rotated device public key cannot use previously signed WSS enrollment',async()=>{
  const s=setup();
  try{
    const env=await s.issuer.issue(s.request);
    const lease=await ProposedOwnerPublicWssEnrollmentLease.establish(
      env,s.reader,
    );
    const replacement=generateKeyPairSync('ed25519').publicKey.export({
      format:'pem',type:'spki',
    }).toString();
    s.db.prepare('UPDATE proposed_owner_rpc_device_keys SET public_key_pem=?')
      .run(replacement);
    await assert.rejects(lease.requireCurrent(),/revoked|unavailable/);
    await assert.rejects(
      ProposedOwnerPublicWssEnrollmentLease.establish(env,s.reader),
      /rotated/,
    );
  }finally{s.db.close()}
});

test('trusted owner clock rollback and missing device key fail closed',async()=>{
  const s=setup();
  try{
    const env=await s.issuer.issue(s.request);
    const lease=await ProposedOwnerPublicWssEnrollmentLease.establish(
      env,s.reader,
    );
    s.db.prepare('UPDATE proposed_owner_quota_account_clock SET last_seen_ms=?')
      .run(now+1);
    await assert.rejects(lease.requireCurrent(),/revoked|unavailable/);
    s.db.exec('DELETE FROM proposed_owner_rpc_device_keys');
    await assert.rejects(s.reader(),/revoked/);
  }finally{s.db.close()}
});
