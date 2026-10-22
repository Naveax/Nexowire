/**
 * QA30 cross-boundary negative: #768's externally committed final publication
 * is NOT an independently signed Native writer-stop/deletion receipt.
 * Real #768 CrossDeviceTransferJobs + real staging SQLite budget, synthetic
 * Native/CAS and test-only memory escrow. Absolutely no live services.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {CrossDeviceTransferJobs,type TransferJob,type TransferRemote}
  from '../src/mcp/cross-device-transfer-jobs.js';
import {type TrustedFinalReceiptVerifier}
  from '../src/workspace/artifact-job-trust.js';
import {initArtifactBudgetFixture,StagingArtifactByteBudget,ARTIFACT_CHUNK_BYTES}
  from '../src/ops/scale-v2-artifact-byte-budget-staging.js';

const PARENT_768='00ad9a4f061a4da2a0215e470b302f1e25950e4e';
const OWNER_718='ec3aa818e129dfd4bf7e617930623f67121e6bec';
const OWNER_A='qa30-external-owner-a';
const OWNER_B='qa30-external-owner-b';
type Owner=typeof OWNER_A|typeof OWNER_B;
const CHUNK=ARTIFACT_CHUNK_BYTES;
const BYTES=Buffer.alloc(CHUNK+29);
for(let i=0;i<BYTES.length;i++)BYTES[i]=(i*7+19)&255;
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const FILE_SHA=sha(BYTES),CHUNK_SHA=sha(BYTES.subarray(0,CHUNK));
const NOW=new Date('2026-10-22T15:00:00.000Z');
const input={
  accountId:OWNER_A,projectId:'qa30-publish-quota',
  sourceDeviceId:'qa30-src-device',sourcePath:'/qa30/input.bin',
  targetDeviceId:'qa30-dst-device',targetPath:'/qa30/output.bin',
};
type Mode='lost-native-ack'|'externally-committed-final';
function rig(mode:Mode){
  const key=randomBytes(32);
  const sign=(claims:Record<string,unknown>)=>
    createHmac('sha256',key).update(JSON.stringify(claims)).digest('hex');
  let staged=Buffer.alloc(0),destination:Buffer|undefined;
  let writes=0,publishes=0,externalCommits=0;
  const remote:TransferRemote={
    stat:async(device,file)=>{
      const data=device===input.sourceDeviceId?BYTES:
        file===input.targetPath?destination:staged;
      if(!data)throw Object.assign(Error('ENOENT'),{code:'ENOENT'});
      return {type:'file',size:data.byteLength};
    },
    hash:async(device,file)=>{
      const data=device===input.sourceDeviceId?BYTES:
        file===input.targetPath?destination:staged;
      if(!data)throw Object.assign(Error('ENOENT'),{code:'ENOENT'});
      return sha(data);
    },
    read:async(device,_file,offset,length)=>{
      const source=device===input.sourceDeviceId?BYTES:staged;
      const chunk=source.subarray(offset,offset+length);
      return {sourceBytes:source.byteLength,offsetBytes:offset,
        bytesRead:chunk.byteLength,contentBase64:chunk.toString('base64')};
    },
    write:async()=>{throw Error('QA30_UNFENCED_WRITE_FORBIDDEN')},
    moveNoOverwrite:async()=>{throw Error('QA30_UNFENCED_PUBLISH_FORBIDDEN')},
    writeFenced:async(_job,envelope,base64)=>{
      const chunk=Buffer.from(base64,'base64');
      assert.equal(envelope.offset,staged.length);
      assert.equal(envelope.length,chunk.length);
      assert.equal(envelope.sha256,sha(chunk));
      staged=Buffer.concat([staged,chunk]);writes++;
      return {requestId:envelope.requestId,epoch:envelope.epoch,
        offset:envelope.offset,length:envelope.length,sha256:envelope.sha256};
    },
    publishFenced:async(job,epoch,_token,requestId)=>{
      publishes++;
      assert.ok(requestId);
      assert.equal(destination,undefined,'never repeat physical-effect simulator');
      destination=Buffer.from(staged);
      if(mode==='lost-native-ack')throw Error('QA30_SIMULATED_ACK_LOST');
      const claims={requestId:requestId!,jobId:job.id,
        accountId:job.accountId,projectId:job.projectId,
        targetDeviceId:job.targetDeviceId,targetPath:job.targetPath,
        bytesTotal:job.bytesTotal,sha256:job.sha256,epoch};
      return {...claims,proof:sign(claims)};
    },
  };
  const verifier:TrustedFinalReceiptVerifier={
    verify:async(_job,receipt)=>{
      const {proof,...claims}=receipt;
      return proof===sign(claims);
    },
  };
  const authority={
    acquire:async()=>({epoch:1,token:'QA30_TEST_ONLY_EPOCH_LEASE_XXXXXXXXXXXXXXXX'}),
    assertCurrent:async()=>undefined,
    commitPublished:async(job:Readonly<TransferJob>,
      receipt:{requestId:string;epoch:number;sha256:string})=>{
      externalCommits++;
      assert.equal(mode,'externally-committed-final');
      assert.equal(receipt.sha256,FILE_SHA);
      return {jobId:job.id,requestId:receipt.requestId,epoch:receipt.epoch,
        sha256:receipt.sha256,
        durableCommitId:'QA30_TEST_CAS_COMMIT_'+receipt.requestId};
    },
  };
  return {remote,trust:{requireExternalAuthority:true as const,
      authority,grants:{assertCurrent:async()=>undefined},
      requireAuthenticatedFinalReceipt:true as const,finalReceiptVerifier:verifier},
    get publishes(){return publishes},get writes(){return writes},
    get commits(){return externalCommits},get target(){return destination}};
}
class TestOnlyMemoryEscrow{
  private readonly epochs=new Map<Owner,number>([[OWNER_A,5],[OWNER_B,8]]);
  private readonly leases=new Map<string,{owner:Owner;epoch:number;released:boolean}>();
  used(owner:Owner){
    return [...this.leases.values()].filter(x=>x.owner===owner&&!x.released).length*CHUNK;
  }
  reserve(owner:Owner,id:string){
    if(this.leases.has(id))return 'DUPLICATE';
    if(this.used(owner)+CHUNK>2*CHUNK)return 'THROTTLED';
    this.leases.set(id,{owner,epoch:this.epochs.get(owner)!,released:false});
    return 'RESERVED';
  }
  rePair(owner:Owner){this.epochs.set(owner,this.epochs.get(owner)!+1);}
  tryRelease(owner:Owner,id:string,epoch:number,claimedProof:object){
    const lease=this.leases.get(id);
    if(!lease||lease.owner!==owner)return 'FOREIGN_OWNER';
    if(lease.released)return 'ALREADY_RELEASED';
    if(epoch!==lease.epoch||epoch!==this.epochs.get(owner))return 'STALE_OWNER_EPOCH';
    // No independent stop/deletion signer exists in this source tree.
    // A Native ACK, signed publication receipt, CAS ID, or self-attestation
    // is never registered as a writer-stop witness by this test-only model.
    void claimedProof;
    return 'INDEPENDENT_WRITER_STOP_AND_DELETION_UNAVAILABLE';
  }
}
function quota(db:DatabaseSync){
  initArtifactBudgetFixture(db);
  const budget=new StagingArtifactByteBudget(db);
  for(const [owner,suffix] of [[OWNER_A,'a'],[OWNER_B,'b']] as const){
    assert.equal(budget.begin({ownerId:owner,deviceId:'device-'+owner,
      projectId:'project-qa30-cas',sessionId:'session-qa30-cas-'+suffix,
      rootInvocationId:'root-qa30-cas-'+suffix,
      sizeBytes:2*CHUNK,sourceSha256:FILE_SHA,
      physicalFreeBytes:8*1024**3,now:NOW}),'RESERVED');
    assert.equal(budget.stageChunk({ownerId:owner,deviceId:'device-'+owner,
      projectId:'project-qa30-cas',sessionId:'session-qa30-cas-'+suffix,
      requestId:'request-qa30-cas-'+suffix,offsetBytes:0,
      byteCount:CHUNK,chunkSha256:CHUNK_SHA,now:NOW}),'CHUNK_PENDING');
  }
}
for(const mode of ['lost-native-ack','externally-committed-final'] as const){
 test('QA30 #768 CAS publication never authorizes memory cleanup: '+mode,
  {timeout:30000},async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'qa30-publish-cas-'));
    const db=new DatabaseSync(':memory:');
    try{
      quota(db);
      const memory=new TestOnlyMemoryEscrow();
      assert.equal(memory.reserve(OWNER_A,'lease-qa30-publisher'),'RESERVED');
      assert.equal(memory.reserve(OWNER_A,'lease-qa30-extra'),'RESERVED');
      assert.equal(memory.reserve(OWNER_A,'lease-qa30-overflow'),'THROTTLED');
      assert.equal(memory.reserve(OWNER_B,'lease-qa30-quiet'),'RESERVED');
      const native=rig(mode);
      const jobs=new CrossDeviceTransferJobs(root,native.remote,native.trust);
      const started=await jobs.start(input);
      await jobs.waitForIdle(started.id);
      const persisted=JSON.parse(await readFile(path.join(root,started.id+'.json'),'utf8'))
        as TransferJob;
      assert.equal(native.writes,2);
      assert.equal(native.publishes,1);
      assert.deepEqual(native.target,BYTES);
      assert.equal(persisted.publication?.dispatched,true);
      assert.equal(persisted.publication?.sha256,FILE_SHA);
      assert.ok(persisted.publication?.requestId);
      const commitId=persisted.publication?.durableCommitId??null;
      if(mode==='lost-native-ack'){
        assert.equal(persisted.state,'MUTATION_UNKNOWN');
        assert.equal(persisted.errorCode,'TRANSFER_PUBLISH_OUTCOME_UNKNOWN');
        assert.equal(native.commits,0);
        assert.equal(commitId,null);
      }else{
        assert.equal(persisted.state,'COMPLETED');
        assert.equal(native.commits,1);
        assert.match(commitId??'',/^QA30_TEST_CAS_COMMIT_/);
      }
      const publisherLooking=Object.freeze({requestId:persisted.publication?.requestId,
        sha256:FILE_SHA,durableCommitId:commitId,
        writerStopped:true,deletionVerified:true});
      assert.equal(memory.tryRelease(OWNER_A,'lease-qa30-publisher',5,publisherLooking),
        'INDEPENDENT_WRITER_STOP_AND_DELETION_UNAVAILABLE');
      assert.equal(memory.used(OWNER_A),2*CHUNK);
      memory.rePair(OWNER_A);
      assert.equal(memory.tryRelease(OWNER_A,'lease-qa30-publisher',5,publisherLooking),
        'STALE_OWNER_EPOCH');
      assert.equal(memory.tryRelease(OWNER_A,'lease-qa30-publisher',6,publisherLooking),
        'STALE_OWNER_EPOCH');
      assert.equal(memory.reserve(OWNER_A,'lease-qa30-overflow'),'THROTTLED');
      assert.equal(memory.reserve(OWNER_B,'lease-qa30-quiet-2'),'RESERVED');
      const pending=(db.prepare(
        "SELECT COUNT(*) AS n FROM budget_artifact_chunks WHERE state='PENDING'"
      ).get() as {n:number}).n;
      const retained=(db.prepare(
        "SELECT COALESCE(SUM(size_bytes),0) AS n FROM budget_artifact_sessions WHERE state<>'RELEASED'"
      ).get() as {n:number}).n;
      assert.equal(pending,2);
      assert.equal(retained,4*CHUNK);
      assert.equal(memory.used(OWNER_A),2*CHUNK);
      assert.equal(memory.used(OWNER_B),2*CHUNK);
      process.stdout.write('QA30_MONOTONIC_CAS_QUOTA '+JSON.stringify({
        source768:PARENT_768,quotaOwner718:OWNER_718,
        checkoutSha:process.env.GITHUB_SHA??null,mode,
        sourcePublicationState:persisted.state,
        sourceErrorCode:persisted.errorCode??null,
        publicationRequestId:persisted.publication?.requestId,
        commitId:commitId,sourceNativePublishes:native.publishes,
        externalCASCommits:native.commits,pendingChunkCount:pending,
        stagingBytesHeld:retained,noisyMemoryHeld:memory.used(OWNER_A),
        quietMemoryHeld:memory.used(OWNER_B),
        independentSignedWriterStop:false,sourceQuotaIntegration:false,
        sourceNativePhysicalIO:false,paidCloudflareCost:null,
        publicWssConnections:0,oneGiBFiles:0,acceptance:'SOURCE_ONLY_NO_GO',
      })+'\n');
    }finally{db.close();await rm(root,{recursive:true,force:true});}
  });
}
