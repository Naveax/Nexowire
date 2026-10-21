/**
 * S5/#596 receipt METADATA-only rolling audit.
 * This is not an Artifact Bridge receipt authority or independent file hash.
 * Does not execute any file or Agent method; requires separately attested bytes.
 */
import {createHash,type Hash} from 'node:crypto';
export const S5_TRANSFER_CHUNK_BYTES=65536;
export type S5TransferIdentity=Readonly<{
  accountId:string;transferId:string;sourceDeviceId:string;
  targetDeviceId:string;epoch:number;expectedBytes:number;
}>;
export type S5ChunkReceipt=Readonly<{
  accountId:string;transferId:string;sourceDeviceId:string;
  targetDeviceId:string;epoch:number;
  offsetBytes:number;receivedBytes:number;
  senderChunkSha256:string;receiverChunkSha256:string;
  latencyMs:number;
}>;
type S5ApplyStatus='RECORDED_UNVERIFIED'|'DUPLICATE_UNVERIFIED';
const id=(v:string)=>typeof v==='string'&&/^[a-zA-Z0-9_.:@-]{8,160}$/.test(v);
const hash=(v:string)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function validateS5TransferIdentity(i:S5TransferIdentity){
  if(!i||!id(i.accountId)||!id(i.transferId)||!id(i.sourceDeviceId)||
    !id(i.targetDeviceId)||i.sourceDeviceId===i.targetDeviceId||
    !Number.isSafeInteger(i.epoch)||i.epoch<1||
    !Number.isSafeInteger(i.expectedBytes)||i.expectedBytes<1||
    i.expectedBytes>4*1024*1024*1024){
    throw new Error('S5 untrusted chunk transfer identity/scope');
  }
}
export class S5RollingChunkReceiptAudit{
  private offset=0;
  private count=0;
  private last:S5ChunkReceipt|null=null;
  private readonly chain:Hash=createHash('sha256');
  private readonly latencies:number[]=[];
  constructor(private readonly identity:S5TransferIdentity){validateS5TransferIdentity(identity)}
  record(r:S5ChunkReceipt):S5ApplyStatus {
    const i=this.identity;
    if(!r||r.accountId!==i.accountId||r.transferId!==i.transferId||
      r.sourceDeviceId!==i.sourceDeviceId||r.targetDeviceId!==i.targetDeviceId||
      r.epoch!==i.epoch)throw new Error('S5 cross-tenant/device/epoch receipt rejected');
    if(!Number.isSafeInteger(r.offsetBytes)||r.offsetBytes<0||
       !Number.isSafeInteger(r.receivedBytes)||r.receivedBytes<1||
       r.receivedBytes>S5_TRANSFER_CHUNK_BYTES||
       !hash(r.senderChunkSha256)||!hash(r.receiverChunkSha256)||
       r.senderChunkSha256!==r.receiverChunkSha256||
       !Number.isFinite(r.latencyMs)||r.latencyMs<0||r.latencyMs>60000){
      throw new Error('S5 malformed/sha-mismatched/oversized chunk receipt');
    }
    if(r.offsetBytes!==this.offset){
      if(this.last&&r.offsetBytes===this.last.offsetBytes&&
         r.receivedBytes===this.last.receivedBytes&&
         r.senderChunkSha256===this.last.senderChunkSha256&&
         r.receiverChunkSha256===this.last.receiverChunkSha256){
        return 'DUPLICATE_UNVERIFIED';
      }
      throw new Error('S5 offset conflict or out-of-order receipt');
    }
    if(this.offset+r.receivedBytes>i.expectedBytes){
      throw new Error('S5 exceeds bounded target object bytes');
    }
    // The last chunk can be smaller, all other chunks must be 64 KiB.
    if(this.offset+r.receivedBytes<i.expectedBytes&&r.receivedBytes!==S5_TRANSFER_CHUNK_BYTES){
      throw new Error('S5 partial nonterminal chunk');
    }
    this.chain.update(r.offsetBytes.toString()+':'+r.receivedBytes.toString()+':'+
      r.senderChunkSha256+':'+r.epoch.toString()+'\n');
    this.last=r;
    this.offset+=r.receivedBytes;
    this.count++;
    // Strictly bounded sample memory; non-sampled counts stay accurate.
    if(this.latencies.length<1024)this.latencies.push(r.latencyMs);
    return 'RECORDED_UNVERIFIED';
  }
  snapshot(){
    const samples=[...this.latencies].sort((a,b)=>a-b);
    const q=(p:number)=>samples.length?Number((samples[Math.ceil(samples.length*p)-1]??0).toFixed(3)):null;
    return {
      kind:'S5_UNTRUSTED_CHUNK_RECEIPT_METADATA' as const,
      requestBytes:this.identity.expectedBytes,
      accountedBytes:this.offset,
      expectedChunks:Math.ceil(this.identity.expectedBytes/S5_TRANSFER_CHUNK_BYTES),
      accountedChunks:this.count,
      lastOffsetBytes:this.last?.offsetBytes??null,
      p95MetadataLatencyMs:q(.95),
      p99MetadataLatencyMs:q(.99),
      receiptChainSha256SoFar:this.chain.copy().digest('hex'),
      allChunksReported:this.offset===this.identity.expectedBytes,
      independentlyVerifiedDiskHash:false as const,
      independentlyVerifiedNativeCompletion:false as const,
      actuallyTransferredBytesByThisAudit:0 as const,
      workDoneOutsideAgent:true as const,
      missingProof:[
        'Owner/device/session authority is only string equality with local test context',
        'Hashes are claimed metadata and not independently checked against target disk',
        'Full source+target SHA256 and signed durable CAS receipts must be verified by #08/#05/#06',
        'No staging WebSocket, Agent 1.0.5 update or persistent 1 GiB file accepted',
      ],
    };
  }
}
