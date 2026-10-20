/**
 * Adapter for #588 / proposed #596 one-call MCP transfer receipts.
 *
 * A Hub response is not equivalent to a durable object. The independently
 * authenticated ArtifactBridgeStore.get/readChunk calls are required to mark
 * storage verification; even then this is NEVER worker completed_verified.
 * No storage mutations or automatic retries occur here.
 */
import { createHash } from 'node:crypto';
import type { ArtifactBridgeStore, ArtifactScope } from '../workspace/artifact-bridge.js';

const HASH = /^[a-f0-9]{64}$/;
const CHUNK_BYTES = 65536;
const MAX_SIZE = Number.MAX_SAFE_INTEGER;
type Stage='pending'|'partial'|'reported_complete'|'storage_verified'|'canceled'|'mutation_unknown';
type IngestReceipt = {
  state:'PARTIAL'|'COMPLETE'|'ALREADY_PRESENT';
  sha256:string; size:number; offset:number; transferredBytes:number; artifactPath:string;
};
export interface OneCallTransferIdentity {
  scope:ArtifactScope;artifactPath:string;sha256:string;size:number;
  /** Chosen by the authenticated caller, not by arbitrary transfer stdout. */
  requestId:string;
}
export class OneCallTransferWatchdog {
  private stage:Stage='pending';
  private offset=0;
  private resumeOffset=0;
  private acknowledgedThisAttempt=0;
  private lastStorageChunkSha256:string|null=null;
  private lastStorageCheckedAt:string|null=null;
  private lastConfirmedProgressAt:number;
  private workerState:'unknown'|'running'|'exited'|'lost'='unknown';
  private workerExitCode:number|null=null;
  private reportedWorkerCompleted:number|null=null;
  private readonly identity:OneCallTransferIdentity;
  constructor(identity:OneCallTransferIdentity,private readonly now:()=>number=Date.now) {
    if (!identity || !HASH.test(identity.sha256) ||
        !Number.isSafeInteger(identity.size) || identity.size<0 || identity.size>MAX_SIZE ||
        typeof identity.requestId!=='string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(identity.requestId) ||
        !identity.artifactPath || !identity.scope?.accountId ||
        !identity.scope?.deviceId || !identity.scope?.projectId) {
      throw new Error('INVALID_ONE_CALL_TRANSFER_IDENTITY');
    }
    this.identity=structuredClone(identity);
    this.lastConfirmedProgressAt=this.now();
  }
  private reject(code:string):never {this.stage='mutation_unknown';throw new Error(code);}
  private validOffset(value:number):boolean {
    return Number.isSafeInteger(value) && value>=0 && value<=this.identity.size &&
      (value%CHUNK_BYTES===0 || value===this.identity.size);
  }
  /** A receipt without requestId must be correlated by the trusted caller. */
  observeIngestReceipt(receipt:IngestReceipt):void {
    if (this.stage==='canceled'||this.stage==='mutation_unknown'||this.stage==='storage_verified') {
      this.reject('TRANSFER_RECONCILIATION_REQUIRED');
    }
    if (!receipt || receipt.sha256!==this.identity.sha256 ||
        receipt.size!==this.identity.size || receipt.artifactPath!==this.identity.artifactPath ||
        !this.validOffset(receipt.offset) ||
        !Number.isSafeInteger(receipt.transferredBytes) || receipt.transferredBytes<0 ||
        receipt.transferredBytes>this.identity.size) this.reject('INGEST_RECEIPT_MISMATCH');
    const previous=this.offset;
    if (receipt.state==='ALREADY_PRESENT') {
      if (receipt.offset!==receipt.size||receipt.transferredBytes!==0)
        this.reject('INGEST_ALREADY_PRESENT_MISMATCH');
      this.offset=receipt.offset;this.stage='reported_complete';
      return;
    }
    if (receipt.offset<previous ||
        receipt.offset-previous!==receipt.transferredBytes ||
        (receipt.state==='PARTIAL' && receipt.offset===receipt.size) ||
        (receipt.state==='COMPLETE' && receipt.offset!==receipt.size)) {
      this.reject('INGEST_OFFSET_OR_PROGRESS_MISMATCH');
    }
    this.offset=receipt.offset;
    if(receipt.transferredBytes>0)this.lastConfirmedProgressAt=this.now();
    this.acknowledgedThisAttempt+=receipt.transferredBytes;
    this.stage=receipt.state==='COMPLETE'?'reported_complete':'partial';
  }
  /** Resume cannot trust a reported offset; only an independent store receipt. */
  observeTrustedResumeOffset(offset:number):void {
    if (this.stage!=='pending') this.reject('RESUME_REQUIRES_NEW_EPOCH');
    if (!this.validOffset(offset)) this.reject('INVALID_STORAGE_RESUME_OFFSET');
    this.offset=offset;this.resumeOffset=offset;
    this.lastConfirmedProgressAt=this.now();
  }
  /** Proposed status/cancel API is not yet implemented by #596/#597. */
  observeStatusReceipt(receipt:{
    requestId:string;state:'pending'|'partial'|'complete'|'canceled'|'unknown';
    offset:number;size:number;sha256:string;
  }):void {
    if (!receipt || receipt.requestId!==this.identity.requestId ||
        receipt.sha256!==this.identity.sha256 || receipt.size!==this.identity.size ||
        !this.validOffset(receipt.offset) || receipt.offset<this.offset) {
      this.reject('TRANSFER_STATUS_SCOPE_OR_OFFSET_MISMATCH');
    }
    if (this.stage==='canceled'||this.stage==='storage_verified') this.reject('TRANSFER_TERMINAL');
    if (this.stage==='mutation_unknown' && receipt.state!=='unknown') {
      // Explicitly reconciled remote status is still not immutable proof.
      this.offset=receipt.offset;
      this.stage=receipt.state==='canceled'?'canceled':
        receipt.state==='complete'&&receipt.offset===receipt.size?'reported_complete':'partial';
      return;
    }
    if(receipt.state==='unknown'){this.stage='mutation_unknown';return;}
    if(receipt.state==='canceled'){this.offset=receipt.offset;this.stage='canceled';return;}
    if(receipt.state==='complete') {
      if(receipt.offset!==receipt.size)this.reject('TRANSFER_COMPLETION_OFFSET_MISMATCH');
      this.offset=receipt.offset;this.stage='reported_complete';return;
    }
    if(receipt.offset>this.offset)this.lastConfirmedProgressAt=this.now();
    this.offset=receipt.offset;
    this.stage=receipt.state==='pending'?'pending':'partial';
  }
  observeCancelReceipt(receipt:{requestId:string;canceled:boolean;offset:number}):void {
    if (!receipt || receipt.requestId!==this.identity.requestId ||
        receipt.canceled!==true || !this.validOffset(receipt.offset) ||
        receipt.offset<this.offset || this.stage==='storage_verified') {
      this.reject('UNTRUSTED_CANCEL_RECEIPT');
    }
    this.offset=receipt.offset;this.stage='canceled';
  }
  markMutationUnknown():void {if(this.stage!=='storage_verified')this.stage='mutation_unknown';}
  /** Worker PID/counters cannot provide storage or task-completion proof. */
  observeWorkerSignal(signal:{state:'running'|'exited'|'lost';exitCode?:number|null;reportedCompleted?:number}):void {
    if(!signal || (signal.exitCode!==undefined && signal.exitCode!==null &&
        !Number.isSafeInteger(signal.exitCode)) ||
        (signal.reportedCompleted!==undefined &&
         (!Number.isSafeInteger(signal.reportedCompleted) || signal.reportedCompleted<0))) {
      this.reject('INVALID_WORKER_SIGNAL');
    }
    if(this.workerState==='lost' && signal.state!=='lost')return;
    if(signal.state==='lost') {
      this.workerState='lost';this.workerExitCode=null;
      if(this.stage!=='storage_verified')this.stage='mutation_unknown';
    }else{
      this.workerState=signal.state;
      this.workerExitCode=signal.state==='exited'?(signal.exitCode??null):null;
    }
    if(signal.reportedCompleted!==undefined)this.reportedWorkerCompleted=signal.reportedCompleted;
  }
  watchdogWarning(stallAfterMs=30000):'NO_STORAGE_PROGRESS'|'WORKER_PID_LOST'|'MUTATION_UNKNOWN'|null {
    if(this.workerState==='lost')return 'WORKER_PID_LOST';
    if(this.stage==='mutation_unknown')return 'MUTATION_UNKNOWN';
    if ((this.stage==='partial'||this.stage==='pending') &&
        this.now()-this.lastConfirmedProgressAt>=stallAfterMs)return 'NO_STORAGE_PROGRESS';
    return null;
  }

  /**
   * Recheck actual content with store.get AND pinned-handle readChunk.
   * Store itself recomputes the full object digest; a syntactically valid
   * manifest alone is insufficient. This does not attest application work.
   */
  async verifyStorage(store:Pick<ArtifactBridgeStore,'get'|'readChunk'>):Promise<boolean> {
    if (this.stage!=='reported_complete' && this.stage!=='storage_verified')return false;
    try {
      const manifest=await store.get(this.identity.scope,this.identity.artifactPath);
      if (!manifest || manifest.size!==this.identity.size ||
          manifest.sha256!==this.identity.sha256 ||
          manifest.artifactPath!==this.identity.artifactPath ||
          manifest.scope.accountId!==this.identity.scope.accountId ||
          manifest.scope.projectId!==this.identity.scope.projectId ||
          manifest.scope.deviceId!==this.identity.scope.deviceId) {
        return this.failStorageVerification();
      }
      if (this.identity.size>0){
        const offset=Math.floor((this.identity.size-1)/CHUNK_BYTES)*CHUNK_BYTES;
        const read=await store.readChunk(this.identity.scope,this.identity.artifactPath,offset,CHUNK_BYTES);
        if(read.offset!==offset || read.totalSize!==this.identity.size ||
           read.sha256!==this.identity.sha256 ||
           read.size!==Math.min(CHUNK_BYTES,this.identity.size-offset) ||
           !HASH.test(read.chunkSha256) ||
           !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(read.contentBase64)){
          return this.failStorageVerification();
        }
        const bytes=Buffer.from(read.contentBase64,'base64');
        if(bytes.length!==read.size ||
           bytes.toString('base64')!==read.contentBase64 ||
           createHash('sha256').update(bytes).digest('hex')!==read.chunkSha256){
          return this.failStorageVerification();
        }
        this.lastStorageChunkSha256=read.chunkSha256;
      }
      this.lastStorageCheckedAt=new Date(this.now()).toISOString();
      this.stage='storage_verified';
      return true;
    }catch{return this.failStorageVerification();}
  }
  private failStorageVerification():false {
    this.stage='mutation_unknown';
    this.lastStorageChunkSha256=null;
    this.lastStorageCheckedAt=null;
    return false;
  }
  snapshot(){
    const age=this.lastStorageCheckedAt===null?Number.POSITIVE_INFINITY:
      this.now()-Date.parse(this.lastStorageCheckedAt);
    const fresh=this.stage==='storage_verified' && age>=0 && age<=30000;
    return {
      requestId:this.identity.requestId,
      stage:this.stage==='storage_verified'&&!fresh?'storage_stale':this.stage,
      transferSize:this.identity.size,sha256:this.identity.sha256,
      receiptBytes:this.offset,confirmedStorageBytes:fresh?this.offset:null,
      byteProgressUnverified:!fresh,
      chunkBytes:CHUNK_BYTES,receiptChunkCount:Math.ceil(this.offset/CHUNK_BYTES),
      expectedChunks:Math.ceil(this.identity.size/CHUNK_BYTES),
      newlyAcknowledgedBytes:this.acknowledgedThisAttempt,resumeOffset:this.resumeOffset,
      lastVerifiedChunkSha256:this.lastStorageChunkSha256,
      lastStorageCheckedAt:this.lastStorageCheckedAt,
      storageVerified:fresh,
      workerCompletedVerified:false,
      workerState:this.workerState,workerExitCode:this.workerExitCode,
      reportedWorkerCompletedUnverified:this.reportedWorkerCompleted,
      lastConfirmedProgressAt:new Date(this.lastConfirmedProgressAt).toISOString(),
      watchdogWarning:this.watchdogWarning(),
      outputEvidence:'NOT_PROVIDED_BY_TRANSFER_RECEIPT',
      mutationUnknown:this.stage==='mutation_unknown',
      automaticReplayAllowed:false,
    } as const;
  }
}
