/**
 * Independent read-only progress observer for the source-only #596
 * artifact_bridge_transfer_start/status/cancel response contract.
 * Does not mutate #08 store, #03 ProcessManager or start/replay jobs.
 */
import { createHash } from 'node:crypto';

const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CHUNK = 65536;
const NATIVE_HASH_LIMIT = 268435456;
const PROOF_FRESH_MS = 30000;

export type TransferJobState =
  'QUEUED'|'RUNNING'|'RECOVERY_REQUIRED'|'FAILED'|'MUTATION_UNKNOWN'|
  'CANCEL_REQUESTED'|'CANCELLED'|'PUBLISHING'|'COMPLETED';
/** Exact public CrossDeviceTransferJobs.public() DTO at #596 HEAD 33504656. */
export interface TransferJobReceipt {
  id: string;
  state: TransferJobState;
  bytesTotal: number;
  bytesConfirmed: number;
  sha256: string;
  sourceDeviceId: string;
  targetDeviceId: string;
  sourcePath: string;
  targetPath: string;
  updatedAt: string;
  errorCode?: string;
}
export interface TransferWatchIdentity {
  /** Pinned by an authenticated caller, never derived from transfer metadata. */
  requestId: string;
  accountId: string;
  projectId: string;
  sourceDeviceId: string;
  targetDeviceId: string;
  sourcePath: string;
  targetPath: string;
  /** Optional SHA pinned before transfer_start; otherwise fixed at start. */
  expectedSourceSha256?: string;
}
export interface TransferReadback {
  stat(device: string, file: string): Promise<{type:string;size:number;modifiedAt?:string}>;
  hash(device: string, file: string, maxBytes: number): Promise<string>;
  read(device: string, file: string, offset: number, size: number): Promise<{
    sourceBytes:number;offsetBytes:number;bytesRead:number;contentBase64:string;
  }>;
}
type Phase = 'UNBOUND'|TransferJobState;
const terminal = new Set<Phase>(['COMPLETED','FAILED','CANCELLED']);
export class OneCallTransferWatchdog {
  private phase: Phase='UNBOUND';
  private transferId: string|null=null;
  private total: number|null=null;
  private sha256: string|null=null;
  private confirmed=0;
  private resumedFrom=0;
  private lastStatusTime=0;
  private progressAt: number;
  private readbackAt: number|null=null;
  private readbackChunkSha256: string|null=null;
  private publicationReported=false;
  private readonly owner: TransferWatchIdentity;
  private lostWorker=false;
  private reportedWorkerCompleted:number|null=null;
  constructor(identity:TransferWatchIdentity,private readonly now:()=>number=Date.now) {
    if(!UUID.test(identity?.requestId??'') || !identity.accountId?.length ||
       !identity.projectId?.length || !identity.sourceDeviceId?.length ||
       !identity.targetDeviceId?.length || identity.sourceDeviceId===identity.targetDeviceId ||
       !identity.sourcePath?.length || !identity.targetPath?.length ||
       (identity.expectedSourceSha256!==undefined && !SHA.test(identity.expectedSourceSha256))) {
      throw new Error('INVALID_TRANSFER_IDENTITY');
    }
    this.owner=structuredClone(identity);
    this.progressAt=this.now();
  }
  private fail(code:string):never {
    this.phase='MUTATION_UNKNOWN';this.readbackAt=null;
    throw new Error(code);
  }
  private validate(receipt:TransferJobReceipt):number {
    if(!receipt || !UUID.test(receipt.id) ||
       !Object.hasOwn(receipt,'state') ||
       !['QUEUED','RUNNING','RECOVERY_REQUIRED','FAILED','MUTATION_UNKNOWN',
          'CANCEL_REQUESTED','CANCELLED','PUBLISHING','COMPLETED'].includes(receipt.state) ||
       !SHA.test(receipt.sha256) ||
       !Number.isSafeInteger(receipt.bytesTotal) || receipt.bytesTotal<0 ||
       !Number.isSafeInteger(receipt.bytesConfirmed) ||
       receipt.bytesConfirmed<0 || receipt.bytesConfirmed>receipt.bytesTotal ||
       (receipt.bytesConfirmed%CHUNK!==0 && receipt.bytesConfirmed!==receipt.bytesTotal) ||
       receipt.sourceDeviceId!==this.owner.sourceDeviceId ||
       receipt.targetDeviceId!==this.owner.targetDeviceId ||
       receipt.sourcePath!==this.owner.sourcePath ||
       receipt.targetPath!==this.owner.targetPath ||
       (this.owner.expectedSourceSha256!==undefined &&
         receipt.sha256!==this.owner.expectedSourceSha256)) this.fail('TRANSFER_RECEIPT_SCOPE_OR_DIGEST_MISMATCH');
    const at=Date.parse(receipt.updatedAt);
    if(!Number.isFinite(at) || new Date(at).toISOString()!==receipt.updatedAt ||
       at>this.now()+2000) this.fail('TRANSFER_RECEIPT_TIMESTAMP_INVALID');
    return at;
  }
  private apply(receipt:TransferJobReceipt, source:'start'|'status'|'cancel'|'resume') {
    const at=this.validate(receipt);
    if(source==='start' && this.phase!=='UNBOUND')this.fail('TRANSFER_ALREADY_BOUND');
    if(source!=='start' && !this.transferId)this.fail('TRANSFER_NOT_BOUND');
    if(this.transferId && this.transferId!==receipt.id)this.fail('TRANSFER_ID_CHANGED');
    if(this.total!==null && (this.total!==receipt.bytesTotal || this.sha256!==receipt.sha256))
      this.fail('TRANSFER_BYTES_OR_HASH_CHANGED');
    if(at<this.lastStatusTime)this.fail('TRANSFER_STATUS_ROLLBACK');
    if(receipt.bytesConfirmed<this.confirmed)this.fail('TRANSFER_OFFSET_ROLLBACK');
    if(receipt.state==='COMPLETED' && receipt.bytesConfirmed!==receipt.bytesTotal)
      this.fail('COMPLETED_WITH_UNPUBLISHED_BYTES');
    if(receipt.state==='PUBLISHING' && receipt.bytesConfirmed!==receipt.bytesTotal)
      this.fail('PUBLISHING_WITH_INCOMPLETE_BYTES');
    if(terminal.has(this.phase) && receipt.state!==this.phase &&
       !(source==='resume'&&this.phase==='FAILED'))
      this.fail('TRANSFER_TERMINAL_ROLLBACK');
    if(this.phase==='PUBLISHING' && !['PUBLISHING','COMPLETED','MUTATION_UNKNOWN','FAILED'].includes(receipt.state))
      this.fail('PUBLISHING_STATE_ROLLBACK');
    if(this.phase==='CANCELLED' && receipt.state==='COMPLETED')
      this.fail('TRANSFER_PUBLISHED_AFTER_CANCEL');
    if(this.phase==='CANCEL_REQUESTED' && receipt.state==='COMPLETED')
      this.fail('TRANSFER_PUBLISHED_AFTER_CANCEL_REQUEST');
    if(this.phase==='MUTATION_UNKNOWN' && source!=='resume' &&
       receipt.state!=='MUTATION_UNKNOWN' && receipt.state!=='RECOVERY_REQUIRED')
      this.fail('UNKNOWN_MUTATION_REQUIRES_EXPLICIT_RESUME');
    if(receipt.state==='CANCEL_REQUESTED' && source!=='cancel' && this.phase!=='CANCEL_REQUESTED')
      this.fail('UNSOLICITED_CANCEL_REQUEST');
    this.transferId=receipt.id;
    this.total=receipt.bytesTotal;
    this.sha256=receipt.sha256;
    if(receipt.bytesConfirmed>this.confirmed)this.progressAt=this.now();
    this.confirmed=receipt.bytesConfirmed;
    this.lastStatusTime=at;
    this.phase=receipt.state;
    this.publicationReported=receipt.state==='COMPLETED';
    this.readbackAt=null;this.readbackChunkSha256=null;
  }
  /** Returns a durable job ID quickly; never assumes that bytes have arrived. */
  observeStart(receipt:TransferJobReceipt):void {this.apply(receipt,'start');}
  observeStatus(receipt:TransferJobReceipt):void {this.apply(receipt,'status');}
  observeCancel(receipt:TransferJobReceipt):void {
    if(!['CANCEL_REQUESTED','CANCELLED'].includes(receipt.state))
      this.fail('CANCEL_RECEIPT_NOT_CANCELED');
    this.apply(receipt,'cancel');
  }
  /** This action itself never executes a replay. It observes caller-approved
   * explicit resume after #596 independently reconciled stage/source. */
  observeExplicitResume(receipt:TransferJobReceipt, approvedByOwner: true):void {
    if(approvedByOwner!==true || !this.transferId ||
       !['MUTATION_UNKNOWN','RECOVERY_REQUIRED','FAILED','QUEUED'].includes(this.phase))
      this.fail('RESUME_NOT_EXPLICITLY_AUTHORIZED');
    if(!['QUEUED','RUNNING','COMPLETED'].includes(receipt.state))
      this.fail('RESUME_NOT_RECONCILED');
    const before=this.confirmed;
    this.apply(receipt,'resume');
    this.resumedFrom=receipt.bytesConfirmed;
    if(this.confirmed>before)this.progressAt=this.now();
  }
  markUnknown():void {if(this.phase!=='COMPLETED'&&this.phase!=='CANCELLED')
    {this.phase='MUTATION_UNKNOWN';this.readbackAt=null;}}
  observeWorkerSignal(signal:{state:'running'|'lost';reportedCompleted?:number}):void {
    if(!signal || (signal.reportedCompleted!==undefined &&
       (!Number.isSafeInteger(signal.reportedCompleted)||signal.reportedCompleted<0)))
      this.fail('INVALID_WORKER_SIGNAL');
    if(signal.state==='lost'){this.lostWorker=true;this.readbackAt=null;}
    if(signal.reportedCompleted!==undefined)this.reportedWorkerCompleted=signal.reportedCompleted;
  }
  warning(stallMs=30000):'WORKER_PID_LOST'|'MUTATION_UNKNOWN'|'NO_STORAGE_PROGRESS'|null {
    if(this.lostWorker)return 'WORKER_PID_LOST';
    if(['MUTATION_UNKNOWN','RECOVERY_REQUIRED'].includes(this.phase))return 'MUTATION_UNKNOWN';
    if(['QUEUED','RUNNING'].includes(this.phase) &&
       this.now()-this.progressAt>=stallMs)return 'NO_STORAGE_PROGRESS';
    return null;
  }
  /**
   * Independent target readback. Only executed after a status claims final
   * publication. Native Agent 1.0.5 supports <=256MiB hash offsets.
   * A real remote provider must authenticate targetDeviceId and targetPath.
   * This is storage consistency, NOT cryptographic immutability or task proof.
   */
  async verifyPublishedTarget(remote:TransferReadback):Promise<boolean> {
    if(this.phase!=='COMPLETED' || this.lostWorker ||
       !this.transferId || this.total===null || !this.sha256 ||
       this.total>NATIVE_HASH_LIMIT)return false;
    const expectedId=this.transferId,expectedStatus=this.lastStatusTime;
    try{
      const before=await remote.stat(this.owner.targetDeviceId,this.owner.targetPath);
      if(before.type!=='file'||before.size!==this.total)return this.invalidateReadback();
      const actual=(await remote.hash(this.owner.targetDeviceId,
        this.owner.targetPath,NATIVE_HASH_LIMIT)).toLowerCase();
      if(actual!==this.sha256)return this.invalidateReadback();
      if(this.total>0){
        const at=Math.floor((this.total-1)/CHUNK)*CHUNK;
        const size=this.total-at;
        const r=await remote.read(this.owner.targetDeviceId,this.owner.targetPath,at,size);
        if(r.sourceBytes!==this.total || r.offsetBytes!==at ||
           r.bytesRead!==size || typeof r.contentBase64!=='string' ||
           r.contentBase64.length>87384 ||
           !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(r.contentBase64))return this.invalidateReadback();
        const bytes=Buffer.from(r.contentBase64,'base64');
        if(bytes.length!==size||bytes.toString('base64')!==r.contentBase64)
          return this.invalidateReadback();
        this.readbackChunkSha256=createHash('sha256').update(bytes).digest('hex');
      }
      const after=await remote.stat(this.owner.targetDeviceId,this.owner.targetPath);
      const finalDigest=(await remote.hash(this.owner.targetDeviceId,
        this.owner.targetPath,NATIVE_HASH_LIMIT)).toLowerCase();
      if(finalDigest!==this.sha256 || after.type!=='file'||after.size!==before.size ||
         (before.modifiedAt!==undefined && before.modifiedAt!==after.modifiedAt) ||
         expectedId!==this.transferId || expectedStatus!==this.lastStatusTime ||
         this.phase!=='COMPLETED'||this.lostWorker)return this.invalidateReadback();
      this.readbackAt=this.now();
      return true;
    }catch{return this.invalidateReadback();}
  }
  private invalidateReadback():false {this.readbackAt=null;this.readbackChunkSha256=null;return false;}
  snapshot(){
    const age=this.readbackAt===null?Number.POSITIVE_INFINITY:this.now()-this.readbackAt;
    const fresh=this.phase==='COMPLETED'&&!this.lostWorker && age>=0&&age<=PROOF_FRESH_MS;
    return {
      requestId:this.owner.requestId,transferId:this.transferId,phase:this.phase,
      bytesTotal:this.total,bytesConfirmedReceipt:this.confirmed,
      receiptChunkCount:Math.ceil(this.confirmed/CHUNK),
      expectedChunks:this.total===null?null:Math.ceil(this.total/CHUNK),
      lastConfirmedProgressAt:new Date(this.progressAt).toISOString(),
      lastReceiptAt:this.lastStatusTime?new Date(this.lastStatusTime).toISOString():null,
      resumeOffset:this.resumedFrom,sha256:this.sha256,
      publicationReported:this.publicationReported,
      readbackVerified:fresh,
      readbackSha256:fresh?this.sha256:null,
      lastReadbackChunkSha256:fresh?this.readbackChunkSha256:null,
      storageBytesVerified:fresh?this.confirmed:null,
      atomicNoOverwriteVerified:false,
      workerCompletedVerified:false,
      workerReportedCompleted:this.reportedWorkerCompleted,
      mutationUnknown:['MUTATION_UNKNOWN','RECOVERY_REQUIRED'].includes(this.phase),
      automaticReplayAllowed:false,
      warning:this.warning(),
    } as const;
  }
}
