import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {PostgresProtectedTransferAuthority,type IndependentTransferObservation} from '../../src/security/postgres-protected-transfer-authority.js';
import {finalTransferSigningBytes} from '../../src/agent/native-transfer-publisher.js';
import type {DispatchStorePool} from '../../src/agent/postgres-broker-dispatch-authority.js';
import type {LargeTransferBinding,LargeTransferIntent,LargeTransferFinalReceipt} from '../../src/mcp/durable-large-transfer.js';

const requested=process.env.NEXOWIRE_PG_TRANSFER_RESTART_INTEGRATION==='1';
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const docker=promisify(execFile);

// Never stop an arbitrary database. Only the labelled service container of
// this disposable GitHub-hosted job, on its exact mapped loopback port.
test('PostgreSQL crash restart preserves original UNKNOWN claim, epoch and signed completion',
  {skip:!requested?'DISPOSABLE_POSTGRES_RESTART_NOT_REQUESTED':false,timeout:150000},async t=>{
  assert.equal(process.platform,'linux');
  assert.equal(process.env.GITHUB_ACTIONS,'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
  const runId=process.env.GITHUB_RUN_ID??'',container=process.env.NEXOWIRE_PG_RESTART_CONTAINER??'';
  assert.match(runId,/^\d+$/);assert.match(container,/^[a-f0-9]{64}$/);
  const port=Number(process.env.NEXOWIRE_PG_DISPATCH_TEST_PORT);
  assert(Number.isInteger(port)&&port>0&&port<65536);
  const call=async(args:string[])=>(await docker('docker',args,{timeout:15000,maxBuffer:16384})).stdout.trim();
  assert.equal(await call(['inspect','--format','{{index .Config.Labels "org.nexowire.ai07.restart-run"}}',container]),runId);
  assert.equal(await call(['inspect','--format','{{.Config.Image}}',container]),'postgres:18');
  assert((await call(['port',container,'5432/tcp'])).split('\n').some(line=>line.endsWith(':'+port)));
  const common={host:'127.0.0.1',port,database:'nexowire_dispatch_ci',password:'ci-only-not-a-production-credential',max:4,connectionTimeoutMillis:1000};
  const pools=new Set<Pool>();
  function connect(user:string){const pool=new Pool({...common,user});pools.add(pool);return pool;}
  async function close(pool:Pool){if(pools.delete(pool))await pool.end();}
  t.after(async()=>{await Promise.all([...pools].map(close));});
  let admin=connect('nexowire_dispatch_ci'),service=connect('nexowire_transfer_runtime');
  async function serverStart(){return String((await admin.query('SELECT pg_postmaster_start_time()::text AS started')).rows[0].started);}
  async function restart(){
    const before=await serverStart();
    await close(service);await close(admin);
    await call(['kill','--signal','KILL',container]);
    assert.equal(await call(['inspect','--format','{{.State.Running}}',container]),'false');
    const stopped=connect('nexowire_dispatch_ci');
    try{await assert.rejects(stopped.query('SELECT 1'));}finally{await close(stopped);}
    await call(['start',container]);
    admin=connect('nexowire_dispatch_ci');service=connect('nexowire_transfer_runtime');
    let after:string|undefined;
    const deadline=Date.now()+30000;
    while(Date.now()<deadline){
      try{after=await serverStart();break;}catch{await delay(250);}
    }
    assert(after,'PostgreSQL must be reachable after crash recovery');
    assert.notEqual(after,before,'a different real PostgreSQL postmaster must serve the second connection');
    assert.equal((await admin.query('SELECT pg_is_in_recovery() AS recovery')).rows[0].recovery,false);
    t.diagnostic('Real PostgreSQL postmaster changed: '+before+' -> '+after);
  }
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
  const authority=()=>new PostgresProtectedTransferAuthority({authorityId,pool:service as DispatchStorePool,verifyProvenance:async()=>({verified:true,authorityId,validUntil:Date.now()+30000}),observeNativeIntent:async(b,p,c)=>outcome?{jobId:b.id,requestId:p.requestId,epoch:p.epoch,intentSha256:c.intentSha256,sealed:true,state:outcome,offset:p.offset,length:p.length,sha256:p.sha256}:undefined,readNativeReceipt:async()=>receipt});
  const id=randomUUID(),targetPath=targetRoot+'\\restart.bin';
  const b:LargeTransferBinding={id,ownerId,projectId,sourceDeviceId,targetDeviceId,sourcePath:sourceRoot+'\\input.bin',targetPath,stagePath:targetPath+'.nexowire-upload-'+id+'.part',size:3,sha256:sha('abc')};
  let a=authority();
  const l=await a.acquire(b,0);
  const p:LargeTransferIntent={kind:'write',requestId:randomUUID(),epoch:l.epoch,offset:0,length:3,sha256:b.sha256,dispatched:true};
  const claim=await a.claimNativeEffect(b,l,p);
  await a.settleNativeEffect(b,l,p,claim,'unknown');
  await restart();a=authority();
  const persisted=(await admin.query('SELECT epoch,confirmed_offset,pending_id FROM transfer_authority.jobs WHERE id=$1',[id])).rows[0];
  assert.equal(Number(persisted.epoch),l.epoch);assert.equal(Number(persisted.confirmed_offset),0);assert.equal(persisted.pending_id,p.requestId);
  const original=(await admin.query('SELECT claim_id,state FROM transfer_authority.claims WHERE request_id=$1',[p.requestId])).rows[0];
  assert.equal(original.claim_id,claim.claimId);assert.equal(original.state,'UNKNOWN');
  await assert.rejects(a.claimNativeEffect(b,l,p),/TRANSFER_PG_MUTATION_UNRESOLVED/);
  await assert.rejects(a.acquire(b,l.epoch),/TRANSFER_PG_NATIVE_DRAIN_UNVERIFIED/);
  assert.equal(Number((await admin.query('SELECT epoch FROM transfer_authority.jobs WHERE id=$1',[id])).rows[0].epoch),l.epoch);
  outcome='applied';
  const next=await a.acquire(b,l.epoch);assert.equal(next.epoch,l.epoch+1);
  await assert.rejects(a.assertCurrent(b,l,0),/TRANSFER_PG_LEASE_FENCED/);
  await a.assertCurrent(b,next,3);
  const pub:LargeTransferIntent={kind:'publish',requestId:randomUUID(),epoch:next.epoch,offset:3,length:0,sha256:b.sha256,dispatched:true};
  const pubClaim=await a.claimNativeEffect(b,next,pub);
  await a.settleNativeEffect(b,next,pub,pubClaim,'unknown');
  const unsigned={jobId:id,requestId:pub.requestId,epoch:pub.epoch,targetDeviceId,targetPath,size:b.size,sha256:b.sha256};
  receipt={...unsigned,proof:sign(null,finalTransferSigningBytes(b,unsigned),key.privateKey).toString('base64url')};
  const committed=await a.commitRecoveredPublication(b,pub,receipt);
  await restart();a=authority();
  assert.deepEqual(await a.recoverPublished(b,pub),{receipt,commit:committed});
  await assert.rejects(a.claimNativeEffect(b,next,pub),/TRANSFER_PG_JOB_FENCED/);
  const ledger=(await admin.query('SELECT request_id,state FROM transfer_authority.claims WHERE job_id=$1 ORDER BY epoch',[id])).rows;
  assert.deepEqual(ledger,[{request_id:p.requestId,state:'APPLIED'},{request_id:pub.requestId,state:'APPLIED'}]);
  // Native observations/provenance in this fixture are synthetic. The DB,
  // transaction, process death, durable recovery and receipt are real.
});
