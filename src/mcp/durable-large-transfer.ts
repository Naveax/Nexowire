import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

// Source-only production worker seam. The local SQLite journal is NOT an
// authority: the injected, independently protected service and Native writer
// must enforce current owner grants, monotonic epoch and exact mutation CAS.
export interface LargeTransferScope {
  ownerId:string;projectId:string;sourceDeviceId:string;targetDeviceId:string;
}
export interface LargeTransferBinding extends LargeTransferScope {
  id:string;sourcePath:string;targetPath:string;stagePath:string;size:number;sha256:string;
}
export interface LargeTransferLease {epoch:number;token:string}
export interface LargeTransferIntent {kind:'write'|'publish';requestId:string;epoch:number;offset:number;length:number;sha256:string;dispatched:boolean}
export interface LargeTransferWriteReceipt {requestId:string;epoch:number;offset:number;length:number;sha256:string}
export interface LargeTransferFinalReceipt {jobId:string;requestId:string;epoch:number;targetDeviceId:string;targetPath:string;size:number;sha256:string;proof:string}
export interface LargeTransferCommit {jobId:string;requestId:string;epoch:number;sha256:string;commitId:string}
export interface LargeTransferAuthority {
  assertGrant(scope:Readonly<LargeTransferScope>):Promise<void>;
  /** Atomically allocate a higher external epoch for the immutable binding. */
  acquire(binding:Readonly<LargeTransferBinding>,previousEpoch:number):Promise<LargeTransferLease>;
  assertCurrent(binding:Readonly<LargeTransferBinding>,lease:Readonly<LargeTransferLease>,offset:number):Promise<void>;
  /** A missing/old-length stage is not no-effect proof. Only the protected
   * authority may certify that the original request cannot have mutated. */
  proveWriteNoEffect(binding:Readonly<LargeTransferBinding>,intent:Readonly<LargeTransferIntent>,newLease:Readonly<LargeTransferLease>):Promise<boolean>;
  verifyFinal(binding:Readonly<LargeTransferBinding>,receipt:Readonly<LargeTransferFinalReceipt>):Promise<boolean>;
  /** Atomically verify current grant, original intent, and one-time publication. */
  commitPublished(binding:Readonly<LargeTransferBinding>,lease:Readonly<LargeTransferLease>,receipt:Readonly<LargeTransferFinalReceipt>):Promise<LargeTransferCommit>;
  /** Trusted read-only lookup of an already committed original publication. */
  recoverPublished(binding:Readonly<LargeTransferBinding>,intent:Readonly<LargeTransferIntent>):Promise<{receipt:LargeTransferFinalReceipt;commit:LargeTransferCommit}|undefined>;
  /** Protected Native receipt lookup after a lost publish ACK. Never dispatch. */
  recoverNativeReceipt?(binding:Readonly<LargeTransferBinding>,intent:Readonly<LargeTransferIntent>):Promise<LargeTransferFinalReceipt|undefined>;
  /** External CAS of the ORIGINAL publication under current owner grant. */
  commitRecoveredPublication?(binding:Readonly<LargeTransferBinding>,intent:Readonly<LargeTransferIntent>,receipt:Readonly<LargeTransferFinalReceipt>):Promise<LargeTransferCommit>;
}
export interface LargeTransferRemote {
  // Negotiated from an authorized Native provider, never from MCP arguments.
  limits(device:string):Promise<{maxHashBytes:number;maxOffsetBytes:number}>;
  stat(device:string,path:string):Promise<{type:string;size:number}|undefined>;
  hash(device:string,path:string,maxBytes:number):Promise<string>;
  read(device:string,path:string,offset:number,length:number):Promise<{sourceBytes:number;offsetBytes:number;bytesRead:number;contentBase64:string}>;
  // Native implementation must atomically verify external epoch/offset,
  // reserve exclusive creation, durably sync, and never replay UNKNOWN.
  writeFenced(binding:Readonly<LargeTransferBinding>,lease:Readonly<LargeTransferLease>,intent:Readonly<LargeTransferIntent>,base64:string,first:boolean):Promise<LargeTransferWriteReceipt>;
  publishFenced(binding:Readonly<LargeTransferBinding>,lease:Readonly<LargeTransferLease>,intent:Readonly<LargeTransferIntent>):Promise<LargeTransferFinalReceipt>;
}
type State='READY'|'WRITE_PENDING'|'VERIFIED'|'PUBLISHING'|'UNKNOWN'|'COMPLETE'|'CANCELLED';
interface Job {binding:LargeTransferBinding;lease:LargeTransferLease;revision:number;offset:number;stageCreated:boolean;cancelRequested:boolean;state:State;intent?:LargeTransferIntent;commitId?:string}
const CHUNK=65536;
const hex=/^[a-f0-9]{64}$/;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const safe=(n:number)=>Number.isSafeInteger(n)&&n>=0;
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
export class LargeTransferError extends Error{constructor(readonly code:string){super(code);this.name='LargeTransferError';}}
const deny=(code:string):never=>{throw new LargeTransferError(code);};
const fields=['ownerId','projectId','sourceDeviceId','targetDeviceId'] as const;
function scopeValid(scope:LargeTransferScope){return !!scope&&fields.every(k=>typeof scope[k]==='string'&&scope[k].length>0&&scope[k].length<=256)&&scope.sourceDeviceId!==scope.targetDeviceId;}
function leaseValid(lease:LargeTransferLease,previous=0){return !!lease&&safe(lease.epoch)&&lease.epoch>previous&&typeof lease.token==='string'&&lease.token.length>=32&&lease.token.length<=256;}
function valid(job:Job,id:string,revision:number){
  const b=job.binding,p=job.intent;
  return !!b&&b.id===id&&uuid.test(id)&&scopeValid(b)&&safe(b.size)&&hex.test(b.sha256)&&(b.size!==0||b.sha256===sha(Buffer.alloc(0)))&&
    typeof b.sourcePath==='string'&&b.sourcePath.length>0&&b.sourcePath.length<=4096&&
    typeof b.targetPath==='string'&&b.targetPath.length>0&&b.stagePath===b.targetPath+'.nexowire-upload-'+id+'.part'&&b.stagePath.length<=4096&&
    safe(job.revision)&&job.revision===revision&&leaseValid(job.lease)&&safe(job.offset)&&job.offset<=b.size&&typeof job.stageCreated==='boolean'&&typeof job.cancelRequested==='boolean'&&
    (job.offset===0||job.stageCreated)&&(['READY','WRITE_PENDING','VERIFIED','PUBLISHING','UNKNOWN','COMPLETE','CANCELLED'] as State[]).includes(job.state)&&
    (!p||(typeof p.dispatched==='boolean'&&uuid.test(p.requestId)&&safe(p.epoch)&&p.epoch>0&&p.epoch<=job.lease.epoch&&safe(p.offset)&&safe(p.length)&&hex.test(p.sha256)&&
      (p.kind==='write'?(p.offset===job.offset&&p.length<=CHUNK&&p.length<=b.size-p.offset&&(p.length>0||(b.size===0&&!job.stageCreated))):
        p.kind==='publish'&&job.offset===b.size&&job.stageCreated&&p.offset===b.size&&p.length===0&&p.sha256===b.sha256)))&&
    (!job.cancelRequested||job.state==='UNKNOWN'||job.state==='CANCELLED')&&(job.state!=='READY'||!p)&&(job.state!=='WRITE_PENDING'||p?.kind==='write')&&
    (job.state!=='PUBLISHING'||p?.kind==='publish')&&
    (!['VERIFIED','COMPLETE','PUBLISHING'].includes(job.state)||(job.offset===b.size&&job.stageCreated))&&
    (job.state!=='VERIFIED'||!p)&&(job.state!=='COMPLETE'||(p?.kind==='publish'&&p.dispatched&&typeof job.commitId==='string'&&job.commitId.length>=32));
}
function receiptMatches(job:Job,receipt:LargeTransferFinalReceipt){const p=job.intent,b=job.binding;return !!p&&p.kind==='publish'&&p.dispatched&&receipt.jobId===b.id&&receipt.requestId===p.requestId&&receipt.epoch===p.epoch&&receipt.targetDeviceId===b.targetDeviceId&&receipt.targetPath===b.targetPath&&receipt.size===b.size&&receipt.sha256===b.sha256&&typeof receipt.proof==='string'&&receipt.proof.length>=32;}
function commitMatches(job:Job,commit:LargeTransferCommit){const p=job.intent;return !!p&&p.kind==='publish'&&p.dispatched&&commit.jobId===job.binding.id&&commit.requestId===p.requestId&&commit.epoch===p.epoch&&commit.sha256===job.binding.sha256&&typeof commit.commitId==='string'&&commit.commitId.length>=32&&commit.commitId.length<=256;}
function view(j:Job){return {id:j.binding.id,state:j.state,bytesTotal:j.binding.size,bytesConfirmed:j.offset,sha256:j.binding.sha256,revision:j.revision};}

export class DurableLargeTransfer {
  private readonly db:DatabaseSync;
  constructor(filename:string,private readonly remote:LargeTransferRemote,private readonly authority:LargeTransferAuthority){
    if(!remote||!authority||!['limits','stat','hash','read','writeFenced','publishFenced'].every(k=>typeof (remote as unknown as Record<string,unknown>)[k]==='function')||
       !['assertGrant','acquire','assertCurrent','proveWriteNoEffect','verifyFinal','commitPublished','recoverPublished'].every(k=>typeof (authority as unknown as Record<string,unknown>)[k]==='function'))deny('TRUSTED_TRANSFER_PROVIDER_REQUIRED');
    this.db=new DatabaseSync(filename);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS durable_large_transfer(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL)');
  }
  close(){this.db.close();}
  private load(id:string,scope:LargeTransferScope):Job{
    if(!uuid.test(id)||!scopeValid(scope))return deny('TRANSFER_SCOPE_DENIED');
    const row=this.db.prepare('SELECT revision,body FROM durable_large_transfer WHERE id=?').get(id) as {revision:number;body:string}|undefined;
    if(!row)return deny('TRANSFER_NOT_FOUND');
    let job:Job;
    try{job=JSON.parse(row.body) as Job;if(!valid(job,id,row.revision))return deny('TRANSFER_STATE_CORRUPT');}catch{return deny('TRANSFER_STATE_CORRUPT');}
    if(!fields.every(k=>job.binding[k]===scope[k]))return deny('TRANSFER_SCOPE_DENIED');
    return job;
  }
  private cas(old:Job,next:Job):Job{
    const updated={...next,revision:old.revision+1};
    if(!valid(updated,old.binding.id,updated.revision))return deny('TRANSFER_STATE_INVALID');
    const n=this.db.prepare('UPDATE durable_large_transfer SET revision=?,body=? WHERE id=? AND revision=?').run(updated.revision,JSON.stringify(updated),old.binding.id,old.revision).changes;
    if(n!==1)return deny('TRANSFER_CAS_CONFLICT');
    return updated;
  }
  private async current(j:Job){await this.authority.assertGrant(j.binding);await this.authority.assertCurrent(j.binding,j.lease,j.offset);}
  private async checkLimits(b:LargeTransferBinding){
    for(const device of [b.sourceDeviceId,b.targetDeviceId]){
      const l=await this.remote.limits(device);
      if(!safe(l.maxHashBytes)||!safe(l.maxOffsetBytes)||l.maxHashBytes<Math.max(1,b.size)||l.maxOffsetBytes<b.size)deny('NATIVE_LARGE_FILE_UNSUPPORTED');
    }
  }
  private async verifyFile(device:string,path:string,size:number,digest:string){
    const stat=await this.remote.stat(device,path);
    if(!stat||stat.type!=='file'||stat.size!==size||(await this.remote.hash(device,path,Math.max(1,size)))!==digest)deny('TRANSFER_FILE_UNVERIFIED');
  }
  private async read(b:LargeTransferBinding,device:string,path:string,offset:number,length:number,total:number){
    if(length===0)return Buffer.alloc(0);
    const r=await this.remote.read(device,path,offset,length);
    if(r.sourceBytes!==total||r.offsetBytes!==offset||r.bytesRead!==length||typeof r.contentBase64!=='string'||r.contentBase64.length!==4*Math.ceil(length/3))return deny('TRANSFER_READBACK_INVALID');
    const bytes=Buffer.from(r.contentBase64,'base64');
    if(bytes.length!==length||bytes.toString('base64')!==r.contentBase64)return deny('TRANSFER_READBACK_INVALID');
    return bytes;
  }
  async create(scope:LargeTransferScope,sourcePath:string,targetPath:string){
    if(!scopeValid(scope)||!sourcePath||sourcePath.length>4096||!targetPath||targetPath.length>4000)return deny('TRANSFER_SCOPE_DENIED');
    await this.authority.assertGrant(scope);
    const stat=await this.remote.stat(scope.sourceDeviceId,sourcePath);
    if(!stat||stat.type!=='file'||!safe(stat.size))return deny('TRANSFER_SOURCE_INVALID');
    const id=randomUUID();
    const b:LargeTransferBinding={...scope,id,sourcePath,targetPath,stagePath:targetPath+'.nexowire-upload-'+id+'.part',size:stat.size,sha256:''};
    await this.checkLimits(b);
    b.sha256=await this.remote.hash(b.sourceDeviceId,b.sourcePath,Math.max(1,b.size));
    if(!hex.test(b.sha256)||(b.size===0&&b.sha256!==sha(Buffer.alloc(0))))return deny('TRANSFER_SOURCE_INVALID');
    const lease=await this.authority.acquire(b,0);
    if(!leaseValid(lease))return deny('TRANSFER_FENCE_INVALID');
    const j:Job={binding:b,lease,revision:0,offset:0,stageCreated:false,cancelRequested:false,state:'READY'};
    if(!valid(j,id,0))return deny('TRANSFER_STATE_INVALID');
    this.db.prepare('INSERT INTO durable_large_transfer VALUES(?,?,?)').run(id,0,JSON.stringify(j));
    return view(j);
  }
  async inspect(id:string,scope:LargeTransferScope){const j=this.load(id,scope);await this.authority.assertGrant(j.binding);return view(j);}
  private uncertain(j:Job):never{try{this.cas(j,{...j,state:'UNKNOWN'});}catch{/* preserve a newer durable revision */}return deny('TRANSFER_MUTATION_UNKNOWN');}
  async step(id:string,scope:LargeTransferScope){
    const j=this.load(id,scope);await this.current(j);
    const b=j.binding;
    if(j.state==='VERIFIED')return this.publish(j);
    if(j.state!=='READY'||j.intent)return deny('TRANSFER_RECONCILIATION_REQUIRED');
    const length=Math.min(CHUNK,b.size-j.offset);
    const bytes=await this.read(b,b.sourceDeviceId,b.sourcePath,j.offset,length,b.size);
    const p:LargeTransferIntent={kind:'write',requestId:randomUUID(),epoch:j.lease.epoch,offset:j.offset,length,sha256:sha(bytes),dispatched:false};
    let reserved=this.cas(j,{...j,state:'WRITE_PENDING',intent:p});
    try{
      await this.current(reserved);
      // A concurrent cancel/recovery must win or lose the durable revision
      // BEFORE dispatch. After this transition uncertainty is retained.
      reserved=this.cas(reserved,{...reserved,intent:{...p,dispatched:true}});
      const r=await this.remote.writeFenced(b,j.lease,{...p,dispatched:true},bytes.toString('base64'),!j.stageCreated);
      if(r.requestId!==p.requestId||r.epoch!==p.epoch||r.offset!==p.offset||r.length!==length||r.sha256!==p.sha256)deny('TRANSFER_RECEIPT_MISMATCH');
      const size=p.offset+length;
      const stat=await this.remote.stat(b.targetDeviceId,b.stagePath);
      if(!stat||stat.type!=='file'||stat.size!==size)deny('TRANSFER_STAGE_UNVERIFIED');
      if(sha(await this.read(b,b.targetDeviceId,b.stagePath,p.offset,length,size))!==p.sha256)deny('TRANSFER_STAGE_UNVERIFIED');
      await this.current(reserved);
      return view(this.cas(reserved,{...reserved,offset:size,stageCreated:true,intent:undefined,state:size===b.size?'VERIFIED':'READY'}));
    }catch{return this.uncertain(reserved);}
  }
  private async publish(j:Job){
    const b=j.binding;
    await this.verifyFile(b.sourceDeviceId,b.sourcePath,b.size,b.sha256);
    await this.verifyFile(b.targetDeviceId,b.stagePath,b.size,b.sha256);
    const p:LargeTransferIntent={kind:'publish',requestId:randomUUID(),epoch:j.lease.epoch,offset:b.size,length:0,sha256:b.sha256,dispatched:false};
    let reserved=this.cas(j,{...j,state:'PUBLISHING',intent:p});
    try{
      await this.current(reserved);
      reserved=this.cas(reserved,{...reserved,intent:{...p,dispatched:true}});
      const r=await this.remote.publishFenced(b,j.lease,{...p,dispatched:true});
      if(!receiptMatches(reserved,r)||!await this.authority.verifyFinal(b,r))deny('TRANSFER_FINAL_RECEIPT_INVALID');
      await this.verifyFile(b.targetDeviceId,b.targetPath,b.size,b.sha256);
      await this.current(reserved);
      const commit=await this.authority.commitPublished(b,j.lease,r);
      if(!commitMatches(reserved,commit))deny('TRANSFER_EXTERNAL_COMMIT_INVALID');
      return view(this.cas(reserved,{...reserved,state:'COMPLETE',commitId:commit.commitId}));
    }catch{return this.uncertain(reserved);}
  }
  async recover(id:string,scope:LargeTransferScope){
    const j=this.load(id,scope),b=j.binding;
    await this.authority.assertGrant(b);
    if(j.state==='COMPLETE'||j.state==='CANCELLED')return view(j);
    if(j.cancelRequested)return deny('TRANSFER_CANCELLED_UNRESOLVED');
    if(j.intent?.kind==='publish'){
      if(!j.intent.dispatched)return deny('TRANSFER_PUBLICATION_UNRESOLVED');
      const proof=await this.authority.recoverPublished(b,j.intent);
      if(proof){
        if(!receiptMatches(j,proof.receipt)||!commitMatches(j,proof.commit)||!await this.authority.verifyFinal(b,proof.receipt))return deny('TRANSFER_PUBLICATION_UNRESOLVED');
        await this.verifyFile(b.targetDeviceId,b.targetPath,b.size,b.sha256);
        await this.authority.assertGrant(b);
        return view(this.cas(j,{...j,state:'COMPLETE',commitId:proof.commit.commitId}));
      }
      // A persisted signed Native receipt may survive the ACK but precede the
      // external commit. Only the independent authority can commit that exact
      // historical intent under a CURRENT grant. Never call publishFenced again.
      if(!this.authority.recoverNativeReceipt||!this.authority.commitRecoveredPublication)return deny('TRANSFER_PUBLICATION_UNRESOLVED');
      const receipt=await this.authority.recoverNativeReceipt(b,j.intent);
      if(!receipt||!receiptMatches(j,receipt)||!await this.authority.verifyFinal(b,receipt))return deny('TRANSFER_PUBLICATION_UNRESOLVED');
      await this.verifyFile(b.targetDeviceId,b.targetPath,b.size,b.sha256);
      await this.authority.assertGrant(b);
      const commit=await this.authority.commitRecoveredPublication(b,j.intent,receipt);
      if(!commitMatches(j,commit))return deny('TRANSFER_EXTERNAL_COMMIT_INVALID');
      await this.authority.assertGrant(b);
      return view(this.cas(j,{...j,state:'COMPLETE',commitId:commit.commitId}));
    }
    const lease=await this.authority.acquire(b,j.lease.epoch);
    if(!leaseValid(lease,j.lease.epoch))return deny('TRANSFER_FENCE_INVALID');
    await this.checkLimits(b);
    await this.verifyFile(b.sourceDeviceId,b.sourcePath,b.size,b.sha256);
    let expected=j.intent?j.offset+j.intent.length:j.offset;
    const staged=await this.remote.stat(b.targetDeviceId,b.stagePath);
    let pendingApplied=!!j.intent;
    // Exact prior extent (or absent initial stage) may mean no effect; that
    // is never inferred from a local journal or from a transport error.
    if(j.intent&&(!staged||staged.size===j.offset)&&
       (!staged||j.intent.length!==0)){
      if(!await this.authority.proveWriteNoEffect(b,j.intent,lease))return deny('TRANSFER_STAGE_UNRESOLVED');
      expected=j.offset;
      pendingApplied=false;
    }
    if(!staged){if(j.stageCreated||pendingApplied)return deny('TRANSFER_STAGE_UNRESOLVED');}
    else{
      if(staged.type!=='file'||staged.size!==expected||(!pendingApplied&&!j.stageCreated)||(pendingApplied&&!j.intent?.dispatched))return deny('TRANSFER_STAGE_UNRESOLVED');
      const prefix=createHash('sha256');
      for(let at=0;at<expected;){const n=Math.min(CHUNK,expected-at);prefix.update(await this.read(b,b.sourceDeviceId,b.sourcePath,at,n,b.size));at+=n;}
      if(await this.remote.hash(b.targetDeviceId,b.stagePath,Math.max(1,expected))!==prefix.digest('hex'))return deny('TRANSFER_STAGE_UNVERIFIED');
      if(j.intent&&pendingApplied&&sha(await this.read(b,b.targetDeviceId,b.stagePath,j.offset,j.intent.length,expected))!==j.intent.sha256)return deny('TRANSFER_STAGE_UNVERIFIED');
    }
    await this.authority.assertCurrent(b,lease,expected);
    return view(this.cas(j,{...j,lease,offset:expected,stageCreated:!!staged,intent:undefined,state:staged&&expected===b.size?'VERIFIED':'READY'}));
  }
  async cancel(id:string,scope:LargeTransferScope){
    const j=this.load(id,scope);await this.authority.assertGrant(j.binding);
    if(j.state==='COMPLETE'||j.state==='CANCELLED')return view(j);
    if(j.intent?.kind==='publish')return deny('TRANSFER_PUBLICATION_UNRESOLVED');
    if(j.cancelRequested)return view(j);
    return view(this.cas(j,{...j,cancelRequested:true,state:j.intent||j.stageCreated?'UNKNOWN':'CANCELLED'}));
  }
}
