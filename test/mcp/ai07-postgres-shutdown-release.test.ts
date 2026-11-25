import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {actualAgentStop} from '../fixtures/ai07-protected-agent-stop.js';
import {createHelperSelectionTlsFixture} from '../ai05/helper-selection-tls-fixture.js';
import {createTransferRuntimeLeaseAuthority,withVerifiedTransferHelper} from '../../src/agent/protected-transfer-startup.js';
import {bindTransferClaimDrainEvidence} from '../../src/security/protected-transfer-service.js';
import {PostgresHelperSelectionAuthority,type HelperAuthorityScope} from '../../src/security/postgres-helper-selection-authority.js';
import {createProtectedHelperSelectionServer,ProtectedHelperSelectionClient} from '../../src/security/protected-helper-selection-transport.js';
import {createSignedHelperSelectionEvidenceVerifier,helperEvidenceRequiredFacts} from '../../src/security/signed-helper-selection-evidence.js';
import {PostgresProtectedTransferAuthority} from '../../src/security/postgres-protected-transfer-authority.js';
import type {TransferHelperArtifactStore} from '../../src/installer/protected-transfer-helper-lifecycle.js';
import type {DispatchStorePool} from '../../src/agent/postgres-broker-dispatch-authority.js';
import type {LargeTransferBinding,LargeTransferIntent} from '../../src/mcp/durable-large-transfer.js';

const enabled=process.env.NEXOWIRE_AI07_RELEASE_FIXTURE==='1';
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');

test('real Agent clean stop reaches signed mTLS RELEASE; denied observer and UNKNOWN or ACTIVE claim retain original PostgreSQL lease',
  {skip:!enabled?'DISPOSABLE_POSTGRES_RELEASE_NOT_REQUESTED':false,timeout:180000},async t=>{
  assert.equal(process.platform,'linux');
  assert.equal(process.env.GITHUB_ACTIONS,'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
  const port=Number(process.env.NEXOWIRE_AI07_RELEASE_PORT);
  assert(Number.isInteger(port)&&port>0&&port<65536);
  const common={host:'127.0.0.1',port,database:'nexowire_release_ci',password:'fixture-only-not-production',max:4,connectionTimeoutMillis:2000};
  const admin=new Pool({...common,user:'nexowire_release_ci'});
  const transferPool=new Pool({...common,user:'ai07_transfer_runtime'});
  const selectionPool=new Pool({...common,user:'ai07_selection_runtime'});
  t.after(async()=>{await Promise.all([admin.end(),transferPool.end(),selectionPool.end()]);});
  for(const sql of ['core-broker-dispatch-authority.sql','large-transfer-authority.sql','helper-selection-authority.sql'])
    await admin.query(await readFile(new URL('../../sql/'+sql,import.meta.url),'utf8'));
  await admin.query("CREATE ROLE ai07_transfer_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD 'fixture-only-not-production'; CREATE ROLE ai07_selection_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD 'fixture-only-not-production'");
  await admin.query("GRANT USAGE ON SCHEMA core_dispatch,transfer_authority TO ai07_transfer_runtime; GRANT SELECT ON core_dispatch.authorities,core_dispatch.grants,transfer_authority.grants,transfer_authority.jobs,transfer_authority.claims TO ai07_transfer_runtime; GRANT UPDATE(max_seen_ms) ON core_dispatch.authorities TO ai07_transfer_runtime; GRANT INSERT ON transfer_authority.jobs,transfer_authority.claims TO ai07_transfer_runtime; GRANT UPDATE(epoch,lease_hash,confirmed_offset,stage_created,pending_id,state,final_receipt,final_commit) ON transfer_authority.jobs TO ai07_transfer_runtime; GRANT UPDATE(state) ON transfer_authority.claims TO ai07_transfer_runtime");
  await admin.query("GRANT USAGE ON SCHEMA core_dispatch,helper_selection TO ai07_selection_runtime; GRANT SELECT ON core_dispatch.authorities,core_dispatch.grants,helper_selection.selections,helper_selection.leases TO ai07_selection_runtime; GRANT UPDATE(max_seen_ms) ON core_dispatch.authorities TO ai07_selection_runtime; GRANT INSERT ON helper_selection.leases TO ai07_selection_runtime; GRANT UPDATE(state,committed_revision) ON helper_selection.leases TO ai07_selection_runtime; GRANT UPDATE(revision,sha256,signer_sha256) ON helper_selection.selections TO ai07_selection_runtime");
  const tls=createHelperSelectionTlsFixture();
  t.after(()=>tls.close());
  for(const mode of ['clean','observer-denied','unknown','active'] as const){
    const authorityId=randomUUID(),ownerId=randomUUID(),deviceId=randomUUID(),sourceDeviceId=randomUUID(),deviceEpoch=randomUUID(),sessionEpoch=randomUUID(),sourceEpoch=randomUUID(),sourceSession=randomUUID(),brokerId=randomUUID();
    const scope:HelperAuthorityScope={authorityId,deviceId,ownerId,deviceEpoch,sessionEpoch,ownerEpoch:1,generation:1,brokerId};
    const pin={sha256:'a'.repeat(64),signerSha256:'b'.repeat(64)},revision=randomUUID();
    await admin.query('INSERT INTO core_dispatch.authorities(authority_id,max_seen_ms) VALUES($1,$2)',[authorityId,Date.now()-1000]);
    for(const [id,epoch,session,broker] of [[deviceId,deviceEpoch,sessionEpoch,brokerId],[sourceDeviceId,sourceEpoch,sourceSession,randomUUID()]])
      await admin.query("INSERT INTO core_dispatch.grants(authority_id,device_id,owner_id,device_epoch,session_epoch,owner_epoch,generation,broker_id,state) VALUES($1,$2,$3,$4,$5,1,1,$6,'ACTIVE')",[authorityId,id,ownerId,epoch,session,broker]);
    await admin.query('INSERT INTO helper_selection.selections(authority_id,device_id,owner_id,device_epoch,session_epoch,owner_epoch,generation,broker_id,revision,sha256,signer_sha256) VALUES($1,$2,$3,$4,$5,1,1,$6,$7,$8,$9)',[authorityId,deviceId,ownerId,deviceEpoch,sessionEpoch,brokerId,revision,pin.sha256,pin.signerSha256]);
    const sourceRoot='C:\\ProgramData\\Nexowire\\source',targetRoot='C:\\ProgramData\\Nexowire\\target';
    const fileKey=generateKeyPairSync('ed25519');
    await admin.query("INSERT INTO transfer_authority.grants(authority_id,owner_id,project_id,source_device_id,target_device_id,source_device_epoch,source_session_epoch,source_owner_epoch,source_generation,target_device_epoch,target_session_epoch,target_owner_epoch,target_generation,source_root,target_root,target_public_key_pem,state,expires_ms) VALUES($1,$2,'fixture',$3,$4,$5,$6,1,1,$7,$8,1,1,$9,$10,$11,'ACTIVE',$12)",[authorityId,ownerId,sourceDeviceId,deviceId,sourceEpoch,sourceSession,deviceEpoch,sessionEpoch,sourceRoot,targetRoot,fileKey.publicKey.export({type:'spki',format:'pem'}).toString(),Date.now()+600000]);
    const provenance=async()=>({verified:true,authorityId,validUntil:Date.now()+30000});
    const transfer=new PostgresProtectedTransferAuthority({authorityId,pool:transferPool as unknown as DispatchStorePool,verifyProvenance:provenance,observeNativeIntent:async()=>undefined,readNativeReceipt:async()=>undefined});
    const observer=generateKeyPairSync('ed25519');
    let childReturned=false,releaseProofs=0,originalLeaseId:string|undefined,claimId:string|undefined;
    const evidence=bindTransferClaimDrainEvidence(transferPool as unknown as DispatchStorePool,authorityId,{
      observerPublicKeyPem:observer.publicKey.export({type:'spki',format:'pem'}).toString(),
      async requestProof(challenge,request){
        assert.deepEqual(request.scope,scope);
        if(request.phase==='BEGIN_RUNTIME')originalLeaseId=request.lease.id;
        if(request.phase==='RELEASE'){
          releaseProofs++;
          assert.equal(request.lease.id,originalLeaseId);
          assert(childReturned,'no release proof before the actual child returned');
        }
        const accepted=request.phase!=='RELEASE'||mode==='clean';
        const observedAt=Date.now();
        const payload=JSON.stringify({...challenge,accepted,facts:helperEvidenceRequiredFacts(request.phase),observedAt,expiresAt:observedAt+2000});
        return {payload,proof:sign(null,Buffer.from(payload),observer.privateKey).toString('base64url')};
      },
    });
    const backend=new PostgresHelperSelectionAuthority({pool:selectionPool as unknown as DispatchStorePool,scope,verifyEvidence:createSignedHelperSelectionEvidenceVerifier(evidence),verifyProvenance:provenance});
    const token='r'.repeat(43);
    const server=createProtectedHelperSelectionServer({tls:{key:tls.server.key,cert:tls.server.cert,ca:tls.ca},scope,authorityPrivateKeyPem:tls.privateKey,backend,
      async resolvePrincipal(cert,credential){return cert===tls.runtime.certSha256&&credential===token?{scope,role:'runtime'}:undefined;}});
    try{
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});
      const addr=server.address();assert(addr&&typeof addr==='object');
      const client=new ProtectedHelperSelectionClient({endpoint:'https://127.0.0.1:'+addr.port+'/v1/helper-selection',scope,role:'runtime',certificatePem:tls.runtime.cert,keyPem:tls.runtime.key,serverCaPem:tls.ca,serverSpkiSha256:tls.server.spkiSha256,authorityPublicKeyPem:tls.publicKey,credential:async()=>token});
      const provider=createTransferRuntimeLeaseAuthority(client,30000);
      const store:TransferHelperArtifactStore={async verifyInstalled(p){assert.deepEqual(p,pin);},async stage(){throw Error('unexpected stage');}};
      const run=()=>withVerifiedTransferHelper(provider,store,async(binding,leaseScope)=>{
        assert.equal(binding.revision,revision);
        if(mode==='unknown'||mode==='active'){
          const id=randomUUID(),targetPath=targetRoot+'\\shutdown.bin';
          const b:LargeTransferBinding={id,ownerId,projectId:'fixture',sourceDeviceId,targetDeviceId:deviceId,sourcePath:sourceRoot+'\\input.bin',targetPath,stagePath:targetPath+'.nexowire-upload-'+id+'.part',size:3,sha256:digest('abc')};
          const l=await transfer.acquire(b,0);
          const p:LargeTransferIntent={kind:'write',requestId:randomUUID(),epoch:l.epoch,offset:0,length:3,sha256:b.sha256,dispatched:true};
          const claim=await transfer.claimNativeEffect(b,l,p);claimId=claim.claimId;
          if(mode==='unknown')await transfer.settleNativeEffect(b,l,p,claim,'unknown');
        }
        await actualAgentStop(t,'stop',deviceId);
        childReturned=true;
        await leaseScope.assertActive();
      });
      if(mode==='clean')await run();else await assert.rejects(run(),/HELPER_SELECTION_TRANSPORT_UNKNOWN/);
      assert(originalLeaseId);
      const leaseRows=(await admin.query('SELECT id,state FROM helper_selection.leases WHERE authority_id=$1 AND device_id=$2',[authorityId,deviceId])).rows;
      assert.deepEqual(leaseRows,[{id:originalLeaseId,state:mode==='clean'?'RELEASED':'ACTIVE'}]);
      assert.equal(releaseProofs,mode==='clean'||mode==='observer-denied'?1:0,'unresolved claims must block before requesting RELEASE proof');
      await assert.rejects(provider.withActiveSelection(async()=>{}),/SCOPE_RETIRED/);
      if(mode!=='clean')await assert.rejects(backend.beginRuntime(randomUUID()),/HELPER_LEASE_OCCUPIED/);
      if(claimId){
        const rows=(await admin.query('SELECT claim_id,state FROM transfer_authority.claims WHERE claim_id=$1',[claimId])).rows;
        assert.deepEqual(rows,[{claim_id:claimId,state:mode==='unknown'?'UNKNOWN':'ACTIVE'}]);
      }
      t.diagnostic(mode+': real process return='+childReturned+'; RELEASE proof requests='+releaseProofs+'; durable lease='+leaseRows[0].state);
    }finally{server.closeAllConnections();if(server.listening)await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
  }
  t.diagnostic('Real PostgreSQL and pinned mTLS; real isolated Agent process; synthetic independent native observer and inert helper artifact, not physical native drain');
});
