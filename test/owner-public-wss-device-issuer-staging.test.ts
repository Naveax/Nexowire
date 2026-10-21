import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {
  ProposedOwnerWssEnrollmentIssuer,
  serializeOwnerWssDeviceProof,
  type DeviceOwnerWssEnrollmentRequest,
} from '../src/product/owner-public-wss-device-issuer-proposal.js';
import {signOwnerWssEnrollmentProof}
  from '../src/product/owner-public-wss-device-signer-proposal.js';
import {
  verifySignedOwnerPublicWssEnrollment,
  type TrustedOwnerPublicWssEnrollmentContext,
} from '../src/product/owner-public-wss-operator-enrollment-proposal.js';

const now=1_800_000_000_000;
const acct='account-verified-001';
const device='device-enrolled-001';
const operator='nexowire-operator';
const keyId='operator-key-01';
const bearer='nwx_mcp_very_long_test_bearer_for_owner';
const operatorKeys=generateKeyPairSync('ed25519');
const deviceKeys=generateKeyPairSync('ed25519');
const pem=(key:typeof operatorKeys.publicKey)=>
  key.export({type:'spki',format:'pem'}).toString();
const fixture=(name:string)=>readFileSync(
  path.join(process.cwd(),'test','fixtures',name),'utf8',
);
function setup(){
  const db=new DatabaseSync(':memory:');
  db.exec(fixture('scale-v2-owner-shared-quota-dev.sql'));
  db.exec(fixture('scale-v2-owner-quota-rpc-dev.sql'));
  db.exec(fixture('scale-v2-owner-wss-device-enrollment-dev.sql'));
  db.prepare('INSERT INTO proposed_owner_quota_accounts VALUES(?,?,?,?,?)')
    .run(acct,'free',null,1,7);
  db.prepare('INSERT INTO proposed_owner_quota_devices VALUES(?,?,?,?)')
    .run(device,acct,1,'full');
  db.prepare('INSERT INTO proposed_owner_rpc_device_keys VALUES(?,?,?)')
    .run(device,pem(deviceKeys.publicKey),1);
  db.prepare('INSERT INTO proposed_owner_wss_profile_revisions VALUES(?,?,?)')
    .run(device,5,1);
  const issuer=new ProposedOwnerWssEnrollmentIssuer(
    db,async token=>token===bearer
      ?{accountId:acct,sessionGeneration:7}:null,
    {
      operatorId:operator,keyId,
      operatorPrivateKeyPem:operatorKeys.privateKey.export({
        type:'pkcs8',format:'pem',
      }).toString(),
      publicWssProfile:{
        endpoint:'wss://edge.example.com/internal/owner-quota/v1/outbound',
        expectedHostname:'edge.example.com',
        trustedSpkiSha256:['a'.repeat(64)],caMode:'system',
      },
      validForMs:120_000,
      clock:()=>now,
    },
  );
  return {db,issuer};
}
function claim(overrides:Partial<DeviceOwnerWssEnrollmentRequest>={}):
  DeviceOwnerWssEnrollmentRequest{
  const result={
    bearerToken:bearer,
    deviceId:device,
    nonce:randomBytes(18).toString('base64url'),
    signedAtMs:now,
    deviceSignature:'',
    ...overrides,
  };
  result.deviceSignature=sign(
    null,serializeOwnerWssDeviceProof(result),deviceKeys.privateKey,
  ).toString('base64url');
  return result;
}
function verifyContext(revision=5):TrustedOwnerPublicWssEnrollmentContext{
  return {
    operatorId:operator,keyId,
    operatorPublicKeyPem:pem(operatorKeys.publicKey),
    accountId:acct,deviceId:device,
    activeSessionGeneration:7,
    minimumProfileRevision:revision,
    nowMs:now,
  };
}

test('device-signed fresh proof issues operator-signed owner WSS profile',async()=>{
  const {db,issuer}=setup();
  try{
    const req=claim();
    const enrolled=await issuer.issue(req);
    const validated=verifySignedOwnerPublicWssEnrollment(
      enrolled,verifyContext(),
    );
    assert.equal(validated.expectedHostname,'edge.example.com');
    assert.equal(enrolled.profileRevision,5);
    assert.equal(enrolled.sessionGeneration,7);
    assert.equal(enrolled.expiresAtMs-enrolled.issuedAtMs,120_000);
    assert.equal(JSON.stringify(enrolled).includes(bearer),false);
    assert.equal((db.prepare(
      'SELECT COUNT(*) AS n FROM proposed_owner_wss_enrollment_nonces'
    ).get() as {n:number}).n,1);
  }finally{db.close()}
});

test('proof nonce cannot issue a second enrollment for same device',async()=>{
  const {db,issuer}=setup();
  try{
    const req=claim();
    await issuer.issue(req);
    await assert.rejects(issuer.issue(req));
    assert.equal((db.prepare(
      'SELECT COUNT(*) AS n FROM proposed_owner_wss_enrollment_nonces'
    ).get() as {n:number}).n,1);
  }finally{db.close()}
});

test('account, device ownership, revoked key, session and profile deny issuance',async()=>{
  for(const statement of [
    'UPDATE proposed_owner_quota_accounts SET enabled=0',
    'UPDATE proposed_owner_quota_accounts SET session_generation=8',
    "UPDATE proposed_owner_quota_devices SET owner_account_id='foreign-owner'",
    'UPDATE proposed_owner_quota_devices SET enabled=0',
    'UPDATE proposed_owner_rpc_device_keys SET enabled=0',
    'UPDATE proposed_owner_wss_profile_revisions SET enabled=0',
  ]){
    const {db,issuer}=setup();
    try{
      db.exec(statement);
      await assert.rejects(issuer.issue(claim()),/revoked/);
    }finally{db.close()}
  }
});

test('wrong account token or wrong device proof fails closed',async()=>{
  const {db,issuer}=setup();
  try{
    const tokenInvalid=claim({bearerToken:'nwx_mcp_bogus_bearer_long_enough'});
    await assert.rejects(issuer.issue(tokenInvalid),/Unverified/);
    const bad=claim();
    bad.deviceSignature=sign(
      null,serializeOwnerWssDeviceProof(bad),
      generateKeyPairSync('ed25519').privateKey,
    ).toString('base64url');
    await assert.rejects(issuer.issue(bad),/possession/);
  }finally{db.close()}
});

test('expired, future, tampered, clock rollback proofs rejected',async()=>{
  const {db,issuer}=setup();
  try{
    await assert.rejects(issuer.issue(claim({signedAtMs:now-61_000})),/expired/);
    await assert.rejects(issuer.issue(claim({signedAtMs:now+61_000})),/expired/);
    const bad=claim();
    bad.nonce=randomBytes(18).toString('base64url');
    await assert.rejects(issuer.issue(bad),/possession/);
    db.prepare('INSERT INTO proposed_owner_quota_account_clock VALUES(?,?)')
      .run(acct,now+1);
    await assert.rejects(issuer.issue(claim()),/revoked/);
  }finally{db.close()}
});

test('increasing trusted revision prevents older signed enrollment reuse',async()=>{
  const {db,issuer}=setup();
  try{
    const old=await issuer.issue(claim());
    db.prepare('UPDATE proposed_owner_wss_profile_revisions SET revision=6')
      .run();
    const next=await issuer.issue(claim());
    assert.equal(next.profileRevision,6);
    assert.throws(()=>verifySignedOwnerPublicWssEnrollment(
      old,verifyContext(6),
    ),/mismatch/);
    verifySignedOwnerPublicWssEnrollment(next,verifyContext(6));
  }finally{db.close()}
});

test('rotating the device key rejects old possession proofs and accepts new key',async()=>{
  const {db,issuer}=setup();
  try{
    const oldProof=claim();
    const rotated=generateKeyPairSync('ed25519');
    db.prepare(
      'UPDATE proposed_owner_rpc_device_keys SET public_key_pem=? WHERE device_id=?'
    ).run(pem(rotated.publicKey),device);
    await assert.rejects(issuer.issue(oldProof),/possession/);
    const fresh=claim();
    fresh.deviceSignature=sign(
      null,serializeOwnerWssDeviceProof(fresh),rotated.privateKey,
    ).toString('base64url');
    const issued=await issuer.issue(fresh);
    verifySignedOwnerPublicWssEnrollment(issued,verifyContext());
    db.prepare(
      'UPDATE proposed_owner_rpc_device_keys SET enabled=0 WHERE device_id=?'
    ).run(device);
    const denied=claim();
    denied.deviceSignature=sign(
      null,serializeOwnerWssDeviceProof(denied),rotated.privateKey,
    ).toString('base64url');
    await assert.rejects(issuer.issue(denied),/revoked/);
  }finally{db.close()}
});

test('operator trust root or issuer identifier cannot be substituted',async()=>{
  const {db,issuer}=setup();
  try{
    const issued=await issuer.issue(claim());
    const untrusted=generateKeyPairSync('ed25519');
    assert.throws(()=>verifySignedOwnerPublicWssEnrollment(
      issued,{...verifyContext(),operatorPublicKeyPem:pem(untrusted.publicKey)},
    ),/signature/);
    assert.throws(()=>verifySignedOwnerPublicWssEnrollment(
      issued,{...verifyContext(),operatorId:'untrusted-operator'},
    ),/mismatch/);
    assert.throws(()=>verifySignedOwnerPublicWssEnrollment(
      {...issued,operatorId:'untrusted-operator'},verifyContext(),
    ),/mismatch/);
  }finally{db.close()}
});
test('external Ed25519 signing handle produces a proof the real staging issuer accepts',async()=>{
  const {db,issuer}=setup();
  try{
    const spkiSha256=createHash('sha256').update(deviceKeys.publicKey.export({
      type:'spki',format:'der',
    })).digest('hex');
    const unsigned=claim();
    const signedProof=await signOwnerWssEnrollmentProof(
      {
        bearerToken:unsigned.bearerToken,deviceId:unsigned.deviceId,
        nonce:unsigned.nonce,signedAtMs:unsigned.signedAtMs,
      },
      {
        deviceId:device,publicKeyPem:pem(deviceKeys.publicKey),
        async signProof(bytes){return sign(null,bytes,deviceKeys.privateKey)},
      },
      spkiSha256,
    );
    const enrolled=await issuer.issue(signedProof);
    const profile=verifySignedOwnerPublicWssEnrollment(
      enrolled,verifyContext(),
    );
    assert.equal(profile.expectedHostname,'edge.example.com');
    await assert.rejects(issuer.issue(signedProof));
  }finally{db.close()}
});
test('device PoP rejects alternate base64url spelling before nonce is consumed',async()=>{
  const {db,issuer}=setup();
  try{
    const good=claim();
    const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const end=alphabet.indexOf(good.deviceSignature.at(-1)!);
    const altered=good.deviceSignature.slice(0,-1)+alphabet[end^1];
    assert.notEqual(altered,good.deviceSignature);
    assert.deepEqual(Buffer.from(altered,'base64url'),
      Buffer.from(good.deviceSignature,'base64url'));
    await assert.rejects(issuer.issue({...good,deviceSignature:altered}),
      /signature encoding/);
    const nonceCount=(db.prepare(
      'SELECT COUNT(*) AS n FROM proposed_owner_wss_enrollment_nonces'
    ).get() as {n:number}).n;
    assert.equal(nonceCount,0);
  }finally{db.close()}
});
