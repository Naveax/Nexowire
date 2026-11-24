import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {PostgresDispatchCredentialStore} from '../../src/agent/postgres-dispatch-credential-store.js';
import type {DispatchStorePool} from '../../src/agent/postgres-broker-dispatch-authority.js';
import type {ProtectedDispatchCredentialRecord} from '../../src/agent/protected-broker-dispatch-service.js';

const enabled=process.env.NEXOWIRE_PG_DISPATCH_INTEGRATION==='1';
const digest=()=>randomBytes(32).toString('hex');

// Real disposable PostgreSQL and actual least-privilege reader, but the
// independent provenance and Native installation observation are fixtures.
// This is not production credential admission or atomic dispatch proof.
test('real disposable PostgreSQL: credential reader permissions, history, rotation and native binding recheck',
 {skip:!enabled?'DISPOSABLE_POSTGRES_NOT_REQUESTED; production NOT_PROVEN':false,timeout:90000},async t=>{
 const port=Number(process.env.NEXOWIRE_PG_DISPATCH_TEST_PORT??5432);
 assert(Number.isInteger(port)&&port>0&&port<65536);
 const common={host:'127.0.0.1',port,database:'nexowire_dispatch_ci',password:'ci-only-not-a-production-credential',max:4,connectionTimeoutMillis:3000};
 const admin=new Pool({...common,user:'nexowire_dispatch_ci'});
 const readerRole='nx_ai08_reader_'+randomBytes(8).toString('hex');
 assert.match(readerRole,/^[a-z0-9_]+$/);
 const reader=new Pool({...common,user:readerRole});
 t.after(async()=>{await reader.end();await admin.end();});
 await admin.query(await readFile(new URL('../../sql/core-broker-dispatch-authority.sql',import.meta.url),'utf8'));
 await admin.query(await readFile(new URL('../../sql/core-broker-dispatch-credentials.sql',import.meta.url),'utf8'));
 await admin.query("CREATE ROLE "+readerRole+" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD 'ci-only-not-a-production-credential'");
 await admin.query('GRANT USAGE ON SCHEMA core_dispatch TO '+readerRole);
 await admin.query('GRANT SELECT ON core_dispatch.broker_credentials,core_dispatch.grants TO '+readerRole);
 const authorityId=randomUUID(),deviceId=randomUUID(),ownerId=randomUUID(),deviceEpoch=randomUUID(),sessionEpoch=randomUUID(),brokerId=randomUUID(),installationId=randomUUID();
 const now=Date.now();
 await admin.query('INSERT INTO core_dispatch.authorities(authority_id,max_seen_ms) VALUES($1,$2)',[authorityId,now-1000]);
 await admin.query("INSERT INTO core_dispatch.grants(authority_id,device_id,owner_id,device_epoch,session_epoch,owner_epoch,generation,broker_id,state) VALUES($1,$2,$3,$4,$5,1,1,$6,'ACTIVE')",[authorityId,deviceId,ownerId,deviceEpoch,sessionEpoch,brokerId]);
 const add=async(overrides:Partial<ProtectedDispatchCredentialRecord>={})=>{
  const r:ProtectedDispatchCredentialRecord={credentialSha256:digest(),certificateSha256:digest(),brokerId,ownerId,deviceId,installationId,deviceEpoch,sessionEpoch,state:'ACTIVE',notBeforeMs:now-1000,expiresAtMs:now+600000,...overrides};
  await admin.query('INSERT INTO core_dispatch.broker_credentials(authority_id,credential_sha256,certificate_sha256,broker_id,owner_id,device_id,installation_id,device_epoch,session_epoch,state,not_before_ms,expires_at_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[authorityId,r.credentialSha256,r.certificateSha256,r.brokerId,r.ownerId,r.deviceId,r.installationId,r.deviceEpoch,r.sessionEpoch,r.state,r.notBeforeMs,r.expiresAtMs]);
  return r;
 };
 let nativeCheck=async(_r:ProtectedDispatchCredentialRecord,_signal:AbortSignal)=>true;
 const make=(pool:Pool=reader)=>new PostgresDispatchCredentialStore({
  pool:pool as DispatchStorePool,authorityId,
  verifyProvenance:async()=>({verified:true,authorityId,validUntil:Date.now()+30000}),
  verifyInstallationBinding:(r,signal)=>nativeCheck(r,signal)
 });
 const store=make();
 const active=await add();
 await t.test('actual reader and exact active digest; database time excludes expired and not-yet-valid records',async()=>{
  await store.assertReady();
  const actual=await store.lookup(active.credentialSha256);
  assert.deepEqual(actual,active);assert(Object.isFrozen(actual));
  assert.equal(await store.lookup(digest()),undefined);
  const expired=await add({notBeforeMs:now-100000,expiresAtMs:now-5000});
  const future=await add({notBeforeMs:now+120000,expiresAtMs:now+180000});
  assert.equal(await store.lookup(expired.credentialSha256),undefined);
  assert.equal(await store.lookup(future.credentialSha256),undefined);
  const mismatch=await add({sessionEpoch:randomUUID()});
  assert.equal(await store.lookup(mismatch.credentialSha256),undefined);
  assert.equal(await store.verifyLiveBinding(active),true);
 });
 await t.test('superuser and even column-level mutation grants are denied',async()=>{
  await assert.rejects(make(admin).assertReady(),/DISPATCH_CREDENTIAL_ROLE_UNVERIFIED/);
  await admin.query('GRANT UPDATE(state) ON core_dispatch.broker_credentials TO '+readerRole);
  try{
   await assert.rejects(store.assertReady(),/DISPATCH_CREDENTIAL_ROLE_UNVERIFIED/);
   assert.equal(await store.lookup(active.credentialSha256),undefined);
  }finally{await admin.query('REVOKE UPDATE(state) ON core_dispatch.broker_credentials FROM '+readerRole);}
  await store.assertReady();
  await assert.rejects(reader.query("UPDATE core_dispatch.broker_credentials SET state='REVOKED' WHERE authority_id=$1",[authorityId]),{code:'42501'});
 });
 await t.test('independently observed revocation during native readback denies stale credential; new digest rotation is separate',async()=>{
  const old=await add(),fresh=await add();
  nativeCheck=async(r,signal)=>{
   assert.equal(r.credentialSha256,old.credentialSha256);assert.equal(signal.aborted,false);
   await admin.query("UPDATE core_dispatch.broker_credentials SET state='REVOKED' WHERE authority_id=$1 AND credential_sha256=$2",[authorityId,old.credentialSha256]);
   return true;
  };
  try{assert.equal(await store.verifyLiveBinding(old),false);}
  finally{nativeCheck=async()=>true;}
  assert.equal(await store.lookup(old.credentialSha256),undefined);
  assert.deepEqual(await store.lookup(fresh.credentialSha256),fresh);
  await assert.rejects(admin.query("UPDATE core_dispatch.broker_credentials SET state='ACTIVE' WHERE authority_id=$1 AND credential_sha256=$2",[authorityId,old.credentialSha256]),/DISPATCH_CREDENTIAL_HISTORY_REWRITE_DENIED/);
  await assert.rejects(admin.query("DELETE FROM core_dispatch.broker_credentials WHERE authority_id=$1 AND credential_sha256=$2",[authorityId,old.credentialSha256]),/DISPATCH_CREDENTIAL_HISTORY_DELETE_DENIED/);
  await assert.rejects(admin.query("UPDATE core_dispatch.broker_credentials SET installation_id=$3 WHERE authority_id=$1 AND credential_sha256=$2",[authorityId,fresh.credentialSha256,randomUUID()]),/DISPATCH_CREDENTIAL_HISTORY_REWRITE_DENIED/);
 });
 await t.test('grant identity replacement invalidates old bound credentials',async()=>{
  assert.deepEqual(await store.lookup(active.credentialSha256),active);
  await admin.query('UPDATE core_dispatch.grants SET session_epoch=$3,generation=2 WHERE authority_id=$1 AND device_id=$2',[authorityId,deviceId,randomUUID()]);
  assert.equal(await store.lookup(active.credentialSha256),undefined);
  assert.equal(await store.verifyLiveBinding(active),false);
 });
});
