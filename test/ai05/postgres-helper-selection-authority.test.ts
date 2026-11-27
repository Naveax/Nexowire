import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign,createHash} from 'node:crypto';
import {createSignedHelperSelectionEvidenceVerifier,helperEvidenceRequiredFacts} from '../../src/security/signed-helper-selection-evidence.js';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {bindHelperRollbackGuard} from '../../src/security/protected-helper-rollback-guard.js';
import {composeHelperSelectionRevokeDrain} from '../../src/security/protected-helper-services-startup.js';
import {Pool} from 'pg';
import {createTransferRuntimeLeaseAuthority,withVerifiedTransferHelper,assertSelectedTransferHelper} from '../../src/agent/protected-transfer-startup.js';
import {createProtectedHelperSelectionServer,ProtectedHelperSelectionClient} from '../../src/security/protected-helper-selection-transport.js';
import {createHelperSelectionTlsFixture,createHelperLegacyWitnessFixture} from './helper-selection-tls-fixture.js';
import {assertHelperSelectionGenesisSlotsDrainedLocked,PostgresHelperSelectionAuthority,createHelperSelectionLeaseProvider,type HelperAuthorityEvidenceRequest,type HelperAuthorityScope,type HelperSelectionLeaseTransport} from '../../src/security/postgres-helper-selection-authority.js';
import {runTransferHelperLifecycle,type HelperSelection,type HelperRequest,type TransferHelperArtifactStore} from '../../src/installer/protected-transfer-helper-lifecycle.js';
import type {DispatchStorePool,DispatchStoreConnection} from '../../src/agent/postgres-broker-dispatch-authority.js';

const a={sha256:'a'.repeat(64),signerSha256:'1'.repeat(64)},b={sha256:'b'.repeat(64),signerSha256:'2'.repeat(64)};
const requested=process.env.NEXOWIRE_HELPER_SELECTION_PG_FIXTURE==='1';
const req=(operation:HelperRequest['operation'],expected:HelperSelection,desired:HelperRequest['desired'],sourcePath?:string):HelperRequest=>({requestId:randomUUID(),operation,expected,desired,...(sourcePath===undefined?{}:{sourcePath})});
test('durable independent helper selection excludes runtime/deployment, preserves revisions and denies replay/revocation',{
  skip:!requested,timeout:120000,
},async t=>{
  assert.equal(process.platform,'linux');assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
  const port=Number(process.env.NEXOWIRE_HELPER_SELECTION_PG_PORT);assert(Number.isInteger(port)&&port>0&&port<65536);
  const common={host:'127.0.0.1',port,database:'nexowire_helper_ci',password:'fixture-only-not-production',max:4,connectionTimeoutMillis:3000};
  const admin=new Pool({...common,user:'nexowire_helper_ci'});
  const pools:Pool[]=[admin];t.after(async()=>{await Promise.all(pools.map(p=>p.end()));});
  await admin.query(await readFile('sql/core-broker-dispatch-authority.sql','utf8'));
  await admin.query(await readFile('sql/helper-selection-authority.sql','utf8'));
  // Exact existing V3 quarantine schema in the disposable CI DB only.
  for(const file of ['core-broker-dispatch-credentials.sql','core-broker-dispatch-credential-fence.sql','large-transfer-authority.sql'])
    await admin.query(await readFile('sql/'+file,'utf8'));
  await admin.query('CREATE ROLE nx_lifecycle_sql_owner NOLOGIN; CREATE ROLE nx_lifecycle_consume NOLOGIN; CREATE ROLE nx_lifecycle_reconcile NOLOGIN');
  await admin.query(await readFile('sql/helper-selection-lifecycle-review.sql','utf8'));
  await admin.query("CREATE ROLE helper_fixture_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'fixture-only-not-production'");
  await admin.query("GRANT USAGE ON SCHEMA core_dispatch,helper_selection TO helper_fixture_runtime; GRANT SELECT ON core_dispatch.authorities,core_dispatch.grants,helper_selection.selections,helper_selection.leases TO helper_fixture_runtime; GRANT UPDATE(max_seen_ms) ON core_dispatch.authorities TO helper_fixture_runtime; GRANT INSERT ON helper_selection.leases TO helper_fixture_runtime; GRANT UPDATE(state,committed_revision) ON helper_selection.leases TO helper_fixture_runtime; GRANT UPDATE(revision,sha256,signer_sha256) ON helper_selection.selections TO helper_fixture_runtime");
  const scope:HelperAuthorityScope={authorityId:randomUUID(),deviceId:randomUUID(),ownerId:randomUUID(),deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),ownerEpoch:1,generation:1,brokerId:randomUUID()};
  const values=[scope.authorityId,scope.deviceId,scope.ownerId,scope.deviceEpoch,scope.sessionEpoch,scope.ownerEpoch,scope.generation,scope.brokerId];
  await admin.query('INSERT INTO core_dispatch.authorities(authority_id,max_seen_ms) VALUES($1,$2)',[scope.authorityId,Date.now()-1000]);
  await admin.query("INSERT INTO core_dispatch.grants(authority_id,device_id,owner_id,device_epoch,session_epoch,owner_epoch,generation,broker_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE')",values);
  let current:HelperSelection={revision:randomUUID(),pin:null};
  await admin.query('INSERT INTO helper_selection.selections(authority_id,device_id,owner_id,device_epoch,session_epoch,owner_epoch,generation,broker_id,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[...values,current.revision]);
  let allowRelease=true,allowCommit=true;
  // Explicit synthetic independent observer signs the real challenge.
  // The verifier is production code; these generated keys are fixture-only.
  const observer=generateKeyPairSync('ed25519'),rollbackObserver=generateKeyPairSync('ed25519');
  const dataRoot=await mkdtemp(path.join(os.tmpdir(),'nx-ai05-rollback-state-'));
  const sqlite=new DatabaseSync(path.join(dataRoot,'state.sqlite'));
  t.after(async()=>{sqlite.close();await rm(dataRoot,{recursive:true,force:true});});
  sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE owner(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO owner VALUES(1,'fixture-owner');");
  const identity=Buffer.from('synthetic protected identity bytes'),receipt=Buffer.from('{"status":"COMPLETE"}');
  await writeFile(path.join(dataRoot,'identity.bin'),identity);
  await writeFile(path.join(dataRoot,'receipt.json'),receipt);
  const stateFiles=['state.sqlite','state.sqlite-wal','state.sqlite-shm','identity.bin','receipt.json'];
  const readDigest=async()=>{
    const manifest=await Promise.all(stateFiles.map(async name=>[name,createHash('sha256').update(await readFile(path.join(dataRoot,name))).digest('hex')]));
    return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  };
  const approvedStateSha256=await readDigest();
  const rollbackPhases:string[]=[];
  const reviewedRuntime={manifestSha256:'5'.repeat(64),sourceCommit:'6'.repeat(40),releaseSequence:2,reader:'sqlite-only' as const,schemaVersion:1 as const};
  const approved={runtime:reviewedRuntime,helperPin:a,approvedStateSha256,sqliteTreeSha256:approvedStateSha256,sqliteRecords:1};
  const nativeEvidence=bindHelperRollbackGuard({
    observerPublicKeyPem:observer.publicKey.export({type:'spki',format:'pem'}).toString(),
    async requestProof(challenge,v){
      assert.deepEqual(v.scope,scope);
      const accepted=v.phase==='RELEASE'?allowRelease:v.phase==='COMMIT'?allowCommit:true;
      const observedAt=Date.now();
      const payload=JSON.stringify({...challenge,accepted,facts:helperEvidenceRequiredFacts(v.phase),observedAt,expiresAt:observedAt+3000});
      return {payload,proof:sign(null,Buffer.from(payload,'utf8'),observer.privateKey).toString('base64url')};
    },
  },{
    observerPublicKeyPem:rollbackObserver.publicKey.export({type:'spki',format:'pem'}).toString(),approved,
    async requestProof(challenge,v){
      // Test-only independent signer, observes real disposable SQLite/WAL/SHM
      // and identity/receipt bytes. Never asserts production native drain.
      rollbackPhases.push(v.phase);
      const currentStateSha256=await readDigest();
      const unknownOperations=JSON.parse(await readFile(path.join(dataRoot,'receipt.json'),'utf8')).status==='UNKNOWN';
      const observedAt=Date.now();
      const payload=JSON.stringify({domain:'nexowire.helper-rollback-guard.v2',nonce:challenge.nonce,requestSha256:challenge.requestSha256,phase:challenge.phase,
        approvedStateSha256,currentStateSha256,writerFenced:true,unknownOperations,recoveryPending:false,priorHelperCompatible:true,
        sqliteReview:{manifestSha256:reviewedRuntime.manifestSha256,sourceCommit:reviewedRuntime.sourceCommit,releaseSequence:2,schemaVersion:1,treeSha256:currentStateSha256,sqliteRecords:1,succeeded:1,failed:0,unknown:unknownOperations?1:0,inProgress:0,releaseAnchorAdvanced:false,productionRollbackAuthorized:false},observedAt,expiresAt:observedAt+3000});
      return {payload,proof:sign(null,Buffer.from(payload,'utf8'),rollbackObserver.privateKey).toString('base64url')};
    },
  });
  const signedEvidence=createSignedHelperSelectionEvidenceVerifier(nativeEvidence);
  let provenanceCalls=0,evidenceCalls=0;
  const verifyEvidence=async(v:HelperAuthorityEvidenceRequest)=>{evidenceCalls++;return signedEvidence(v);};
  const verifyProvenance=async()=>{provenanceCalls++;return {verified:true as const,authorityId:scope.authorityId,validUntil:Date.now()+60000};};
  const tls=createHelperSelectionTlsFixture();
  t.after(()=>tls.close());
  const {witnessFor,setState}=await createHelperLegacyWitnessFixture(t,tls);
  const legacyWitness=witnessFor(scope);
  function backend(){
    const pool=new Pool({...common,user:'helper_fixture_runtime'});pools.push(pool);
    return new PostgresHelperSelectionAuthority({pool:pool as unknown as DispatchStorePool,scope,verifyEvidence,
      verifyProvenance,legacyWitness});
  }
  const first=backend(),second=backend();
  // The actual provider requires a provisioned witness, never a permissive fallback.
  assert.throws(()=>new PostgresHelperSelectionAuthority({pool:admin as unknown as DispatchStorePool,scope,verifyEvidence,
    verifyProvenance,legacyWitness:undefined!}),/HELPER_LEGACY_ADMISSION_PROVIDER_REQUIRED/);
  const runtimeToken='r'.repeat(43),deploymentToken='d'.repeat(43);
  assert.throws(()=>createProtectedHelperSelectionServer({tls:{key:tls.server.key,cert:tls.server.cert,ca:tls.ca},
    scope:{...scope,deviceId:randomUUID()},authorityPrivateKeyPem:tls.privateKey,backend:first,
    async resolvePrincipal(){return undefined;}}),/BACKEND_SCOPE_MISMATCH/);
  const server=createProtectedHelperSelectionServer({tls:{key:tls.server.key,cert:tls.server.cert,ca:tls.ca},
    scope,authorityPrivateKeyPem:tls.privateKey,backend:first,
    async resolvePrincipal(cert,credential){
      if(cert===tls.runtime.certSha256&&credential===runtimeToken)return {scope,role:'runtime'};
      if(cert===tls.deployment.certSha256&&credential===deploymentToken)return {scope,role:'deployment'};
      return undefined;
    },
  });
  t.after(async()=>{server.closeAllConnections();if(server.listening)await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});
  const address=server.address();assert(address&&typeof address==='object');
  const transportConfig={endpoint:'https://127.0.0.1:'+address.port+'/v1/helper-selection',scope,
    serverCaPem:tls.ca,serverSpkiSha256:tls.server.spkiSha256,authorityPublicKeyPem:tls.publicKey};
  const runtimeConfig={...transportConfig,role:'runtime' as const,certificatePem:tls.runtime.cert,keyPem:tls.runtime.key,credential:async()=>runtimeToken};
  const deploymentClient=new ProtectedHelperSelectionClient({...transportConfig,role:'deployment',certificatePem:tls.deployment.cert,keyPem:tls.deployment.key,credential:async()=>deploymentToken});
  const runtimeClient=new ProtectedHelperSelectionClient(runtimeConfig);
  const provider=createHelperSelectionLeaseProvider(deploymentClient);
  const stored=new Set<string>();let stagingCalls=0;
  const store:TransferHelperArtifactStore={
    async stage(_file,p){stagingCalls++;stored.add(p.sha256);},
    async verifyInstalled(p){assert(stored.has(p.sha256));},
  };
  const install=req('clean-install',current,a,'inert fixture A');
  const installed=await runTransferHelperLifecycle(install,provider,store);
  current=installed.selection;assert.deepEqual(current.pin,a);
  await assert.rejects(first.beginDeployment(install),/STALE|REPLAY/);
  const authority=createTransferRuntimeLeaseAuthority(new ProtectedHelperSelectionClient(runtimeConfig));
  await withVerifiedTransferHelper(authority,store,async (binding,scope)=>{
    await scope.assertActive();
    assert.equal(binding.revision,current.revision);
    assert.equal(binding.flushHelperSha256,a.sha256);
    await assertSelectedTransferHelper(authority,binding);
    await assert.rejects(second.beginDeployment(req('upgrade',current,b,'inert fixture B')),/LEASE_OCCUPIED/);
  });
  await assert.rejects(authority.withActiveSelection(async()=>{}),/SCOPE_RETIRED/);
  const runtimeRequest=randomUUID();
  await assert.rejects(deploymentClient.beginRuntime(randomUUID()),/ROLE_DENIED/);
  await assert.rejects(runtimeClient.beginDeployment(req('upgrade',current,b,'inert fixture B')),/ROLE_DENIED/);
  const wrongPin=new ProtectedHelperSelectionClient({...runtimeConfig,serverSpkiSha256:'0'.repeat(64)});
  await assert.rejects(wrongPin.beginRuntime(randomUUID()),/TRANSPORT_UNKNOWN/);
  const wrongCredential=new ProtectedHelperSelectionClient({...runtimeConfig,credential:async()=>deploymentToken});
  await assert.rejects(wrongCredential.beginRuntime(randomUUID()),/TRANSPORT_UNKNOWN/);
  const runtime=await runtimeClient.beginRuntime(runtimeRequest);
  assert.deepEqual(await runtimeClient.read(runtime.id),current);
  await assert.rejects(deploymentClient.read(runtime.id),/TRANSPORT_UNKNOWN/);
  await assert.rejects(deploymentClient.release(runtime.id),/TRANSPORT_UNKNOWN/);
  const wrongSigner=new ProtectedHelperSelectionClient({...runtimeConfig,authorityPublicKeyPem:tls.wrongPublicKey});
  await assert.rejects(wrongSigner.read(runtime.id),/SIGNATURE_INVALID/);
  const wrongScope=new ProtectedHelperSelectionClient({...runtimeConfig,scope:{...scope,deviceId:randomUUID()}});
  await assert.rejects(wrongScope.read(runtime.id),/TRANSPORT_UNKNOWN/);
  await assert.rejects(second.beginDeployment(req('upgrade',current,b,'inert fixture B')),/LEASE_OCCUPIED/);
  await assert.rejects(second.beginRuntime(randomUUID()),/LEASE_OCCUPIED/);
  assert.deepEqual(await second.read(runtime.id),current);
  allowRelease=false;await assert.rejects(second.release(runtime.id),/EVIDENCE_DENIED/);
  const recreated=backend();await assert.rejects(recreated.beginRuntime(randomUUID()),/LEASE_OCCUPIED/);
  allowRelease=true;await runtimeClient.release(runtime.id);
  await assert.rejects(second.beginRuntime(runtimeRequest),/REQUEST_REPLAY/);
  const upgrade=req('upgrade',current,b,'inert fixture B');
  const races=await Promise.allSettled([first.beginDeployment(upgrade),second.beginDeployment(req('upgrade',current,b,'inert fixture B'))]);
  assert.equal(races.filter(v=>v.status==='fulfilled').length,1);
  for(const result of races)if(result.status==='fulfilled')await second.release(result.value.id);
  const up=await runTransferHelperLifecycle(req('upgrade',current,b,'inert fixture B'),provider,store);current=up.selection;
  assert.deepEqual(current.pin,b);
  // UNKNOWN receipt blocks initial rollback admission, before a durable slot
  // is created. A subsequent divergent file blocks the actual PG CAS.
  const deniedAdmission=req('rollback',current,a);
  await writeFile(path.join(dataRoot,'receipt.json'),'{"status":"UNKNOWN"}');
  await assert.rejects(deploymentClient.beginDeployment(deniedAdmission),/TRANSPORT_UNKNOWN/);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM helper_selection.leases WHERE request_id=$1',[deniedAdmission.requestId])).rows[0].n,0);
  await writeFile(path.join(dataRoot,'receipt.json'),receipt);
  assert.equal(await readDigest(),approvedStateSha256);
  const deniedCommit=req('rollback',current,a),guardedLease=await deploymentClient.beginDeployment(deniedCommit);
  await writeFile(path.join(dataRoot,'identity.bin'),'synthetic divergent fixture bytes');
  await assert.rejects(deploymentClient.commit(guardedLease.id,deniedCommit),/TRANSPORT_UNKNOWN/);
  assert.deepEqual(await second.read(guardedLease.id),current);
  assert.equal((await admin.query('SELECT state,committed_revision FROM helper_selection.leases WHERE id=$1',[guardedLease.id])).rows[0].state,'ACTIVE');
  await assert.rejects(second.beginRuntime(randomUUID()),/LEASE_OCCUPIED/);
  await second.release(guardedLease.id);
  await assert.rejects(first.beginDeployment(deniedCommit),/REQUEST_REPLAY/);
  // Reconstruct only disposable fixture data for the positive case, never
  // an application rollback or a production recovery operation.
  await writeFile(path.join(dataRoot,'identity.bin'),identity);
  assert.equal(await readDigest(),approvedStateSha256);
  const rollback=await runTransferHelperLifecycle(req('rollback',current,a),provider,store);current=rollback.selection;
  assert.equal(await readDigest(),approvedStateSha256);
  assert.equal(sqlite.prepare('PRAGMA quick_check').get()?.quick_check,'ok');
  assert.equal(sqlite.prepare('SELECT value FROM owner WHERE id=1').get()?.value,'fixture-owner');
  assert.deepEqual(rollbackPhases,['BEGIN_DEPLOYMENT','BEGIN_DEPLOYMENT','COMMIT','BEGIN_DEPLOYMENT','COMMIT']);
  assert.deepEqual(current.pin,a);assert.equal(stored.size,2);

  // COMMIT actually persists in the independent PostgreSQL database, then
  // the test adapter loses its acknowledgement. No second mutation.
  const uncertain=req('upgrade',current,b,'inert fixture B');
  const lease=await first.beginDeployment(uncertain);
  const ackPool=new Pool({...common,user:'helper_fixture_runtime'});pools.push(ackPool);
  let lostAck=false;
  const lostPool:DispatchStorePool={async connect(){
    const client=await ackPool.connect();
    return {async query(sql,values=[]){
      const result=await client.query(sql,values);
      if(sql==='COMMIT'&&!lostAck){lostAck=true;throw Error('fixture lost commit acknowledgement');}
      return {rows:result.rows as Record<string,unknown>[]};
    },release(destroy=false){client.release(destroy);}};
  }};
  const lostBackend=new PostgresHelperSelectionAuthority({pool:lostPool,scope,verifyEvidence,verifyProvenance,legacyWitness});
  await assert.rejects(lostBackend.commit(lease.id,uncertain),/TRANSACTION_UNKNOWN/);
  assert.equal(lostAck,true);
  const recovered=await second.read(lease.id);assert.notEqual(recovered.revision,current.revision);
  assert.deepEqual(recovered.pin,b);current=recovered;
  await assert.rejects(second.commit(lease.id,uncertain),/COMMIT_FENCED/);
  await assert.rejects(second.beginRuntime(randomUUID()),/LEASE_OCCUPIED/);
  allowRelease=false;await assert.rejects(second.release(lease.id),/EVIDENCE_DENIED/);
  allowRelease=true;await second.release(lease.id);
  assert.deepEqual(await admin.query('SELECT state,committed_revision FROM helper_selection.leases WHERE id=$1',[lease.id]).then(v=>v.rows[0]),
    {state:'RELEASED',committed_revision:current.revision});
  const detachRequest=req('uninstall',current,null);
  const stale=await deploymentClient.beginDeployment(detachRequest);
  await assert.rejects(runtimeClient.read(stale.id),/TRANSPORT_UNKNOWN/);
  await assert.rejects(runtimeClient.release(stale.id),/TRANSPORT_UNKNOWN/);
  allowCommit=false;
  await assert.rejects(deploymentClient.commit(stale.id,detachRequest),/TRANSPORT_UNKNOWN/);
  // Exact original request hash required; changed request ID cannot commit.
  await assert.rejects(first.commit(stale.id,req('uninstall',current,null)),/COMMIT_FENCED/);
  await second.release(stale.id);allowCommit=true;
  const detached=await runTransferHelperLifecycle(req('uninstall',current,null),provider,store);current=detached.selection;
  assert.equal(current.pin,null);assert.equal(stored.size,2);
  await assert.rejects(first.beginRuntime(randomUUID()),/NOT_SELECTED/);
  const again=await runTransferHelperLifecycle(req('clean-install',current,a,'inert fixture A'),provider,store);current=again.selection;
  // A restored NULL DB cannot override an independently pending witness.
  async function genesisSlots(authorityId:string){
    const client=await admin.connect();
    const db:DispatchStoreConnection={async query(sql,values=[]){return {rows:(await client.query(sql,values)).rows};},release(destroy=false){client.release(destroy);}};
    try{await client.query('BEGIN');await assertHelperSelectionGenesisSlotsDrainedLocked(db,authorityId);}
    finally{try{await client.query('ROLLBACK');}finally{db.release();}}
  }
  await genesisSlots(scope.authorityId);
  const outstanding=await first.beginRuntime(randomUUID());
  await assert.rejects(genesisSlots(scope.authorityId),/HELPER_GENESIS_TERMINAL_DRAIN_REQUIRED/);
  setState(scope.authorityId,'PENDING');
  const callbackCounts=[provenanceCalls,evidenceCalls,stagingCalls];
  await assert.rejects(first.read(outstanding.id),/LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED/);
  await assert.rejects(first.release(outstanding.id),/LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED/);
  await assert.rejects(first.beginRuntime(randomUUID()),/LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED/);
  await assert.rejects(runTransferHelperLifecycle(req('upgrade',current,b,'inert fixture B'),
    createHelperSelectionLeaseProvider(deploymentClient),store),/TRANSPORT_UNKNOWN/);
  assert.deepEqual([provenanceCalls,evidenceCalls,stagingCalls],callbackCounts,'no legacy observer or staging callback before admission');
  setState(scope.authorityId,'UNANCHORED'); // disposable test witness only, never production thaw
  await first.release(outstanding.id);
  await genesisSlots(scope.authorityId);
  const pending=await first.beginRuntime(randomUUID());
  const revoke={deviceId:scope.deviceId,ownerId:scope.ownerId,deviceEpoch:scope.deviceEpoch,sessionEpoch:scope.sessionEpoch,
    expectedGeneration:scope.generation,signedOwnerApproval:'fixture-only-owner-approval'};
  const drainPool=new Pool({...common,user:'helper_fixture_runtime'});pools.push(drainPool);
  let existingDrained=true;
  const drain=composeHelperSelectionRevokeDrain({pool:drainPool as unknown as DispatchStorePool,scope,nativeEvidence,
    async verifyExistingNativeDrain(){return existingDrained;}});
  assert.equal(await drain(revoke),false,'ACTIVE grant is not a revoke fence');
  // Commit the revoke admission fence first, as the real CORE service does.
  const fence=await admin.connect();
  try{
    await fence.query('BEGIN');
    await fence.query('SELECT authority_id FROM core_dispatch.authorities WHERE authority_id=$1 FOR UPDATE',[scope.authorityId]);
    await fence.query("UPDATE core_dispatch.grants SET state='REVOKING',generation=generation+1,core_enabled=false,root_expires_ms=NULL WHERE authority_id=$1 AND device_id=$2",[scope.authorityId,scope.deviceId]);
    await fence.query('COMMIT');
  }catch(e){await fence.query('ROLLBACK');throw e;}finally{fence.release();}
  // Hold the actual shared lock while the read-only drain observer queries a
  // different restricted connection. It must never reacquire this lock.
  const finish=await admin.connect();
  try{
    await finish.query('BEGIN');
    await finish.query('SELECT authority_id FROM core_dispatch.authorities WHERE authority_id=$1 FOR UPDATE',[scope.authorityId]);
    allowRelease=false;assert.equal(await drain(revoke),false);
    allowRelease=true;existingDrained=false;assert.equal(await drain(revoke),false);
    existingDrained=true;assert.equal(await drain({...revoke,expectedGeneration:scope.generation+1}),false);
    assert.equal(await drain(revoke),true);
    assert.equal((await finish.query('SELECT state FROM helper_selection.leases WHERE id=$1',[pending.id])).rows[0].state,'ACTIVE');
    await finish.query("UPDATE core_dispatch.grants SET state='REVOKED' WHERE authority_id=$1 AND device_id=$2",[scope.authorityId,scope.deviceId]);
    await finish.query('COMMIT');
  }catch(e){await finish.query('ROLLBACK');throw e;}finally{finish.release();}
  await assert.rejects(second.read(pending.id),/GRANT_FENCED/);
  await assert.rejects(second.release(pending.id),/GRANT_FENCED/);
  assert.equal((await admin.query('SELECT state FROM helper_selection.leases WHERE id=$1',[pending.id])).rows[0].state,'ACTIVE');
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM helper_selection.leases WHERE state<>'RELEASED'")).rows[0].n,1);
  // Deliberately reproduce an invalid genesis with surviving legacy slots,
  // only in the disposable cluster. Keep the actual grant ACTIVE so the
  // negative result proves the new early gate, not the old grant check.
  for(const kind of ['RUNTIME','DEPLOYMENT'] as const){
    const s={...scope,authorityId:randomUUID()};
    const v=[s.authorityId,s.deviceId,s.ownerId,s.deviceEpoch,s.sessionEpoch,s.ownerEpoch,s.generation,s.brokerId];
    const selected={revision:randomUUID(),pin:a};
    await admin.query('INSERT INTO core_dispatch.authorities(authority_id,max_seen_ms) VALUES($1,$2)',[s.authorityId,Date.now()-1000]);
    await admin.query("INSERT INTO core_dispatch.grants(authority_id,device_id,owner_id,device_epoch,session_epoch,owner_epoch,generation,broker_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE')",v);
    await admin.query('INSERT INTO helper_selection.selections(authority_id,device_id,owner_id,device_epoch,session_epoch,owner_epoch,generation,broker_id,revision,sha256,signer_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[...v,selected.revision,a.sha256,a.signerSha256]);
    const witness=witnessFor(s),pool=new Pool({...common,user:'helper_fixture_runtime'});pools.push(pool);
    let calls=0;
    const other=new PostgresHelperSelectionAuthority({pool:pool as unknown as DispatchStorePool,scope:s,legacyWitness:witness,
      async verifyProvenance(){calls++;return {verified:true,authorityId:s.authorityId,validUntil:Date.now()+60000};},
      async verifyEvidence(){calls++;return true;}}); // synthetic observer, no native acceptance
    const change=req('upgrade',selected,b,'inert fixture B');
    const held=kind==='RUNTIME'?await other.beginRuntime(randomUUID()):await other.beginDeployment(change);
    if(kind==='DEPLOYMENT')await other.commit(held.id,change);
    await assert.rejects(genesisSlots(s.authorityId),/HELPER_GENESIS_TERMINAL_DRAIN_REQUIRED/);
    const before=(await admin.query('SELECT state,committed_revision FROM helper_selection.leases WHERE id=$1',[held.id])).rows[0];
    // Test-only broken genesis counterexample, never an operator migration.
    await admin.query('ALTER TABLE core_dispatch.authorities DISABLE TRIGGER lifecycle_anchor_guard');
    try{await admin.query('UPDATE core_dispatch.authorities SET lifecycle_store_id=$2,lifecycle_sequence=0,lifecycle_head=$3 WHERE authority_id=$1',[s.authorityId,witness.storeId,'0'.repeat(64)]);}
    finally{await admin.query('ALTER TABLE core_dispatch.authorities ENABLE TRIGGER lifecycle_anchor_guard');}
    const beforeCalls=calls;
    await assert.rejects(other.read(held.id),/LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED/);
    await assert.rejects(other.release(held.id),/LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED/);
    await assert.rejects(other.commit(held.id,change),/LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED/);
    await assert.rejects(other.beginRuntime(randomUUID()),/LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED/);
    await assert.rejects(other.beginDeployment(change),/LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED/);
    assert.equal(calls,beforeCalls);
    assert.deepEqual((await admin.query('SELECT state,committed_revision FROM helper_selection.leases WHERE id=$1',[held.id])).rows[0],before);
    await assert.rejects(genesisSlots(s.authorityId),/HELPER_GENESIS_UNANCHORED_REQUIRED/);
  }
  t.diagnostic('Real PostgreSQL + V3 + signed mTLS witness fixture: legacy lifecycle preserved; restored NULL/pending witness and anchored ACTIVE/COMMITTED slots deny before provenance/evidence/staging; occupied history retained. Native drain and production witness NOT_RUN.');
});
test('provider retains lease on callback failure and refuses nested local acquisition',async()=>{
  const id=randomUUID(),revision=randomUUID();let releases=0,begins=0;
  const transport:HelperSelectionLeaseTransport={
    async beginRuntime(requestId){begins++;return {id,requestId,kind:'RUNTIME',expectedRevision:revision};},
    async beginDeployment(){throw Error('unexpected');},
    async read(){return {revision,pin:a};},
    async commit(){throw Error('unexpected');},
    async release(){releases++;},
  };
  const provider=createHelperSelectionLeaseProvider(transport);
  await assert.rejects(provider.withActiveSelection(async()=>{
    await assert.rejects(provider.withActiveSelection(async()=>{}),/SCOPE_BUSY/);
    throw Error('callback failure');
  }),/callback failure/);
  assert.equal(begins,1);assert.equal(releases,0);
  await assert.rejects(provider.readSelection(),/LEASE_REQUIRED/);
  await assert.rejects(provider.withActiveSelection(async()=>{}),/SCOPE_RETIRED/);
});

test('a completed runtime lease provider cannot be rebound to a new runtime or deployment',async()=>{
  let released=0;
  const transport:HelperSelectionLeaseTransport={
    async beginRuntime(requestId){return {id:randomUUID(),requestId,kind:'RUNTIME',expectedRevision:randomUUID()};},
    async beginDeployment(){throw Error('unexpected');},
    async read(){throw Error('unexpected');},async commit(){throw Error('unexpected');},
    async release(){released++;},
  };
  const provider=createHelperSelectionLeaseProvider(transport);
  assert.equal(await provider.withActiveSelection(async()=>42),42);
  assert.equal(released,1);
  await assert.rejects(provider.withActiveSelection(async()=>{}),/SCOPE_RETIRED/);
  await assert.rejects(provider.withExclusiveQuiescedDeployment(req('clean-install',{revision:randomUUID(),pin:null},a,'fixture'),async()=>{}),/SCOPE_RETIRED/);
});
