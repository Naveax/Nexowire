import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,randomBytes,verify} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:https';
import * as tls from 'node:tls';
import os from 'node:os';
import path from 'node:path';
import {Pool} from 'pg';
import {BrokerExternalDispatchFence,type BrokerDispatchRequest,type DispatchClaim,
  type ProtectedBrokerEvidence} from '../../src/agent/broker-external-dispatch-fence.js';
import {PostgresBrokerDispatchAuthority,type DispatchStorePool}
  from '../../src/agent/postgres-broker-dispatch-authority.js';
import {createProtectedPostgresDispatchPool} from '../../src/agent/protected-postgres-dispatch-pool.js';
import {createBrokerDispatchAuthorityHandler} from '../../src/agent/broker-dispatch-authority-handler.js';
import {HttpsBrokerDispatchAuthority} from '../../src/agent/https-broker-dispatch-authority.js';

// Only disposable CI PostgreSQL. Native identity, signer and independent
// provenance below are explicit fixtures, NEVER physical production evidence.
const enabled=process.env.NEXOWIRE_PG_DISPATCH_INTEGRATION==='1';
const restartPhase=process.env.NEXOWIRE_PG_DISPATCH_RESTART_PHASE;
const integration={skip:!enabled?'DISPOSABLE_POSTGRES_NOT_REQUESTED; production NOT_PROVEN':false,
  timeout:30000};
const keys=generateKeyPairSync('ed25519');
const privateKeyPem=keys.privateKey.export({format:'pem',type:'pkcs8'}).toString();
const publicKeyPem=keys.publicKey.export({format:'pem',type:'spki'}).toString();
const nonce=()=>'a'.repeat(64);
const denied=(code:string)=>(e:unknown)=>!!e&&typeof e==='object'&&'code' in e&&e.code===code;
function decoded(claim:DispatchClaim):Record<string,unknown>{
  const bytes=Buffer.from(claim.payload,'base64url');
  assert.equal(verify(null,bytes,keys.publicKey,Buffer.from(claim.signature,'base64url')),true);
  return JSON.parse(bytes.toString('utf8')) as Record<string,unknown>;
}
async function fixture(options:{permitMs?:number;drainTimeoutMs?:number}={}){
  assert.equal(enabled,true);
  const port=Number(process.env.NEXOWIRE_PG_DISPATCH_TEST_PORT??'5432');
  assert.ok(Number.isInteger(port)&&port>0&&port<65536);
  const pool=new Pool({host:'127.0.0.1',port,database:'nexowire_dispatch_ci',
    user:'nexowire_dispatch_ci',password:'ci-only-not-a-production-credential',max:8,
    connectionTimeoutMillis:3000,idleTimeoutMillis:1000});
  try{
    await pool.query(await readFile(new URL('../../sql/core-broker-dispatch-authority.sql',import.meta.url),'utf8'));
    await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nexowire_dispatch_runtime') THEN "+
      "CREATE ROLE nexowire_dispatch_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION "+
      "NOBYPASSRLS PASSWORD 'ci-only-not-a-production-credential'; END IF; END $$;");
    await pool.query('GRANT USAGE ON SCHEMA core_dispatch TO nexowire_dispatch_runtime; '+
      'GRANT SELECT ON core_dispatch.authorities,core_dispatch.grants,core_dispatch.claims TO nexowire_dispatch_runtime; '+
      'GRANT UPDATE(sequence,max_seen_ms) ON core_dispatch.authorities TO nexowire_dispatch_runtime; '+
      'GRANT UPDATE(state,generation,core_enabled,root_expires_ms) ON core_dispatch.grants TO nexowire_dispatch_runtime; '+
      'GRANT INSERT ON core_dispatch.claims TO nexowire_dispatch_runtime; '+
      'GRANT UPDATE(state,commit_nonce,commit_expires_ms) ON core_dispatch.claims TO nexowire_dispatch_runtime;');
  }catch(error){await pool.end();throw error;}
  const ids={authorityId:randomUUID(),ownerId:randomUUID(),deviceId:randomUUID(),
    deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),brokerId:randomUUID()};
  await pool.query('INSERT INTO core_dispatch.authorities(authority_id,max_seen_ms) VALUES($1,$2)',
    [ids.authorityId,Date.now()-1000]);
  await pool.query('INSERT INTO core_dispatch.grants '+
    '(authority_id,device_id,owner_id,device_epoch,session_epoch,owner_epoch,generation,broker_id,state,core_enabled) '+
    "VALUES($1,$2,$3,$4,$5,4,7,$6,'ACTIVE',true)",
    [ids.authorityId,ids.deviceId,ids.ownerId,ids.deviceEpoch,ids.sessionEpoch,ids.brokerId]);
  const broker:ProtectedBrokerEvidence={verified:true,brokerId:ids.brokerId,ownerEpoch:4,
    grantGeneration:7,highIntegrityToken:true,signedProtectedImage:true,protectedParentAndImports:true};
  let high=true,provenance=true,nativeDrain=true;
  const servicePool=new Pool({host:'127.0.0.1',port,database:'nexowire_dispatch_ci',
    user:'nexowire_dispatch_runtime',password:'ci-only-not-a-production-credential',max:8,
    connectionTimeoutMillis:3000,idleTimeoutMillis:1000});
  const config:ConstructorParameters<typeof PostgresBrokerDispatchAuthority>[0]={
    pool:servicePool as DispatchStorePool,authorityId:ids.authorityId,privateKeyPem,
    verifyProvenance:async()=>({verified:provenance,authorityId:ids.authorityId,validUntil:Date.now()+30000}),
    readProtectedBroker:async()=>high?{...broker}:undefined,
    verifyOwnerRevocation:async()=>true,verifyNativeDrain:async()=>nativeDrain,...options};
  const create=(override:Partial<typeof config>={})=>new PostgresBrokerDispatchAuthority({...config,...override});
  const request=():BrokerDispatchRequest=>({requestId:randomUUID(),fingerprint:'c'.repeat(64),
    capability:'windows.service.control',scope:{ownerId:ids.ownerId,deviceId:ids.deviceId,
      deviceEpoch:ids.deviceEpoch,sessionEpoch:ids.sessionEpoch,ownerEpoch:4,
      expectedGeneration:7,requiredPrivilege:'CORE'}});
  const revoke=()=>({deviceId:ids.deviceId,ownerId:ids.ownerId,deviceEpoch:ids.deviceEpoch,
    sessionEpoch:ids.sessionEpoch,expectedGeneration:7,signedOwnerApproval:'EXPLICIT_TEST_FIXTURE_NOT_OPERATOR_PROOF'.repeat(2)});
  return {pool,servicePool,ids,broker,config,create,request,revoke,authority:create(),
    setHigh:(v:boolean)=>{high=v},setProvenance:(v:boolean)=>{provenance=v},
    setNativeDrain:(v:boolean)=>{nativeDrain=v},close:async()=>{await servicePool.end();await pool.end();}};
}

async function credentialFixture(){
 const f=await fixture({permitMs:5000});
 try{
  await f.pool.query(await readFile(new URL('../../sql/core-broker-dispatch-credentials.sql',import.meta.url),'utf8'));
  await f.pool.query(await readFile(new URL('../../sql/core-broker-dispatch-credential-fence.sql',import.meta.url),'utf8'));
  await f.pool.query('GRANT SELECT, INSERT ON core_dispatch.claim_credentials TO nexowire_dispatch_runtime; GRANT EXECUTE ON FUNCTION core_dispatch.lock_active_broker_credential(uuid,text,text,uuid,uuid,uuid,uuid,uuid) TO nexowire_dispatch_runtime;');
  const issue=async()=>{
   const c={credentialSha256:randomBytes(32).toString('hex'),certificateSha256:randomBytes(32).toString('hex')};
   await f.pool.query("INSERT INTO core_dispatch.broker_credentials(authority_id,credential_sha256,certificate_sha256,broker_id,owner_id,device_id,installation_id,device_epoch,session_epoch,state,not_before_ms,expires_at_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'ACTIVE',$10,$11)",[f.ids.authorityId,c.credentialSha256,c.certificateSha256,f.ids.brokerId,f.ids.ownerId,f.ids.deviceId,randomUUID(),f.ids.deviceEpoch,f.ids.sessionEpoch,Date.now()-1000,Date.now()+60000]);
   return c;
  };
  return {...f,issue,secured:f.create({requireCredentialFence:true})};
 }catch(e){await f.close();throw e;}
}
const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
async function blocked(f:Awaited<ReturnType<typeof credentialFixture>>,waitingPid:number,holderPid:number){
 const deadline=Date.now()+1500;
 do{
  const row=(await f.pool.query('SELECT $2::integer=ANY(pg_blocking_pids($1::integer)) AS blocked',[waitingPid,holderPid])).rows[0];
  if(row?.blocked===true)return;
  await delay(10);
 }while(Date.now()<deadline);
 assert.fail('actual PostgreSQL lock dependency not observed');
}
function gate(){let release!:()=>void;const promise=new Promise<void>(r=>{release=r});return {promise,release};}
function observeConnection(f:Awaited<ReturnType<typeof credentialFixture>>,afterLock?:()=>Promise<void>){
 const connected=gate();let backendPid=0;
 const pool:DispatchStorePool={async connect(){
  const client=await f.servicePool.connect();
  try{backendPid=Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);connected.release();}
  catch(e){client.release(true);throw e;}
  return {async query(sql,values=[]){
   const result=await client.query(sql,values);
   if(afterLock&&sql.startsWith('SELECT core_dispatch.lock_active_broker_credential')&&result.rows[0]?.active===true)await afterLock();
   return {rows:result.rows as Record<string,unknown>[]};
  },release(destroy=false){client.release(destroy)}};
 }};
 return {pool,connected:connected.promise,pid:()=>backendPid};
}
test('credential revocation owns row first: commit waits on observed database lock and leaves reservation terminal',integration,async()=>{
 const f=await credentialFixture();const operator=await f.pool.connect();
 try{
  const credential=await f.issue(),req=f.request();
  const reservation=decoded(await f.secured.beginIfCurrent(req,f.broker,nonce(),credential));
  const id=String(reservation.dispatchId);
  await operator.query('BEGIN');
  const pid=Number((await operator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  await operator.query("UPDATE core_dispatch.broker_credentials SET state='REVOKED' WHERE authority_id=$1 AND credential_sha256=$2",[f.ids.authorityId,credential.credentialSha256]);
  const watch=observeConnection(f);
  const pending=f.create({requireCredentialFence:true,pool:watch.pool}).commitIfCurrent(req,f.broker,id,'b'.repeat(64),credential);
  const checked=assert.rejects(pending,denied('DISPATCH_STORE_CREDENTIAL_REVOKED_OR_STALE'));
  void checked.catch(()=>{});
  try{await Promise.race([watch.connected,pending.then(()=>{throw Error('commit returned before lock')})]);await blocked(f,watch.pid(),pid);}
  finally{await operator.query('COMMIT');await checked;}
  const row=(await f.pool.query('SELECT state,commit_nonce FROM core_dispatch.claims WHERE request_id=$1',[req.requestId])).rows[0];
  assert.equal(row.state,'RESERVED');assert.equal(row.commit_nonce,null);
  const replacement=await f.issue();
  await assert.rejects(f.secured.commitIfCurrent(req,f.broker,id,'c'.repeat(64),replacement),denied('DISPATCH_STORE_CREDENTIAL_RESERVATION_MISMATCH'));
  await f.secured.release({request:req,dispatchId:id,brokerId:f.ids.brokerId});
  await assert.rejects(f.secured.beginIfCurrent(req,f.broker,nonce(),replacement),denied('DISPATCH_STORE_REQUEST_REPLAY'));
 }finally{await operator.query('ROLLBACK').catch(()=>{});operator.release();await f.close();}
});
test('commit owns row first: actual revoke waits until committed receipt, then no fresh admission or replay',integration,async()=>{
 const f=await credentialFixture();const operator=await f.pool.connect();
 try{
  const credential=await f.issue(),req=f.request();
  const reserved=decoded(await f.secured.beginIfCurrent(req,f.broker,nonce(),credential));
  const id=String(reserved.dispatchId),locked=gate(),proceed=gate();
  const watch=observeConnection(f,async()=>{locked.release();await proceed.promise;});
  const pending=f.create({requireCredentialFence:true,pool:watch.pool}).commitIfCurrent(req,f.broker,id,'b'.repeat(64),credential);
  void pending.catch(()=>{});
  let revoke:Promise<unknown>|undefined;
  try{
   await Promise.race([locked.promise,pending.then(()=>{throw Error('commit lock hook not reached')})]);
   const pid=Number((await operator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
   revoke=operator.query("UPDATE core_dispatch.broker_credentials SET state='REVOKED' WHERE authority_id=$1 AND credential_sha256=$2",[f.ids.authorityId,credential.credentialSha256]);
   void revoke.catch(()=>{});
   await blocked(f,pid,watch.pid());
  }finally{proceed.release();if(revoke)await revoke;}
  const committed=decoded(await pending);
  assert.equal(committed.kind,'broker_dispatch_commit_v1');assert.equal(committed.dispatchId,id);
  assert.equal((await f.pool.query('SELECT state FROM core_dispatch.claims WHERE request_id=$1',[req.requestId])).rows[0].state,'COMMITTED');
  await assert.rejects(f.secured.beginIfCurrent(f.request(),f.broker,nonce(),credential),denied('DISPATCH_STORE_CREDENTIAL_REVOKED_OR_STALE'));
  await assert.rejects(f.secured.commitIfCurrent(req,f.broker,id,'c'.repeat(64),credential),denied('DISPATCH_STORE_COMMIT_REPLAY_OR_SCOPE'));
  const row=(await f.pool.query('SELECT credential_sha256,certificate_sha256 FROM core_dispatch.claim_credentials WHERE request_id=$1',[req.requestId])).rows[0];
  assert.deepEqual(row,{credential_sha256:credential.credentialSha256,certificate_sha256:credential.certificateSha256});
  await assert.rejects(f.pool.query('DELETE FROM core_dispatch.claim_credentials WHERE request_id=$1',[req.requestId]),/DISPATCH_CLAIM_CREDENTIAL_HISTORY_IMMUTABLE/);
  await f.secured.release({request:req,dispatchId:id,brokerId:f.ids.brokerId});
  assert.equal((await f.pool.query('SELECT state FROM core_dispatch.claims WHERE request_id=$1',[req.requestId])).rows[0].state,'RELEASED');
 }finally{operator.release();await f.close();}
});
test('credential fence refuses runtime UPDATE permission and wrong certificate without creating claim',integration,async()=>{
 const f=await credentialFixture();
 try{
  const c=await f.issue(),req=f.request();
  await assert.rejects(f.secured.beginIfCurrent(req,f.broker,nonce(),{...c,certificateSha256:'f'.repeat(64)}),denied('DISPATCH_STORE_CREDENTIAL_REVOKED_OR_STALE'));
  await f.pool.query('GRANT UPDATE(state) ON core_dispatch.broker_credentials TO nexowire_dispatch_runtime');
  try{await assert.rejects(f.secured.beginIfCurrent(req,f.broker,nonce(),c),denied('DISPATCH_STORE_CREDENTIAL_ROLE_OVERPRIVILEGED'));}
  finally{await f.pool.query('REVOKE UPDATE(state) ON core_dispatch.broker_credentials FROM nexowire_dispatch_runtime');}
  assert.equal((await f.pool.query('SELECT COUNT(*) AS n FROM core_dispatch.claims WHERE request_id=$1',[req.requestId])).rows[0].n,'0');
  assert.equal(decoded(await f.secured.beginIfCurrent(req,f.broker,nonce(),c)).kind,'broker_dispatch_permit_v1');
 }finally{await f.close();}
});
