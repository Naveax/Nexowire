import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CrossDeviceTransferJobs, type TransferRemote, type TransferJob
} from '../src/mcp/cross-device-transfer-jobs.js';
import { TransferTrustError, type TrustedTransferAuthority,
  type TrustedTransferCoreGrants } from '../src/workspace/artifact-job-trust.js';

const bytes = Buffer.alloc(221*1024);
for (let i=0;i<bytes.length;i++) bytes[i] = (i*13+29)%256;
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const request = { accountId:'account:synthetic-owner', projectId:'Nexowire',
  sourceDeviceId:'synthetic-work', targetDeviceId:'synthetic-naveax',
  sourcePath:'/only-fixture/source.bin', targetPath:'/only-fixture/destination.bin' };
async function setup(run: (root: string)=>Promise<void>) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nex08-fence-221k-'));
  try { await run(dir); }
  finally { await fs.rm(dir,{recursive:true,force:true}); }
}
const wait = async (jobs: CrossDeviceTransferJobs, jobId: string,
  terminal: string[] = ['COMPLETED']) => {
  for(let i=0;i<450;i++) {
    const job=await jobs.status(jobId,request.accountId,request.sourceDeviceId,request.targetDeviceId);
    if(terminal.includes(job.state)) { await jobs.waitForIdle(jobId); return job; }
    await new Promise(resolve=>setTimeout(resolve,12));
  }
  throw Error('Fixture terminal state never reached, expected='+terminal.join('|'));
};
function mock(mode:'normal'|'lost-ack'|'forged-receipt'|'tamper'|'revoke') {
  let stage = Buffer.alloc(0), published: Buffer|undefined, writes=0, revocation=false;
  const epochs=new Map<string,number>();
  const authority:TrustedTransferAuthority={
    acquire: async(job,kind)=>{
      const next=(epochs.get(job.id)??0)+1;epochs.set(job.id,next);
      return {epoch:next,token:'local-synthetic-fence-'+job.id+'-'+next};
    },
    assertCurrent: async(job,proof)=>{
      if(epochs.get(job.id)!==proof.epoch) throw new TransferTrustError('STALE_EPOCH','stale');
    },
  };
  const grants:TrustedTransferCoreGrants={
    assertCurrent: async(job)=>{
      if(revocation || job.accountId!==request.accountId ||
         job.projectId!==request.projectId ||
         job.sourceDeviceId!==request.sourceDeviceId ||
         job.targetDeviceId!==request.targetDeviceId) {
        throw new TransferTrustError('CORE_OWNER_REVOKED','Current owner CORE grant revoked');
      }
    },
  };
  const remote:TransferRemote={
    stat:async(device,file)=>{
      if(device===request.sourceDeviceId)return {type:'file',size:bytes.length,modifiedAt:'immutable'};
      if(file.endsWith('.bin')) {
        if (!published)throw Object.assign(Error('ENOENT'),{code:'ENOENT'});
        return {type:'file',size:published.length};
      }
      if(!stage.length)throw Object.assign(Error('ENOENT'),{code:'ENOENT'});
      return {type:'file',size:stage.length};
    },
    hash:async(device,file)=>{
      if(device===request.sourceDeviceId)return hash(bytes);
      if(file.endsWith('.bin')) return hash(published??Buffer.alloc(0));
      return hash(stage);
    },
    read:async(device,_file,offset,max)=>{
      const all=device===request.sourceDeviceId?bytes:stage;
      const chunk=all.subarray(offset,offset+max);
      return {sourceBytes:all.length,offsetBytes:offset,bytesRead:chunk.length,
        contentBase64:chunk.toString('base64')};
    },
    write:async()=>{throw Error('UNFENCED_WRITE_FORBIDDEN')},
    moveNoOverwrite:async()=>{throw Error('UNFENCED_PUBLISH_FORBIDDEN')},
    writeFenced:async(job,env,base64,first)=>{
      if(epochs.get(job.id)!==env.epoch)throw Error('NATIVE_EPOCH_FENCE_REJECTED');
      const chunk=Buffer.from(base64,'base64');
      if(chunk.length!==env.length || hash(chunk)!==env.sha256)throw Error('NATIVE_CHUNK_HASH');
      if(first ? stage.length!==0 : stage.length!==env.offset)throw Error('NATIVE_OFFSET_CAS');
      const actual=Buffer.from(chunk);
      if(mode==='tamper' && writes===0)actual[0]=actual[0]!^255;
      stage=Buffer.concat([stage,actual]);writes++;
      if(mode==='revoke' && writes===1)revocation=true;
      if(mode==='lost-ack' && writes===1)throw Error('NETWORK_LOST_ACK');
      return {requestId:env.requestId,epoch:env.epoch,offset:env.offset,length:env.length,
        sha256:mode==='forged-receipt'&&writes===1?'0'.repeat(64):env.sha256};
    },
    publishFenced:async(job,epoch,token)=>{
      if(epochs.get(job.id)!==epoch || !token)throw Error('STALE_PUBLISH');
      if(published)throw Error('DEST_EXISTS');
      published=Buffer.from(stage);
    },
  };
  return {remote,authority,grants,get stage(){return stage;},
    get published(){return published;}, get writes(){return writes;}, set revocation(v:boolean){revocation=v;}};
}
test('221KiB trusted writer: exactly 4 bounded Native CAS receipts and final full digest',async()=>setup(async root=>{
  const fx=mock('normal');
  const jobs=new CrossDeviceTransferJobs(root,fx.remote,{requireExternalAuthority:true,authority:fx.authority,grants:fx.grants});
  const started=await jobs.start(request);
  const done=await wait(jobs,started.id);
  assert.equal(done.bytesConfirmed,bytes.length);
  assert.equal(done.sha256,hash(bytes));
  assert.equal(fx.writes,4);
  assert.deepEqual(fx.published,bytes);
}));
test('forged receipt leaves durable pending and never credits fake ACK',async()=>setup(async root=>{
  const fx=mock('forged-receipt');
  const jobs=new CrossDeviceTransferJobs(root,fx.remote,{requireExternalAuthority:true,authority:fx.authority,grants:fx.grants});
  const started=await jobs.start(request);
  const result=await wait(jobs,started.id,['MUTATION_UNKNOWN']);
  assert.equal(result.bytesConfirmed,0);
  assert.equal(result.errorCode,'FORGED_WRITE_RECEIPT');
  const recorded=JSON.parse(await fs.readFile(path.join(root,started.id+'.json'),'utf8')) as TransferJob;
  assert.equal(recorded.pending?.offset,0);
  assert.equal(recorded.pending?.length,65536);
  assert.equal(fx.writes,1);
  assert.equal(fx.published,undefined);
}));
test('same-size forged stage bytes do not count as verified durable receipt',async()=>setup(async root=>{
  const fx=mock('tamper');
  const jobs=new CrossDeviceTransferJobs(root,fx.remote,{requireExternalAuthority:true,authority:fx.authority,grants:fx.grants});
  const started=await jobs.start(request);
  const result=await wait(jobs,started.id,['MUTATION_UNKNOWN']);
  assert.equal(result.errorCode,'FORGED_WRITE_RECEIPT');
  assert.equal(result.bytesConfirmed,0);
  assert.equal(fx.writes,1);
  assert.equal(fx.published,undefined);
}));
test('lost ACK after durable first chunk requires explicit resume, never replays first write',async()=>setup(async root=>{
  const fx=mock('lost-ack');
  const first=new CrossDeviceTransferJobs(root,fx.remote,{requireExternalAuthority:true,authority:fx.authority,grants:fx.grants});
  const started=await first.start(request);
  const interrupted=await wait(first,started.id,['MUTATION_UNKNOWN']);
  assert.equal(interrupted.bytesConfirmed,0);
  assert.equal(fx.writes,1);
  const recovered=new CrossDeviceTransferJobs(root,fx.remote,{requireExternalAuthority:true,authority:fx.authority,grants:fx.grants});
  const resumed=await recovered.start({...request,resumeTransferId:started.id});
  assert.equal(resumed.bytesConfirmed,65536);
  const done=await wait(recovered,started.id);
  assert.equal(done.state,'COMPLETED');
  assert.equal(fx.writes,4);
  assert.deepEqual(fx.published,bytes);
}));
test('CORE owner revoke during first fenced write denies readback credit and publication',async()=>setup(async root=>{
  const fx=mock('revoke');
  const jobs=new CrossDeviceTransferJobs(root,fx.remote,{requireExternalAuthority:true,authority:fx.authority,grants:fx.grants});
  const started=await jobs.start(request);
  // status requires CURRENT owner grant; inspect durable source directly.
  for(let i=0;i<150;i++){
    const raw=JSON.parse(await fs.readFile(path.join(root,started.id+'.json'),'utf8')) as TransferJob;
    if(raw.state==='MUTATION_UNKNOWN') break;
    await new Promise(resolve=>setTimeout(resolve,12));
  }
  await jobs.waitForIdle(started.id);
  const persisted=JSON.parse(await fs.readFile(path.join(root,started.id+'.json'),'utf8')) as TransferJob;
  assert.equal(persisted.state,'MUTATION_UNKNOWN');
  assert.equal(persisted.errorCode,'CORE_OWNER_REVOKED');
  assert.equal(persisted.bytesConfirmed,0);
  assert.equal(fx.writes,1);
  assert.equal(fx.published,undefined);
  await assert.rejects(jobs.status(started.id,request.accountId,request.sourceDeviceId,request.targetDeviceId),
    (e:unknown)=>e instanceof TransferTrustError&&e.code==='CORE_OWNER_REVOKED');
}));
test('hosted requires both CORE grant authority and truly fenced Native provider',async()=>setup(async root=>{
  const fx=mock('normal');
  const invalid={...fx.remote,writeFenced:undefined,publishFenced:undefined};
  const jobs=new CrossDeviceTransferJobs(root,invalid,
    {requireExternalAuthority:true,authority:fx.authority,grants:fx.grants});
  await assert.rejects(jobs.start(request),
    (e:unknown)=>e instanceof TransferTrustError&&e.code==='NATIVE_WRITER_FENCE_REQUIRED');
  assert.deepEqual(await fs.readdir(root),[]);
}));


test('revoked CORE grant denies source stat/hash before any Native reads',async()=>setup(async root=>{
  let inspected = 0;
  const fx=mock('normal');
  const remote: TransferRemote={...fx.remote,
    stat:async(...a)=>{inspected++;return fx.remote.stat(...a);},
    hash:async(...a)=>{inspected++;return fx.remote.hash(...a);},
  };
  const grants:TrustedTransferCoreGrants={
    assertCurrent:async()=>{throw new TransferTrustError('CORE_OWNER_REVOKED','Denied');},
  };
  const jobs=new CrossDeviceTransferJobs(root,remote,
    {requireExternalAuthority:true,authority:fx.authority,grants});
  await assert.rejects(jobs.start(request),
    (e:unknown)=>e instanceof TransferTrustError&&e.code==='CORE_OWNER_REVOKED');
  assert.equal(inspected,0);
  assert.deepEqual(await fs.readdir(root),[]);
}));
