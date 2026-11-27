import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign,X509Certificate} from 'node:crypto';
import {createServer} from 'node:https';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {createHelperSelectionTlsFixture} from '../ai05/helper-selection-tls-fixture.js';
import {ProtectedRecoveryWitnessReadback} from '../../src/security/recovery-provider-readback.js';
import {PostgresProtectedTransferAuthority,composeTransferDrainObserver,type IndependentTransferObservation} from '../../src/security/postgres-protected-transfer-authority.js';
import type {DispatchStorePool} from '../../src/agent/postgres-broker-dispatch-authority.js';
import type {LargeTransferBinding,LargeTransferIntent} from '../../src/mcp/durable-large-transfer.js';

const enabled=process.env.NX07_V3_TRANSFER_PG_FIXTURE==='1';
const uid=randomUUID,sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const hex=(v:string)=>v.repeat(64);
const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v!==null&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,canonical(x)])):v;
const json=(v:unknown)=>JSON.stringify(canonical(v));
type WitnessState='UNANCHORED'|'PENDING'|'FROZEN'|'COMMITTED';
const DOMAIN='nexowire.lifecycle.witness.readback.v1';

test('V3 actual transfer service: signed admission, terminal evidence and two real PG lock orders',
 {skip:!enabled?'DISPOSABLE_V3_PG_NOT_REQUESTED':false,timeout:120000},async t=>{
  assert.equal(process.platform,'linux');
  assert.equal(process.env.GITHUB_ACTIONS,'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
  const port=Number(process.env.NX07_V3_TRANSFER_PG_PORT);
  assert(Number.isInteger(port)&&port>0&&port<65536);
  const common={host:'127.0.0.1',port,database:'nx07_v3_ci',password:'fixture-only-not-production',max:4,connectionTimeoutMillis:2000,statement_timeout:6000};
  const admin=new Pool({...common,user:'nx07_v3_ci',application_name:'nx07_admin'});
  const service=new Pool({...common,user:'nx07_runtime',application_name:'nx07_writer'});
  const consume=new Pool({...common,user:'nx07_consume',application_name:'nx07_consume'});
  const tls=createHelperSelectionTlsFixture(),keys=generateKeyPairSync('ed25519'),ack=generateKeyPairSync('ed25519');
  const snapshots=new Map<string,Record<string,unknown>>();
  let requests=0,hold:undefined|{authorityId:string;entered:()=>void;resume:Promise<void>},flip:undefined|string;
  const server=createServer({key:tls.server.key,cert:tls.server.cert,ca:tls.ca,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3',maxVersion:'TLSv1.3'},(req,res)=>{
    const peer=req.socket as import('node:tls').TLSSocket;
    if(!peer.authorized||peer.getPeerCertificate().fingerprint256!==new X509Certificate(tls.runtime.cert).fingerprint256||req.method!=='POST'||req.url!=='/v1/lifecycle/readback'){res.writeHead(403);res.end();return;}
    const chunks:Buffer[]=[];let bytes=0;
    req.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>32768)req.destroy();else chunks.push(b);});
    req.on('end',()=>{void (async()=>{
      try{
        const raw=Buffer.concat(chunks),r=JSON.parse(raw.toString('utf8'));
        assert.equal(r.domain,DOMAIN);assert.equal(r.action,'READBACK');assert.match(r.nonce,/^[a-f0-9]{64}$/);
        const s=snapshots.get(r.authorityId);assert(s);assert.equal(s.storeId,r.storeId);
        requests++;
        if(hold&&hold.authorityId===r.authorityId){const h=hold;hold=undefined;h.entered();await h.resume;}
        const now=Date.now(),payload=Buffer.from(json({domain:DOMAIN,nonce:r.nonce,requestSha256:sha(raw),snapshot:{...s,issuedMs:now,expiresMs:now+3000}}));
        const body=Buffer.from(JSON.stringify({payload:payload.toString('base64url'),signature:sign(null,payload,keys.privateKey).toString('base64url')}));
        if(flip===r.authorityId){flip=undefined;snapshots.set(r.authorityId,{...s,state:'FROZEN',head:{sequence:'0',hash:hex('0')},transitionSha256:hex('1'),ownerAccountId:uid(),ownerEpoch:'1'});}
        res.writeHead(200,{'content-type':'application/json','content-length':body.length,'connection':'close'});res.end(body);
      }catch{res.writeHead(403);res.end();}
    })();});
  });
  t.after(async()=>{server.closeAllConnections();if(server.listening)await new Promise<void>(r=>server.close(()=>r()));tls.close();await Promise.all([admin.end(),service.end(),consume.end()]);});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});
  const addr=server.address();assert(addr&&typeof addr==='object');
  const witnessPort=addr.port;
  for(const sql of ['core-broker-dispatch-authority.sql','core-broker-dispatch-credentials.sql','core-broker-dispatch-credential-fence.sql','helper-selection-authority.sql','large-transfer-authority.sql'])
    await admin.query(await readFile(new URL('../../sql/'+sql,import.meta.url),'utf8'));
  await admin.query("CREATE ROLE nx_lifecycle_sql_owner NOLOGIN; CREATE ROLE nx_lifecycle_consume NOLOGIN; CREATE ROLE nx_lifecycle_reconcile NOLOGIN; CREATE ROLE nx07_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD 'fixture-only-not-production'; CREATE ROLE nx07_consume LOGIN PASSWORD 'fixture-only-not-production'; GRANT nx_lifecycle_consume TO nx07_consume;");
  await admin.query("GRANT USAGE ON SCHEMA core_dispatch,transfer_authority TO nx07_runtime; GRANT SELECT ON core_dispatch.authorities,core_dispatch.grants,transfer_authority.grants,transfer_authority.jobs,transfer_authority.claims TO nx07_runtime; GRANT UPDATE(max_seen_ms) ON core_dispatch.authorities TO nx07_runtime; GRANT INSERT ON transfer_authority.jobs,transfer_authority.claims TO nx07_runtime; GRANT UPDATE(epoch,lease_hash,confirmed_offset,stage_created,pending_id,state,final_receipt,final_commit) ON transfer_authority.jobs TO nx07_runtime; GRANT UPDATE(state) ON transfer_authority.claims TO nx07_runtime;");
  let observations=0,receipts=0,nativeDrainCalls=0;
  async function seed(){
    const authorityId=uid(),storeId=uid(),ownerId=uid(),sourceDeviceId=uid(),targetDeviceId=uid(),sourceEpoch=uid(),sourceSession=uid(),targetEpoch=uid(),targetSession=uid();
    const directoryHead=hex('a');
    const key=generateKeyPairSync('ed25519');
    const sourceRoot='C:\\ProgramData\\Nexowire\\source',targetRoot='C:\\ProgramData\\Nexowire\\target';
    const base={authorityId,storeId,directoryHead};
    function state(s:WitnessState){
      snapshots.set(authorityId,{...base,state:s,head:s==='UNANCHORED'?null:{sequence:'0',hash:hex('0')},transitionSha256:s==='UNANCHORED'?null:hex('1'),ownerAccountId:s==='UNANCHORED'?null:ownerId,ownerEpoch:s==='UNANCHORED'?null:'1'});
    }
    state('UNANCHORED');
    await admin.query('INSERT INTO core_dispatch.authorities(authority_id,max_seen_ms) VALUES($1,$2)',[authorityId,Date.now()-1000]);
    for(const [id,epoch,session] of [[sourceDeviceId,sourceEpoch,sourceSession],[targetDeviceId,targetEpoch,targetSession]])
      await admin.query("INSERT INTO core_dispatch.grants(authority_id,device_id,owner_id,device_epoch,session_epoch,owner_epoch,generation,broker_id,state) VALUES($1,$2,$3,$4,$5,1,1,$6,'ACTIVE')",[authorityId,id,ownerId,epoch,session,uid()]);
    await admin.query("INSERT INTO transfer_authority.grants(authority_id,owner_id,project_id,source_device_id,target_device_id,source_device_epoch,source_session_epoch,source_owner_epoch,source_generation,target_device_epoch,target_session_epoch,target_owner_epoch,target_generation,source_root,target_root,target_public_key_pem,state,expires_ms) VALUES($1,$2,'fixture',$3,$4,$5,$6,1,1,$7,$8,1,1,$9,$10,$11,'ACTIVE',$12)",[authorityId,ownerId,sourceDeviceId,targetDeviceId,sourceEpoch,sourceSession,targetEpoch,targetSession,sourceRoot,targetRoot,key.publicKey.export({type:'spki',format:'pem'}).toString(),Date.now()+600000]);
    const id=uid(),targetPath=targetRoot+'\\'+id+'.bin';
    const b:LargeTransferBinding={id,ownerId,projectId:'fixture',sourceDeviceId,targetDeviceId,sourcePath:sourceRoot+'\\input.bin',targetPath,stagePath:targetPath+'.nexowire-upload-'+id+'.part',size:3,sha256:sha('abc')};
    const witness=new ProtectedRecoveryWitnessReadback({authorityId,storeId,endpoint:'https://127.0.0.1:'+witnessPort+'/v1/lifecycle/readback',caPem:tls.ca,clientCertificatePem:tls.runtime.cert,clientKeyPem:tls.runtime.key,serverSpkiSha256:tls.server.spkiSha256,witnessPublicKeyPem:keys.publicKey.export({type:'spki',format:'pem'}).toString(),witnessSpkiSha256:sha(keys.publicKey.export({type:'spki',format:'der'})),recoveryAckSpkiSha256:sha(ack.publicKey.export({type:'spki',format:'der'}))});
    let outcome:IndependentTransferObservation['state']|undefined;
    function backend(withWitness=true){
      return new PostgresProtectedTransferAuthority({authorityId,pool:service as unknown as DispatchStorePool,verifyProvenance:async()=>({verified:true,authorityId,validUntil:Date.now()+30000}),...(withWitness?{recoveryWitness:witness}:{}),
        async observeNativeIntent(b,p,c){observations++;return outcome?{jobId:b.id,requestId:p.requestId,epoch:p.epoch,intentSha256:c.intentSha256,sealed:true,state:outcome,offset:p.offset,length:p.length,sha256:p.sha256}:undefined;},
        async readNativeReceipt(){receipts++;return undefined;}});
    }
    const a=backend();
    const intent=(epoch:number):LargeTransferIntent=>({kind:'write',requestId:uid(),epoch,offset:0,length:3,sha256:b.sha256,dispatched:true});
    const drain=composeTransferDrainObserver({authorityId,pool:service as unknown as DispatchStorePool,async verifyNativeDrain(){nativeDrainCalls++;return true;}});
    const claimState=async(requestId:string)=>(await admin.query('SELECT state FROM transfer_authority.claims WHERE request_id=$1',[requestId])).rows[0]?.state;
    const count=async()=>Number((await admin.query('SELECT count(*) AS n FROM transfer_authority.claims WHERE job_id=$1',[id])).rows[0]?.n);
    const scope=(deviceId:string)=>({authorityId,storeId,ownerAccountId:ownerId,ownerEpoch:'1',directoryHead,deviceId,installationLineageId:uid(),resourceId:uid(),bootId:uid(),sessionEpoch:uid(),generation:'1',purpose:'rollback',transactionSha256:hex('b'),authorizationId:uid(),attemptId:uid(),requestId:uid(),challenge:hex('c'),requestSha256:hex('d'),bindingSha256:hex('e'),envelopeSha256:hex('f'),signerSpkiSha256:hex('1'),deadlineMs:Date.now()+25000});
    // Fixture-only genesis, never production provisioning. All tests use the
    // actual V3 stage function under its restricted role after this boundary.
    async function anchor(){
      const c=await admin.connect();
      try{await c.query('BEGIN');await c.query('ALTER TABLE core_dispatch.authorities DISABLE TRIGGER lifecycle_anchor_guard');await c.query('UPDATE core_dispatch.authorities SET lifecycle_store_id=$2,lifecycle_sequence=0,lifecycle_head=$3 WHERE authority_id=$1',[authorityId,storeId,hex('0')]);await c.query('ALTER TABLE core_dispatch.authorities ENABLE TRIGGER lifecycle_anchor_guard');await c.query('COMMIT');state('COMMITTED');}
      catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    }
    const stage=(db:Pick<Pool,'query'>,deviceId:string,leaseId=uid())=>db.query('SELECT helper_selection.stage_recovery_consume($1::jsonb,$2,0,$3,$4) AS id',[JSON.stringify(scope(deviceId)),leaseId,hex('0'),hex('2')]);
    return {a,b,authorityId,storeId,ownerId,sourceDeviceId,targetDeviceId,backend,state,anchor,stage,intent,drain,count,claimState,outcome:(v:IndependentTransferObservation['state'])=>{outcome=v;}};
  }
  let passes=0;
  function pass(label:string){passes++;t.diagnostic('NX07_V3 PASS '+label);}
  const legacy=await seed();
  await legacy.backend(false).assertGrant(legacy.b);
  await assert.rejects(legacy.a.assertGrant(legacy.b),/TRANSFER_PG_RECOVERY_SCHEMA_REQUIRED/);
  pass('pre-V3 compatibility; configured witness rejects missing schema');
  await admin.query(await readFile(new URL('../../sql/helper-selection-lifecycle-review.sql',import.meta.url),'utf8'));
  await assert.rejects(legacy.backend(false).assertGrant(legacy.b),/TRANSFER_PG_RECOVERY_WITNESS_REQUIRED/);
  const before=requests;await legacy.a.assertGrant(legacy.b);assert.equal(requests-before,2);
  pass('V3 unanchored legacy requires exact signed witness and preserves grant');
  for(const s of ['PENDING','FROZEN','COMMITTED'] as const){legacy.state(s);await assert.rejects(legacy.a.acquire(legacy.b,0),/LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED/);assert.equal(await legacy.count(),0);}
  legacy.state('UNANCHORED');
  pass('local NULL anchor cannot bypass pending/frozen/committed witness');
  // A freeze after the first signed readback must roll back the staged job.
  flip=legacy.authorityId;
  await assert.rejects(legacy.a.acquire(legacy.b,0),/LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED/);
  assert.equal(Number((await admin.query('SELECT count(*) AS n FROM transfer_authority.jobs WHERE id=$1',[legacy.b.id])).rows[0]?.n),0);
  legacy.state('UNANCHORED');
  pass('witness change before commit rolls back acquisition');
  const l=await legacy.a.acquire(legacy.b,0),p=legacy.intent(l.epoch),claim=await legacy.a.claimNativeEffect(legacy.b,l,p);
  await legacy.a.settleNativeEffect(legacy.b,l,p,claim,'unknown');
  legacy.outcome('applied');
  const seen=observations;legacy.state('FROZEN');
  await assert.rejects(legacy.a.assertCurrent(legacy.b,l,3),/LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED/);
  assert.equal(observations,seen);assert.equal(receipts,0);assert.equal(await legacy.claimState(p.requestId),'UNKNOWN');
  legacy.state('UNANCHORED');
  await legacy.a.assertCurrent(legacy.b,l,3);assert.equal(await legacy.claimState(p.requestId),'APPLIED');assert.equal(await legacy.count(),1);
  pass('original APPLIED reconciliation only after independent observation; freeze denies callback');
  const ne=await seed(),nl=await ne.a.acquire(ne.b,0),np=ne.intent(nl.epoch),nc=await ne.a.claimNativeEffect(ne.b,nl,np);
  await ne.a.settleNativeEffect(ne.b,nl,np,nc,'unknown');ne.outcome('no-effect');
  const sealed=await ne.a.acquire(ne.b,nl.epoch);assert.equal(await ne.claimState(np.requestId),'SEALED');
  assert.equal(await ne.a.proveWriteNoEffect(ne.b,np,sealed),true);assert.equal(await ne.claimState(np.requestId),'NO_EFFECT');assert.equal(await ne.count(),1);
  pass('original NO_EFFECT reconciliation retains one claim; no new effect dispatched');
  const revoked=await seed(),rl=await revoked.a.acquire(revoked.b,0),rp=revoked.intent(rl.epoch),rc=await revoked.a.claimNativeEffect(revoked.b,rl,rp);
  await admin.query("UPDATE core_dispatch.grants SET state='REVOKING',generation=generation+1 WHERE authority_id=$1 AND device_id=$2",[revoked.authorityId,revoked.targetDeviceId]);
  await revoked.a.settleNativeEffect(revoked.b,rl,rp,rc,'unknown');
  assert.equal(await revoked.claimState(rp.requestId),'UNKNOWN');
  await assert.rejects(revoked.a.claimNativeEffect(revoked.b,rl,revoked.intent(rl.epoch)),/TRANSFER_PG_GRANT_REVOKED/);
  assert.equal(await revoked.count(),1);
  pass('unanchored revoked original settlement retained without new admission');
  for(const state of ['ACTIVE','UNKNOWN','SETTLED','SEALED'] as const){
    const x=await seed(),lease=await x.a.acquire(x.b,0),intent=x.intent(lease.epoch),original=await x.a.claimNativeEffect(x.b,lease,intent);
    if(state!=='ACTIVE')await x.a.settleNativeEffect(x.b,lease,intent,original,state==='SETTLED'?'completed':'unknown');
    if(state==='SEALED'){x.outcome('unknown');await x.a.acquire(x.b,lease.epoch);}
    assert.equal(await x.claimState(intent.requestId),state);
    const n=nativeDrainCalls;
    for(const deviceId of [x.sourceDeviceId,x.targetDeviceId])assert.equal(await x.drain({ownerId:uid(),deviceId}),false);
    assert.equal(nativeDrainCalls,n);
    await x.anchor();
    for(const deviceId of [x.sourceDeviceId,x.targetDeviceId])await assert.rejects(x.stage(consume,deviceId),/LIFECYCLE_WRITER_DRAIN_REQUIRED/);
    await assert.rejects(x.a.settleNativeEffect(x.b,lease,intent,original,'completed'),/LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED/);
    assert.equal(await x.claimState(intent.requestId),state);assert.equal(await x.count(),1);
    pass(state+' blocks SOURCE and TARGET drain/recovery, no anchored settlement bypass');
  }
  async function waitLock(app:string){
    const until=Date.now()+1500;
    while(Date.now()<until){const r=await admin.query("SELECT count(*) AS n FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",[app]);if(Number(r.rows[0]?.n)>0)return;await delay(20);}
    throw Error('expected real PostgreSQL lock wait: '+app);
  }
  // Recovery first: hold the exact V3 consume transaction on connection A.
  // Connection B is a real service claim call waiting for the same row.
  for(const side of ['SOURCE','TARGET'] as const){
    const x=await seed(),lease=await x.a.acquire(x.b,0),p=x.intent(lease.epoch);
    await x.anchor();const c=await consume.connect();
    let pending:Promise<unknown>|undefined;
    try{
      await c.query('BEGIN');const deviceId=side==='SOURCE'?x.sourceDeviceId:x.targetDeviceId;
      await x.stage(c as unknown as Pool,deviceId);
      const observed=observations,readbacks=requests;
      pending=x.a.claimNativeEffect(x.b,lease,p).then(()=>({ok:true}),error=>({ok:false,error}));
      await waitLock('nx07_writer');
      await c.query('COMMIT');
      const result=await pending as {ok:boolean;error?:unknown};assert.equal(result.ok,false);assert.match(String(result.error),/LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED/);
      assert.equal(observations,observed);assert.equal(requests,readbacks);assert.equal(await x.count(),0);
      await assert.rejects(service.query("INSERT INTO transfer_authority.claims(request_id,job_id,claim_id,epoch,lease_hash,intent_hash,intent,state) VALUES($1,$2,$3,1,$4,$5,'{}','ACTIVE')",[uid(),x.b.id,uid(),hex('a'),hex('b')]),/LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED/);
      pass('recovery-first '+side+' real lock wait, committed recovery denies claim and raw DML');
    }finally{await c.query('ROLLBACK').catch(()=>undefined);c.release();if(pending)await pending;}
  }
  // Writer first: pause the signed fixture readback while its real DB lock
  // is held. A separate connection waits, then sees the committed claim.
  const w=await seed(),wl=await w.a.acquire(w.b,0),wp=w.intent(wl.epoch);
  let entered!:()=>void,resume!:()=>void;
  const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{resume=r;});
  hold={authorityId:w.authorityId,entered,resume:gate};
  const writer=w.a.claimNativeEffect(w.b,wl,wp);
  void writer.catch(()=>undefined);
  const other=await admin.connect();
  let blocked:Promise<unknown>|undefined;
  try{
    await Promise.race([ready,delay(1500).then(()=>{throw Error('writer did not enter signed gate');})]);
    await other.query("SET application_name='nx07_other'");await other.query('BEGIN');
    blocked=other.query('SELECT authority_id FROM core_dispatch.authorities WHERE authority_id=$1 FOR UPDATE',[w.authorityId]);void blocked.catch(()=>undefined);
    await waitLock('nx07_other');resume();await writer;await blocked;
    assert.equal(await w.claimState(wp.requestId),'ACTIVE');await other.query('COMMIT');
  }finally{resume();await other.query('ROLLBACK').catch(()=>undefined);other.release();await writer.catch(()=>undefined);if(blocked)await blocked.catch(()=>undefined);}
  await w.anchor();
  for(const deviceId of [w.sourceDeviceId,w.targetDeviceId])await assert.rejects(w.stage(consume,deviceId),/LIFECYCLE_WRITER_DRAIN_REQUIRED/);
  assert.equal(await w.count(),1);
  pass('writer-first real lock wait, V3 recovery sees original claim on both endpoints');
  assert.equal(passes,14);
  t.diagnostic('NX07_V3_TRANSFER_ACCEPTANCE 14 PASS; real PostgreSQL + signed fixture mTLS; physical native observer NOT_RUN');
});
