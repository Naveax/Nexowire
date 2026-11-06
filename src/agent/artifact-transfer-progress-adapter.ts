/**
 * Read-only observer of real ArtifactBridgeStore operation receipts (#588).
 * This does NOT implement storage, transport, retries or automatic replay.
 */
import { createHash } from 'node:crypto';
import type { ArtifactManifest, ArtifactScope } from '../workspace/artifact-bridge.js';

const SHA = /^[0-9a-f]{64}$/;
const CHUNK_BYTES = 65536;
const MAX_SIZE = 268435456;
type TransferState = 'uninitialized'|'uploading'|'complete'|'mutation_unknown';
export interface TransferIdentity {
  scope: ArtifactScope;
  artifactPath: string;
  producerOperationId: string;
  sha256: string;
  size: number;
}
type BeginReceipt = {state:'OPEN'|'ALREADY_PRESENT';offset:number;sessionId?:string;manifest?:ArtifactManifest};
type ChunkReceipt = {state:'WRITTEN'|'ALREADY_WRITTEN';offset:number};

export class ArtifactTransferProgressAdapter {
  private state: TransferState = 'uninitialized';
  private offset = 0;
  private sessionId: string | null = null;
  private lastChunkSha256: string | null = null;
  private acknowledgedChunks = 0;
  private resumeOffset = 0;
  private readonly identity: TransferIdentity;
  constructor(identity: TransferIdentity) {
    if (!SHA.test(identity.sha256) || !Number.isSafeInteger(identity.size) ||
        identity.size < 0 || identity.size > MAX_SIZE ||
        !identity.artifactPath || !identity.producerOperationId ||
        !identity.scope?.accountId || !identity.scope?.deviceId || !identity.scope?.projectId) {
      throw new Error('INVALID_TRANSFER_IDENTITY');
    }
    this.identity = structuredClone(identity);
  }
  private invalid(code:string):never {
    this.state='mutation_unknown';
    throw new Error(code);
  }
  private checkOffset(offset:number):boolean {
    return Number.isSafeInteger(offset) && offset>=0 && offset<=this.identity.size &&
      (offset%CHUNK_BYTES===0 || offset===this.identity.size);
  }
  private manifestMatches(manifest:ArtifactManifest):boolean {
    const scope=this.identity.scope, observed=manifest.scope;
    return manifest.size===this.identity.size && manifest.sha256===this.identity.sha256 &&
      manifest.artifactPath===this.identity.artifactPath &&
      manifest.producerOperationId===this.identity.producerOperationId &&
      observed.accountId===scope.accountId && observed.projectId===scope.projectId &&
      observed.deviceId===scope.deviceId;
  }
  /** Caller must invoke store.begin explicitly and supply its actual receipt. */
  observeBegin(receipt:BeginReceipt):void {
    if (this.state!=='uninitialized') this.invalid('DUPLICATE_BEGIN_REQUIRES_RECONCILIATION');
    if (!this.checkOffset(receipt.offset)) this.invalid('UNTRUSTED_BEGIN_OFFSET');
    if (receipt.state==='ALREADY_PRESENT') {
      if (receipt.offset!==this.identity.size || !receipt.manifest ||
          !this.manifestMatches(receipt.manifest)) this.invalid('UNTRUSTED_COMPLETE_MANIFEST');
      this.state='complete';this.offset=receipt.offset;this.resumeOffset=receipt.offset;
      this.acknowledgedChunks=Math.ceil(receipt.offset/CHUNK_BYTES);
    } else {
      if (!receipt.sessionId || !SHA.test(receipt.sessionId)) this.invalid('UNTRUSTED_BEGIN_SESSION');
      this.sessionId=receipt.sessionId;this.offset=receipt.offset;this.resumeOffset=receipt.offset;
      this.acknowledgedChunks=Math.ceil(receipt.offset/CHUNK_BYTES);
      this.state='uploading';
    }
  }
  /** Must be invoked only AFTER the actual store.putChunk resolves successfully. */
  observeChunk(sessionId:string, offset:number, content:Buffer, receipt:ChunkReceipt):void {
    if (this.state!=='uploading') this.invalid('TRANSFER_NOT_ACTIVE');
    if (this.sessionId!==sessionId || !Buffer.isBuffer(content) ||
        content.length<1 || content.length>CHUNK_BYTES ||
        offset!==this.offset || offset+content.length>this.identity.size ||
        !this.checkOffset(offset+content.length) ||
        receipt.state!=='WRITTEN' ||
        receipt.offset!==offset+content.length) this.invalid('UNTRUSTED_CHUNK_RECEIPT');
    this.offset=receipt.offset;
    this.acknowledgedChunks++;
    this.lastChunkSha256=createHash('sha256').update(content).digest('hex');
  }
  /** Safe duplicate chunk acknowledgment; never count it as new output. */
  observeAlreadyWritten(sessionId:string, offset:number, content:Buffer, receipt:ChunkReceipt):void {
    if (this.state!=='uploading' || this.sessionId!==sessionId ||
        receipt.state!=='ALREADY_WRITTEN' || !Buffer.isBuffer(content) ||
        content.length<1 || content.length>CHUNK_BYTES ||
        offset<0 || offset+content.length>this.offset ||
        receipt.offset!==this.offset) this.invalid('UNTRUSTED_REPLAY_RECEIPT');
    // Store validates the supplied bytes against persisted chunk digest.
    // An acknowledged replay is not a second completed write.
  }
  /** Compare the real store.commit result against pinned scope and final hash. */
  observeCommit(sessionId:string, manifest:ArtifactManifest):void {
    if (this.state!=='uploading' || sessionId!==this.sessionId ||
        this.offset!==this.identity.size || !this.manifestMatches(manifest)) {
      this.invalid('UNTRUSTED_COMMIT_MANIFEST');
    }
    this.state='complete';
  }
  /** Ambiguous lost mutation response must be reconciled externally; NO replay. */
  markUnknown():void { if(this.state!=='complete')this.state='mutation_unknown'; }
  snapshot() {
    const size=this.identity.size;
    return {
      state:this.state,chunkSize:CHUNK_BYTES,sha256:this.identity.sha256,
      artifactPath:this.identity.artifactPath,
      confirmedOffset:this.offset,resumeOffset:this.resumeOffset,
      acknowledgedChunks:this.acknowledgedChunks,
      confirmedBytes:this.offset,remainingBytes:size-this.offset,
      expectedChunks:Math.ceil(size/CHUNK_BYTES),
      lastAcknowledgedChunkSha256:this.lastChunkSha256,
      storageConfirmed:this.state==='complete',
      progressVerifiedByStorageReceipt:this.state==='complete',
      mutationState:this.state==='mutation_unknown'?'UNKNOWN':'KNOWN',
      automaticReplayAllowed:false,
      source:'artifact_bridge_store_receipts_not_worker_stdout',
    } as const;
  }
}
