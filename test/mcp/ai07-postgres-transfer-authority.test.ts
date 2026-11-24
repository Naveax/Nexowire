import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {PostgresProtectedTransferAuthority,composeTransferDrainObserver,type IndependentTransferObservation} from '../../src/security/postgres-protected-transfer-authority.js';
import {finalTransferSigningBytes} from '../../src/agent/native-transfer-publisher.js';
import type {DispatchStorePool} from '../../src/agent/postgres-broker-dispatch-authority.js';
import type {LargeTransferBinding,LargeTransferIntent,LargeTransferFinalReceipt} from '../../src/mcp/durable-large-transfer.js';

const enabled=process.env.NEXOWIRE_PG_DISPATCH_INTEGRATION==='1';
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');

test('transfer authority rejects absent independent provenance before database access',async()=>{
  let connections=0;const authorityId=randomUUID();
  const a=new PostgresProtectedTransferAuthority({authorityId,pool:{async connect(){connections++;throw Error('unexpected');}},verifyProvenance:async()=>({verified:false,authorityId,validUntil:Date.now()+30000}),observeNativeIntent:async()=>undefined,readNativeReceipt:async()=>undefined});
  await assert.rejects(a.assertGrant({ownerId:randomUUID(),projectId:'fixture',sourceDeviceId:randomUUID(),targetDeviceId:randomUUID()}),/TRANSFER_PG_PROVENANCE_UNVERIFIED/);
  assert.equal(connections,0);
});

// Real PostgreSQL transactions, explicitly disposable DB only. Native
// observation and provenance are fixtures, not physical production evidence.
test('PostgreSQL protected transfer: immutable claim, epoch fence, recovery, cancellation and shared revoke',{skip:!enabled?'DISPOSABLE_POSTGRES_NOT_REQUESTED; production NOT_PROVEN':false,timeout:60000},async t=>{
  const port=Number(process.env.NEXOWIRE_PG_DISPATCH_TEST_PORT??5432);
  assert(Number.isInteger(port)&&port>0&&port<65536);
  const common={host:'127.0.0.1',port,database:'nexowire_dispatch_ci',password:'ci-only-not-a-production-credential',max:8,connectionTimeoutMillis:3000};
  const admin=new Pool({...common,user:'nexowire_dispatch_ci'});
  const service=new Pool({...common,user:'nexowire_transfer_runtime'});
  t.after(async()=>{await service.end();await admin.end();});
  await admin.query(await readFile(new URL('../../sql/core-broker-dispatch-authority.sql',import.meta.url),'utf8'));
  await admin.query(await readFile(new URL('../../sql/large-transfer-authority.sql',import.meta.url),'utf8'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nexowire_transfer_runtime') THEN CREATE ROLE nexowire_transfer_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD 'ci-only-not-a-production-credential'; END IF; END $$;");
  await admin.query("GRANT USAGE ON SCHEMA core_dispatch,transfer_authority TO nexowire_transfer_runtime; GRANT SELECT ON core_dispatch.authorities,core_dispatch.grants,transfer_authority.grants,transfer_authority.jobs,transfer_authority.claims TO nexowire_transfer_runtime; GRANT UPDATE(max_seen_ms) ON core_dispatch.authorities TO nexowire_transfer_runtime; GRANT INSERT ON transfer_authority.jobs,transfer_authority.claims TO nexowire_transfer_runtime; GRANT UPDATE(epoch,lease_hash,confirmed_offset,stage_created,pending_id,state,final_receipt,final_commit) ON transfer_authority.jobs TO nexowire_transfer_runtime; GRANT UPDATE(state) ON transfer_authority.claims TO nexowire_transfer_runtime;");
  const authorityId=randomUUID(),ownerId=randomUUID(),sourceDeviceId=randomUUID(),targetDeviceId=randomUUID(),projectId='fixture';
  const srcEpoch=randomUUID(),srcSession=randomUUID(),dstEpoch=randomUUID(),dstSession=randomUUID();
  const sourceRoot='C:\\ProgramData\\Nexowire\\source',targetRoot='C:\\ProgramData\\Nexowire\\target';
  const key=generateKeyPairSync('ed25519');
  await admin.query('INSERT INTO core_dispatch.authorities(authority_id,max_seen_ms) VALUES($1,$2)',[authorityId,Date.now()-1000]);
  for(const [id,epoch,session] of [[sourceDeviceId,srcEpoch,srcSession],[targetDeviceId,dstEpoch,dstSession]])await admin.query("INSERT INTO core_dispatch.grants(authority_id,device_id,owner_id,device_epoch,session_epoch,owner_epoch,generation,broker_id,state) VALUES($1,$2,$3,$4,$5,1,1,$6,'ACTIVE')",[authorityId,id,ownerId,epoch,session,randomUUID()]);
  await admin.query("INSERT INTO transfer_authority.grants(authority_id,owner_id,project_id,source_device_id,target_device_id,source_device_epoch,source_session_epoch,source_owner_epoch,source_generation,target_device_epoch,target_session_epoch,target_owner_epoch,target_generation,source_root,target_root,target_public_key_pem,state,expires_ms) VALUES($1,$2,$3,$4,$5,$6,$7,1,1,$8,$9,1,1,$10,$11,$12,'ACTIVE',$13)",[authorityId,ownerId,projectId,sourceDeviceId,targetDeviceId,srcEpoch,srcSession,dstEpoch,dstSession,sourceRoot,targetRoot,key.publicKey.export({type:'spki',format:'pem'}).toString(),Date.now()+600000]);
  let outcome:IndependentTransferObservation['state']|undefined;
  let receipt:LargeTransferFinalReceipt|undefined;
  const a=new PostgresProtectedTransferAuthority({authorityId,pool:service as DispatchStorePool,verifyProvenance:async()=>({verified:true,authorityId,validUntil:Date.now()+30000}),observeNativeIntent:async(b,p,c)=>outcome?{jobId:b.id,requestId:p.requestId,epoch:p.epoch,intentSha256:c.intentSha256,sealed:true,state:outcome,offset:p.offset,length:p.length,sha256:p.sha256}:undefined,readNativeReceipt:async()=>receipt});
  const binding=(name:string):LargeTransferBinding=>{const id=randomUUID(),targetPath=targetRoot+'\\'+name;return {id,ownerId,projectId,sourceDeviceId,targetDeviceId,sourcePath:sourceRoot+'\\input.bin',targetPath,stagePath:targetPath+'.nexowire-upload-'+id+'.part',size:3,sha256:sha('abc')};};
  const b=binding('output.bin'),l=await a.acquire(b,0);
  const p:LargeTransferIntent={kind:'write',requestId:randomUUID(),epoch:l.epoch,offset:0,length:3,sha256:b.sha256,dispatched:true};
  const results=await Promise.allSettled([a.claimNativeEffect(b,l,p),a.claimNativeEffect(b,l,p)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const c=results.find(r=>r.status==='fulfilled');assert(c&&c.status==='fulfilled');
  await a.settleNativeEffect(b,l,p,c.value,'unknown');
  await assert.rejects(a.acquire(b,l.epoch),/TRANSFER_PG_NATIVE_DRAIN_UNVERIFIED/);
  const drain=composeTransferDrainObserver({authorityId,pool:service as DispatchStorePool,verifyNativeDrain:async()=>true});
  assert.equal(await drain({ownerId,deviceId:targetDeviceId}),false);
  outcome='applied';const newer=await a.acquire(b,l.epoch);
  assert(newer.epoch>l.epoch);
  await assert.rejects(a.assertCurrent(b,l,0),/TRANSFER_PG_LEASE_FENCED/);
  await a.assertCurrent(b,newer,3);
  const pub:LargeTransferIntent={kind:'publish',requestId:randomUUID(),epoch:newer.epoch,offset:3,length:0,sha256:b.sha256,dispatched:true};
  const claim=await a.claimNativeEffect(b,newer,pub);
  await a.settleNativeEffect(b,newer,pub,claim,'completed');
  const unsigned={jobId:b.id,requestId:pub.requestId,epoch:pub.epoch,targetDeviceId:b.targetDeviceId,targetPath:b.targetPath,size:b.size,sha256:b.sha256};
  receipt={...unsigned,proof:sign(null,finalTransferSigningBytes(b,unsigned),key.privateKey).toString('base64url')};
  const commit=await a.commitRecoveredPublication(b,pub,receipt);
  assert.deepEqual(await a.recoverPublished(b,pub),{receipt,commit});
  await assert.rejects(a.claimNativeEffect(b,newer,pub));
  const second=binding('cancel.bin'),secondLease=await a.acquire(second,0);
  await a.cancelTransfer(second,secondLease);await a.cancelTransfer(second,secondLease);
  await assert.rejects(a.assertCurrent(second,secondLease,0),/TRANSFER_PG_JOB_FENCED/);
  assert.equal(await drain({ownerId,deviceId:targetDeviceId}),true);
  await admin.query("UPDATE core_dispatch.grants SET state='REVOKED',generation=2 WHERE authority_id=$1 AND device_id=$2",[authorityId,targetDeviceId]);
  await assert.rejects(a.assertGrant(b),/TRANSFER_PG_GRANT_REVOKED/);
});
