import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,type StatementSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import type {D1DatabaseLike,D1PreparedStatementLike} from '../src/product/d1-control-plane-store.js';
import {
 coreBootstrapSigningBytes,verifyCoreBootstrapCandidate,
 D1CoreDelegationLedger,type CoreLocalBootstrap,
} from '../src/security/core-admin-delegation.js';

class Statement implements D1PreparedStatementLike {
 constructor(private stmt:StatementSync,private args:unknown[]=[]){}
 bind(...v:unknown[]){return new Statement(this.stmt,v)}
 async first<T>(){return (this.stmt.get(...this.args as Parameters<StatementSync['get']>)??null) as T|null}
 async all<T>(){return {success:true,results:this.stmt.all(...this.args as Parameters<StatementSync['all']>) as T[]}}
 async run<T>(){const r=this.stmt.run(...this.args as Parameters<StatementSync['run']>);return {success:true,meta:{changes:Number(r.changes)}}}
}
class Db implements D1DatabaseLike {
 constructor(readonly native:DatabaseSync){}
 prepare(s:string){return new Statement(this.native.prepare(s))}
 async batch(statements:D1PreparedStatementLike[]){
  this.native.exec('BEGIN IMMEDIATE');
  try{const result=[];for(const s of statements)result.push(await s.run());this.native.exec('COMMIT');return result}
  catch(e){this.native.exec('ROLLBACK');throw e}
 }
}
const keys=generateKeyPairSync('ed25519');
const enrolled='2026-10-21T13:00:00.000Z',hash='a'.repeat(64);
const publicHash=createHash('sha256').update(keys.publicKey.export({type:'spki',format:'der'})).digest('hex');
const request='11111111-1111-4111-8111-111111111111';
function transcript(patch:Partial<CoreLocalBootstrap>={}):CoreLocalBootstrap {
 const unsigned={
  kind:'nexowire.core.local-bootstrap.v1' as const,enrollmentId:request,
  deviceId:'naveax',ownerAccountId:'owner',credentialHash:hash,
  generation:1,brokerImageSha256:'b'.repeat(64),brokerVersion:'1.0.5',
  signerKeySha256:publicHash,localConsentEvidenceSha256:'c'.repeat(64),
  enrolledAt:enrolled,claimedAdminInstalled:true as const,
 };
 const merged={...unsigned,...patch};
 const {signature:_ignore,...body}=merged as CoreLocalBootstrap;
 return {...body,signature:sign(null,coreBootstrapSigningBytes(body),keys.privateKey).toString('base64url')};
}
function context(patch:Record<string,unknown>={}){
 return {
  localConsentIndependentlyVerified:true,
  elevatedTokenIndependentlyVerified:true,
  publisherAndSourceAclVerified:true,
  currentOwnerAndDevicePairingVerified:true,
  installerRollbackVerified:true,signingPublicKey:keys.publicKey,
  expectedDeviceId:'naveax',expectedOwnerAccountId:'owner',
  expectedCredentialHash:hash,expectedBrokerImageSha256:'b'.repeat(64),
  expectedBrokerVersion:'1.0.5',trustedNow:new Date('2026-10-21T13:00:15.000Z'),
  ...patch,
 };
}
function fixture(migrated=true) {
 const native=new DatabaseSync(':memory:');
 native.exec('PRAGMA foreign_keys=ON');
 native.exec(`CREATE TABLE devices(
 id TEXT PRIMARY KEY,owner_account_id TEXT NOT NULL,
 credential_hash TEXT NOT NULL,access_mode TEXT NOT NULL,
 platform TEXT NOT NULL,privilege_mode TEXT NOT NULL);
 INSERT INTO devices VALUES('naveax','owner','${hash}','full','win32','broker');
 CREATE TABLE device_maintenance_preferences (
 device_id TEXT PRIMARY KEY NOT NULL, owner_account_id TEXT NOT NULL,
 enabled INTEGER NOT NULL, updated_at TEXT NOT NULL);
 INSERT INTO device_maintenance_preferences VALUES('naveax','owner',1,'2026-10-21T12:59:00.000Z');`);
 if(migrated){
  const sql=readFileSync(path.join(process.cwd(),'cloudflare','migrations','0020_core_admin_delegations.sql'),'utf8');
  native.exec(sql);
 }
 return {native,ledger:new D1CoreDelegationLedger(new Db(native))};
}
const lookup={
 deviceId:'naveax',ownerAccountId:'owner',credentialHash:hash,
 brokerImageSha256:'b'.repeat(64),brokerVersion:'1.0.5',
};
test('signed bootstrap establishes a SOURCE candidate, never an effective high Windows token',()=>{
 const record=verifyCoreBootstrapCandidate(transcript(),context());
 assert.equal(record.enrollmentId,request);
 assert.equal(record.productionPrivilegeAttested,false);
 assert.equal(Object.isFrozen(record),true);
});

test('independent bootstrap consent/token/publisher/rollback/pairing are individually mandatory',()=>{
 for(const field of [
  'localConsentIndependentlyVerified','elevatedTokenIndependentlyVerified',
  'publisherAndSourceAclVerified','currentOwnerAndDevicePairingVerified',
  'installerRollbackVerified',
 ]){
  assert.throws(()=>verifyCoreBootstrapCandidate(transcript(),context({[field]:false})),
   /CORE_DELEGATION_NATIVE_BOOTSTRAP_UNKNOWN/,field);
 }
});

test('signature, signer, owner/device, credential, version, epoch and clock prevent reused bootstrap',()=>{
 for(const p of [
  {expectedDeviceId:'work-pc'},{expectedOwnerAccountId:'other'},
  {expectedCredentialHash:'d'.repeat(64)},
  {expectedBrokerVersion:'1.0.4'},
  {expectedBrokerImageSha256:'e'.repeat(64)},
 ]){
  assert.throws(()=>verifyCoreBootstrapCandidate(transcript(),context(p)),/CORE_DELEGATION_SCOPE_CHANGED/);
 }
 assert.throws(()=>verifyCoreBootstrapCandidate(transcript(),context({
  trustedNow:new Date('2026-10-21T13:02:00.000Z')})),/CORE_DELEGATION_CLOCK/);
 assert.throws(()=>verifyCoreBootstrapCandidate({...transcript(),brokerVersion:'1.0.4'},context()));
 assert.throws(()=>verifyCoreBootstrapCandidate({...transcript(),ownerAccountId:'other'},context()));
 assert.throws(()=>verifyCoreBootstrapCandidate({...transcript(),unknown:true} as unknown as CoreLocalBootstrap,context()));
 const wrong=generateKeyPairSync('ed25519');
 assert.throws(()=>verifyCoreBootstrapCandidate(transcript(),context({signingPublicKey:wrong.publicKey})));
});

test('D1 migration absent fails closed, does not grant by legacy CORE preference',async()=>{
 const f=fixture(false);
 try{
  const record=verifyCoreBootstrapCandidate(transcript(),context());
  await assert.rejects(f.ledger.enroll(record,0));
  await assert.rejects(f.ledger.currentCandidate(lookup));
 }finally{f.native.close()}
});

test('SQLite D1 signed owner+device durable CORE enrollment survives ledger recreation/reconnect',async()=>{
 const f=fixture();
 try{
  const record=verifyCoreBootstrapCandidate(transcript(),context());
  assert.equal(await f.ledger.enroll(record,0),true);
  const other=new D1CoreDelegationLedger(new Db(f.native));
  assert.equal((await other.currentCandidate(lookup))?.enrollmentId,request);
  assert.equal((await other.currentCandidate(lookup))?.productionPrivilegeAttested,false);
  assert.equal(await other.enroll(record,0),false);
  assert.equal(f.native.prepare('SELECT COUNT(*) n FROM core_admin_consumed_enrollments').get()?.n,1);
 }finally{f.native.close()}
});

test('revoke is durable and old signed transcript cannot resurrect even after new generation',async()=>{
 const f=fixture();
 try{
  const a=verifyCoreBootstrapCandidate(transcript(),context());
  assert.equal(await f.ledger.enroll(a,0),true);
  assert.equal(await f.ledger.revoke({
   deviceId:'naveax',ownerAccountId:'other',enrollmentId:request,
   generation:1,at:'2026-10-21T13:02:00.000Z',
  }),false);
  assert.equal(await f.ledger.revoke({
   deviceId:'naveax',ownerAccountId:'owner',enrollmentId:request,
   generation:1,at:'2026-10-21T13:02:00.000Z',
  }),true);
  assert.equal(await f.ledger.currentCandidate(lookup),null);
  assert.equal(await f.ledger.enroll(a,1),false);
  const replacement=verifyCoreBootstrapCandidate(
    transcript({
     enrollmentId:'22222222-2222-4222-8222-222222222222',
     generation:2,
    }),context());
  assert.equal(await f.ledger.enroll(replacement,1),true);
  assert.equal((await f.ledger.currentCandidate(lookup))?.generation,2);
  assert.equal(await f.ledger.enroll(a,1),false);
  assert.equal((await f.ledger.currentCandidate(lookup))?.enrollmentId,replacement.enrollmentId);
 }finally{f.native.close()}
});

test('CORE OFF permanently revokes signed enrollment, re-enabling preference does not revive it',async()=>{
 const f=fixture();
 try{
  const a=verifyCoreBootstrapCandidate(transcript(),context());
  assert.equal(await f.ledger.enroll(a,0),true);
  f.native.exec("UPDATE device_maintenance_preferences SET enabled=0,updated_at='2026-10-21T13:01:00.000Z' WHERE device_id='naveax'");
  assert.equal(await f.ledger.currentCandidate(lookup),null);
  f.native.exec("UPDATE device_maintenance_preferences SET enabled=1,updated_at='2026-10-21T13:01:10.000Z' WHERE device_id='naveax'");
  assert.equal(await f.ledger.currentCandidate(lookup),null);
  assert.equal(await f.ledger.enroll(a,1),false);
 }finally{f.native.close()}
});

test('re-pair, owner transfer, Broker replacement, downgrade or SAFE force fail-closed',async()=>{
 const f=fixture();
 try{
  const a=verifyCoreBootstrapCandidate(transcript(),context());
  assert.equal(await f.ledger.enroll(a,0),true);
  for(const patch of [
   {credentialHash:'d'.repeat(64)},{ownerAccountId:'different'},
   {brokerImageSha256:'e'.repeat(64)},{brokerVersion:'1.0.4'},
  ]){
   assert.equal(await f.ledger.currentCandidate({...lookup,...patch}),null);
  }
  for(const sql of [
   "UPDATE devices SET credential_hash='d' WHERE id='naveax'",
   "UPDATE devices SET owner_account_id='other' WHERE id='naveax'",
   "UPDATE devices SET access_mode='safe' WHERE id='naveax'",
   "UPDATE devices SET privilege_mode='direct' WHERE id='naveax'",
  ]){
   f.native.exec(sql);
   assert.equal(await f.ledger.currentCandidate(lookup),null);
   f.native.exec(`UPDATE devices SET credential_hash='${hash}',owner_account_id='owner',access_mode='full',privilege_mode='broker' WHERE id='naveax'`);
   // Restoring old telemetry or reconnect must NEVER resurrect a revoked grant.
   assert.equal(await f.ledger.currentCandidate(lookup),null);
  }
 }finally{f.native.close()}
});
