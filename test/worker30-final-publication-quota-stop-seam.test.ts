/**
 * Worker #30: cross-owner negative at the exact #754 final Native publication
 * and #718 quota/writer-stop seam. Drives the actual #754 job source and
 * existing staging SQLite budget; a separate TEST-ONLY escrow models physical
 * memory and an independent witness. No real Native, Hub, Cloudflare or CAS.
 *
 * Important: signed FINAL PUBLISH is NOT signed WRITER STOP or deletion.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  CrossDeviceTransferJobs,type TransferRemote,type TransferJob,
} from '../src/mcp/cross-device-transfer-jobs.js';
import {type TrustedFinalReceiptVerifier}
  from '../src/workspace/artifact-job-trust.js';
import {
  initArtifactBudgetFixture,StagingArtifactByteBudget,ARTIFACT_CHUNK_BYTES,
} from '../src/ops/scale-v2-artifact-byte-budget-staging.js';

const BASE_SHA='3a5bf392109d17dbf2650a18398917d5501fd488';
const QUOTA_OWNER_SHA='539c6be5eadd05635a16ff7e0aa306e36314bc4c';
const CHUNK=ARTIFACT_CHUNK_BYTES;
const SHA=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const OWNER_A='worker30-native-owner-a',OWNER_B='worker30-native-owner-b';
type Owner=typeof OWNER_A|typeof OWNER_B;
const INPUT={
  accountId:OWNER_A,projectId:'worker30-cross-source',
  sourceDeviceId:'worker30-device-src',sourcePath:'/synthetic/source.bin',
  targetDeviceId:'worker30-device-dst',targetPath:'/synthetic/target.bin',
};
const DATA=Buffer.alloc(CHUNK+29);
for(let i=0;i<DATA.length;i++)DATA[i]=(i*7+19)&255;
const FILE_SHA=SHA(DATA);
const CHUNK_SHA=SHA(DATA.subarray(0,CHUNK));
const AT=new Date('2026-10-22T12:00:00.000Z');
type Phase='HELD'|'CANCEL_UNKNOWN'|'RELEASED';
type Hold={owner:Owner;id:string;epoch:number;sha:string;bytes:number;state:Phase;
  publicationId:string|null;};
type StopWitness={owner:Owner;id:string;epoch:number;sha:string;
  publicationId:string;writerStopped:boolean;deletionReadbackSha:string|null};
class TestOnlyMemoryStopEscrow {
  private readonly holds=new Map<string,Hold>();
  private readonly currentEpoch=new Map<Owner,number>([[OWNER_A,5],[OWNER_B,8]]);
  private readonly issued=new WeakMap<object,StopWitness>();
  // Deliberately distinct from #754 HMAC signer. Not a real native issuer.
  readonly testOnlyWitnessIssuer=true;
  used(owner:Owner):number{
    return [...this.holds.values()].filter(x=>x.owner===owner&&x.state!=='RELEASED')
      .reduce((sum,x)=>sum+x.bytes,0);
  }
  reserve(owner:Owner,id:string,sha:string){
    if(this.holds.has(id))return 'DUPLICATE';
    if(this.used(owner)+CHUNK>2*CHUNK)return 'THROTTLED';
    this.holds.set(id,{owner,id,epoch:this.currentEpoch.get(owner)!,sha,
      bytes:CHUNK,state:'HELD',publicationId:null});
    return 'RESERVED';
  }
  bindPublishedRequest(owner:Owner,id:string,publishId:string){
    const x=this.holds.get(id);
    assert.ok(x&&x.owner===owner&&!x.publicationId);
    x.publicationId=publishId;
  }
  cancelUnknown(owner:Owner,id:string){
    const x=this.holds.get(id);
    assert.ok(x&&x.owner===owner&&x.state!=='RELEASED');
    x.state='CANCEL_UNKNOWN';
  }
  rePair(owner:Owner){this.currentEpoch.set(owner,this.currentEpoch.get(owner)!+1);}
  mintTestOnly(fields:StopWitness):object{
    const token=Object.freeze({});
    this.issued.set(token,{...fields});
    return token;
  }
  release(owner:Owner,id:string,sha:string,token:object){
    const x=this.holds.get(id);
    if(!x||x.owner!==owner)return 'SCOPE_DENIED';
    if(x.state==='RELEASED')return 'ALREADY_RELEASED';
    if(x.state!=='CANCEL_UNKNOWN')return 'PENDING_WRITER';
    if(x.epoch!==this.currentEpoch.get(owner))return 'OWNER_EPOCH_REPAIRED';
    const proof=this.issued.get(token);
    if(!proof||proof.owner!==owner||proof.id!==id||proof.epoch!==x.epoch||
      proof.sha!==sha||proof.sha!==x.sha||
      proof.publicationId!==x.publicationId||
      proof.writerStopped!==true||proof.deletionReadbackSha!==x.sha)
      return 'INDEPENDENT_STOP_AND_READBACK_REQUIRED';
    x.state='RELEASED';return 'RELEASED_ONCE';
  }
}
type Mode='signed-final-but-writer-active'|'native-published-ack-lost';
function nativeRig(mode:Mode){
  const secret=randomBytes(32);
  let stage=Buffer.alloc(0),target:Buffer|undefined,publishes=0,writes=0;
  const sign=(claims:Record<string,unknown>)=>
    createHmac('sha256',secret).update(JSON.stringify(claims)).digest('hex');
  const verifier:TrustedFinalReceiptVerifier={
    verify:async (_job,receipt)=>{
      const {proof,...claims}=receipt;
      return proof===sign(claims);
    },
  };
  const remote:TransferRemote={
    stat:async(device,file)=>{
      const x=device===INPUT.sourceDeviceId?DATA:
        file===INPUT.targetPath?target:stage;
      if(!x)throw Object.assign(Error('ENOENT'),{code:'ENOENT'});
      return {type:'file',size:x.length};
    },
    hash:async(device,file)=>{
      const x=device===INPUT.sourceDeviceId?DATA:
        file===INPUT.targetPath?target:stage;
      if(!x)throw Object.assign(Error('ENOENT'),{code:'ENOENT'});
      return SHA(x);
    },
    read:async(device,_file,offset,n)=>{
      const all=device===INPUT.sourceDeviceId?DATA:stage;
      const data=all.subarray(offset,offset+n);
      return {sourceBytes:all.length,offsetBytes:offset,
        bytesRead:data.length,contentBase64:data.toString('base64')};
    },
    write:async()=>{throw Error('QA30_LEGACY_NATIVE_WRITE_FORBIDDEN')},
    moveNoOverwrite:async()=>{throw Error('QA30_LEGACY_NATIVE_PUBLISH_FORBIDDEN')},
    writeFenced:async (_job,envelope,body)=>{
      const decoded=Buffer.from(body,'base64');
      assert.equal(envelope.offset,stage.length);
      assert.equal(envelope.length,decoded.byteLength);
      assert.equal(envelope.sha256,SHA(decoded));
      stage=Buffer.concat([stage,decoded]);
      writes++;
      return {requestId:envelope.requestId,epoch:envelope.epoch,
        offset:envelope.offset,length:envelope.length,sha256:envelope.sha256};
    },
    publishFenced:async (job,epoch,_token,requestId)=>{
      publishes++;
      assert.ok(requestId,'the exact durable publication ID must reach native');
      assert.equal(target,undefined,'never replay native publish');
      target=Buffer.from(stage);
      const claims={requestId:requestId!,jobId:job.id,
        accountId:job.accountId,projectId:job.projectId,
        targetDeviceId:job.targetDeviceId,targetPath:job.targetPath,
        bytesTotal:job.bytesTotal,sha256:job.sha256,epoch};
      if(mode==='native-published-ack-lost')throw Error('QA30_NATIVE_ACK_LOST');
      return {...claims,proof:sign(claims)};
    },
  };
  const trust={
    requireExternalAuthority:true as const,
    authority:{
      acquire:async()=>({epoch:1,token:'QA30_EXTERNAL_MOCK_AUTHORITY_TEST_ONLY_XXXX'}),
      assertCurrent:async()=>undefined,
    },
    grants:{assertCurrent:async()=>undefined},
    requireAuthenticatedFinalReceipt:true as const,
    finalReceiptVerifier:verifier,
  };
  return {remote,trust,get published(){return publishes},
    get wrote(){return writes},get target(){return target}};
}
function seedQuota(db:DatabaseSync) {
  initArtifactBudgetFixture(db);
  const budget=new StagingArtifactByteBudget(db);
  for(const [owner,suffix] of [[OWNER_A,'a'],[OWNER_B,'b']] as const){
    assert.equal(budget.begin({ownerId:owner,deviceId:'device-'+owner,
      projectId:'worker30-quota',sessionId:'session-qa30-'+suffix,
      rootInvocationId:'root-qa30-'+suffix,
      sizeBytes:CHUNK*2,sourceSha256:FILE_SHA,
      physicalFreeBytes:8*1024**3,now:AT}),'RESERVED');
    assert.equal(budget.stageChunk({ownerId:owner,deviceId:'device-'+owner,
      projectId:'worker30-quota',sessionId:'session-qa30-'+suffix,
      requestId:'pending-qa30-'+suffix+'-chunk',offsetBytes:0,
      byteCount:CHUNK,chunkSha256:CHUNK_SHA,now:AT}),'CHUNK_PENDING');
  }
  return budget;
}
async function withFixture(fn:(dir:string,db:DatabaseSync)=>Promise<void>){
  const dir=await mkdtemp(path.join(tmpdir(),'qa30-final-quota-'));
  const db=new DatabaseSync(':memory:');
  try{seedQuota(db);await fn(dir,db);}
  finally{db.close();await rm(dir,{recursive:true,force:true});}
}
for(const mode of ['native-published-ack-lost',
  'signed-final-but-writer-active'] as const){
  test('QA30 #754 final receipt is never independently verified writer-stop: '+mode,
    {timeout:30000},async()=>withFixture(async(dir,db)=>{
      const rig=nativeRig(mode);
      const jobs=new CrossDeviceTransferJobs(dir,rig.remote,rig.trust);
      const memory=new TestOnlyMemoryStopEscrow();
      assert.equal(memory.reserve(OWNER_A,'lease30-native-a',CHUNK_SHA),'RESERVED');
      assert.equal(memory.reserve(OWNER_A,'lease30-native-a-extra',CHUNK_SHA),'RESERVED');
      assert.equal(memory.reserve(OWNER_A,'lease30-native-a-third',CHUNK_SHA),'THROTTLED');
      assert.equal(memory.reserve(OWNER_B,'lease30-native-b',CHUNK_SHA),'RESERVED');
      const start=await jobs.start(INPUT);
      await jobs.waitForIdle(start.id);
      const durable=JSON.parse(await readFile(path.join(dir,start.id+'.json'),'utf8'))
        as TransferJob;
      assert.equal(rig.published,1);
      assert.equal(rig.wrote,2);
      assert.equal(durable.publication?.dispatched,true);
      assert.ok(durable.publication?.requestId);
      assert.equal(durable.publication?.sha256,FILE_SHA);
      assert.equal(durable.publication?.epoch,1);
      assert.deepEqual(rig.target,DATA);
      if(mode==='native-published-ack-lost'){
        assert.equal(durable.state,'MUTATION_UNKNOWN');
        assert.equal(durable.errorCode,'TRANSFER_PUBLISH_OUTCOME_UNKNOWN');
      }else{
        assert.equal(durable.state,'COMPLETED',
          'signed final destination receipt can finish publication, NOT memory cleanup');
      }
      memory.bindPublishedRequest(OWNER_A,'lease30-native-a',
        durable.publication!.requestId);
      memory.cancelUnknown(OWNER_A,'lease30-native-a');
      // Forged Native publish ACK or even authenticated FINAL PUBLISH receipt
      // cannot prove that writer handles stopped and stage bytes were deleted.
      assert.equal(memory.release(OWNER_A,'lease30-native-a',CHUNK_SHA,
        Object.freeze({writerStopped:true,deleted:true})),
        'INDEPENDENT_STOP_AND_READBACK_REQUIRED');
      const pubLookingProof=memory.mintTestOnly({
        owner:OWNER_A,id:'lease30-native-a',epoch:5,sha:CHUNK_SHA,
        publicationId:durable.publication!.requestId,
        writerStopped:false,deletionReadbackSha:CHUNK_SHA,
      });
      assert.equal(memory.release(OWNER_A,'lease30-native-a',CHUNK_SHA,
        pubLookingProof),'INDEPENDENT_STOP_AND_READBACK_REQUIRED');
      assert.equal(memory.reserve(OWNER_A,'lease30-native-a-third',CHUNK_SHA),
        'THROTTLED');
      assert.equal(memory.used(OWNER_A),2*CHUNK);
      assert.equal(memory.used(OWNER_B),CHUNK);

      // Old *previously valid* but staged-only proof cannot survive owner
      // re-pair. This is an isolated model, not a real external signer.
      const previouslyValid=memory.mintTestOnly({
        owner:OWNER_A,id:'lease30-native-a',epoch:5,sha:CHUNK_SHA,
        publicationId:durable.publication!.requestId,
        writerStopped:true,deletionReadbackSha:CHUNK_SHA,
      });
      memory.rePair(OWNER_A);
      assert.equal(memory.release(OWNER_A,'lease30-native-a',CHUNK_SHA,
        previouslyValid),'OWNER_EPOCH_REPAIRED');
      assert.equal(memory.reserve(OWNER_A,'lease30-native-a-third',CHUNK_SHA),
        'THROTTLED');
      assert.equal(memory.reserve(OWNER_B,'lease30-native-b-second',CHUNK_SHA),
        'RESERVED','quiet owner retains independent free capacity');

      const pending=(db.prepare(
        "SELECT COUNT(*) AS n FROM budget_artifact_chunks WHERE state='PENDING'"
      ).get() as {n:number}).n;
      const reserved=(db.prepare(
        "SELECT COALESCE(SUM(size_bytes),0) AS n FROM budget_artifact_sessions WHERE state<>'RELEASED'"
      ).get() as {n:number}).n;
      assert.deepEqual({pending,reserved,aMemory:memory.used(OWNER_A),
        bMemory:memory.used(OWNER_B)},{
          pending:2,reserved:4*CHUNK,aMemory:2*CHUNK,bMemory:2*CHUNK,
        },'final signed pub or lost ACK never triggers staging refund');
      process.stdout.write('QA30_FINAL_QUOTA_UNKNOWN '+JSON.stringify({
        base754:BASE_SHA,quota718:QUOTA_OWNER_SHA,
        workflowCheckoutSha:process.env.GITHUB_SHA??null,
        mode,finalPublicationState:durable.state,
        finalPublicationCode:durable.errorCode??null,
        publicationRequestId:durable.publication?.requestId,
        publicationSha:durable.publication?.sha256,
        finalPublishProofIsWriterStop:false,
        ownerRePairRetainsUnknown:true,physicalSignedWriterStop:false,
        pendingChunks:pending,storageStillReservedBytes:reserved,
        noisyMemoryReservedBytes:memory.used(OWNER_A),
        quietMemoryReservedBytes:memory.used(OWNER_B),
        realNativeEffects:0,paidCloudflareCost:null,oneGiBTransfers:0,
        acceptance:'SOURCE_QA_ONLY_NO_GO',
      })+'\n');
    }));
}
