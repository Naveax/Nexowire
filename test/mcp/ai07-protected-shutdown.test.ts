import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {actualAgentStop} from '../fixtures/ai07-protected-agent-stop.js';
import {ProtectedRuntimeDrain} from '../../src/agent/protected-runtime-drain.js';
import {createTransferRuntimeLeaseAuthority,withVerifiedTransferHelper} from '../../src/agent/protected-transfer-startup.js';
import type {HelperSelectionLeaseTransport,HelperAuthorityScope} from '../../src/security/postgres-helper-selection-authority.js';
import type {TransferHelperArtifactStore} from '../../src/installer/protected-transfer-helper-lifecycle.js';
import {composeHelperSelectionRevokeDrain} from '../../src/security/protected-helper-services-startup.js';
import {helperEvidenceRequiredFacts} from '../../src/security/signed-helper-selection-evidence.js';
import type {DispatchStorePool} from '../../src/agent/postgres-broker-dispatch-authority.js';

test('local protected drain fences new work, waits original callback and never converts UNKNOWN to success',async()=>{
  const drain=new ProtectedRuntimeDrain();
  let resume!:()=>void,started!:()=>void;
  const gate=new Promise<void>(r=>{resume=r;});
  const ready=new Promise<void>(r=>{started=r;});
  const effect=drain.run(async()=>{started();await gate;});
  await ready;
  await assert.rejects(drain.wait(10),/DRAIN_UNKNOWN/);
  await assert.rejects(drain.run(async()=>{}),/RUNTIME_STOPPED/);
  resume();await effect;await assert.rejects(drain.wait(),/DRAIN_UNKNOWN/);
  const clean=new ProtectedRuntimeDrain();await clean.run(async()=>{});await clean.wait();
  clean.markUnknown();await assert.rejects(clean.wait(),/DRAIN_UNKNOWN/);
});
test('verified clean return requests one independent RELEASE; denial and UNKNOWN cannot be retried or released',async()=>{
  const pin={sha256:'a'.repeat(64),signerSha256:'b'.repeat(64)};
  const revision=randomUUID();
  const store:TransferHelperArtifactStore={async verifyInstalled(p){assert.deepEqual(p,pin);},async stage(){throw Error('unexpected stage');}};
  function fixture(allowRelease:boolean){
    const id=randomUUID();let begins=0,releases=0;
    const transport:HelperSelectionLeaseTransport={
      async beginRuntime(requestId){begins++;return {id,requestId,kind:'RUNTIME',expectedRevision:revision};},
      async beginDeployment(){throw Error('unexpected deployment');},
      async read(leaseId){assert.equal(leaseId,id);return {revision,pin};},
      async commit(){throw Error('unexpected commit');},
      async release(leaseId){assert.equal(leaseId,id);releases++;if(!allowRelease)throw Error('fixture independent drain denied');},
    };
    return {authority:createTransferRuntimeLeaseAuthority(transport,30000),counts:()=>({begins,releases})};
  }
  const good=fixture(true);
  await withVerifiedTransferHelper(good.authority,store,async(_binding,scope)=>{
    const drain=new ProtectedRuntimeDrain();await drain.run(async()=>{});
    await drain.wait();await scope.assertActive();
  });
  assert.deepEqual(good.counts(),{begins:1,releases:1});
  await assert.rejects(good.authority.withActiveSelection(async()=>{}),/SCOPE_RETIRED/);
  const denied=fixture(false);
  await assert.rejects(withVerifiedTransferHelper(denied.authority,store,async()=>{}),/independent drain denied/);
  await assert.rejects(denied.authority.withActiveSelection(async()=>{}),/SCOPE_RETIRED/);
  assert.deepEqual(denied.counts(),{begins:1,releases:1});
  const unknown=fixture(true);
  await assert.rejects(withVerifiedTransferHelper(unknown.authority,store,async()=>{
    const drain=new ProtectedRuntimeDrain();drain.markUnknown();await drain.wait();
  }),/DRAIN_UNKNOWN/);
  assert.deepEqual(unknown.counts(),{begins:1,releases:0});
});
test('exact lease-scoped signed RELEASE and existing native drain both required for revoke',async()=>{
  const scope:HelperAuthorityScope={authorityId:randomUUID(),deviceId:randomUUID(),ownerId:randomUUID(),deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),ownerEpoch:1,generation:1,brokerId:randomUUID()};
  const revision=randomUUID(),id=randomUUID(),requestId=randomUUID();
  const row={owner_id:scope.ownerId,device_epoch:scope.deviceEpoch,session_epoch:scope.sessionEpoch,owner_epoch:1,generation:1,broker_id:scope.brokerId};
  const grant={...row,state:'REVOKING',generation:2};
  const selection={...row,revision,sha256:'a'.repeat(64),signer_sha256:'b'.repeat(64)};
  const held={id,request_id:requestId,kind:'RUNTIME',expected_revision:revision,committed_revision:null,state:'ACTIVE'};
  let releases=0,coreDrained=true,wrongProof=false;const queries:string[]=[];
  const pool:DispatchStorePool={async connect(){return {
    async query(sql){queries.push(sql);
      if(sql.includes('FROM core_dispatch.grants'))return {rows:[grant]};
      if(sql.includes('FROM helper_selection.selections'))return {rows:[selection]};
      if(sql.includes('FROM helper_selection.leases'))return {rows:[held]};
      return {rows:[]};
    },release(){releases++;},
  };}};
  const signer=generateKeyPairSync('ed25519');
  const observer=composeHelperSelectionRevokeDrain({pool,scope,verifyExistingNativeDrain:async()=>coreDrained,nativeEvidence:{
    observerPublicKeyPem:signer.publicKey.export({type:'spki',format:'pem'}).toString(),
    async requestProof(challenge,request){
      assert.equal(request.phase,'RELEASE');assert.equal(request.lease.id,id);
      assert.deepEqual(request.scope,scope);assert.equal(request.selection.revision,revision);
      const observedAt=Date.now();
      const payload=JSON.stringify({...challenge,nonce:wrongProof?'0'.repeat(64):challenge.nonce,accepted:true,facts:helperEvidenceRequiredFacts('RELEASE'),observedAt,expiresAt:observedAt+1000});
      return {payload,proof:sign(null,Buffer.from(payload),signer.privateKey).toString('base64url')};
    },
  }});
  const request={deviceId:scope.deviceId,ownerId:scope.ownerId,deviceEpoch:scope.deviceEpoch,sessionEpoch:scope.sessionEpoch,expectedGeneration:1,signedOwnerApproval:'fixture'.repeat(8)};
  assert.equal(await observer(request),true);
  coreDrained=false;assert.equal(await observer(request),false);
  coreDrained=true;wrongProof=true;assert.equal(await observer(request),false);
  assert.equal(await observer(request,AbortSignal.abort()),false);
  assert.equal(releases,3);
  assert(queries.every(q=>/^(BEGIN READ ONLY|SET LOCAL |SELECT |ROLLBACK)/.test(q)));
  assert.equal(held.state,'ACTIVE','revocation proof must not silently release durable history');
});


test('actual isolated Native Agent returns from protected graceful stop without process.exit',{timeout:60000},t=>actualAgentStop(t,'stop'));
test('actual isolated Native Agent lease loss cannot return cleanly',{timeout:60000},t=>actualAgentStop(t,'revoke'));
