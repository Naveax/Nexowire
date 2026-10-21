import {createHash,timingSafeEqual} from 'node:crypto';

/**
 * STAGING-ONLY WSS stream flow-controller. #588 / #08 owns the durable
 * artifact store, resume CAS, actual wire codec and on-disk hash validation.
 * This adapter does NOT attach to quota WSS (16 KiB max), Agent or Broker.
 */
export const OWNER_WSS_CHUNK_BYTES=65_536;
export const OWNER_WSS_BUFFERED_LIMIT=131_072;
export const OWNER_WSS_CHUNKS_PER_CALL=32;
const ID=/^[A-Za-z0-9_:.@-]{8,128}$/;
const SHA=/^[a-f0-9]{64}$/;
export interface OwnerWssTransferScope {
  ownerId:string;deviceId:string;projectId:string;sessionId:string;
}
export interface OwnerWssTransferGrant extends OwnerWssTransferScope {
  status:'active'|'revoked';
  revision:number;totalBytes:number;sourceSha256:string;sourceIdentity:string;
}
export interface OwnerWssTransferReceipt extends OwnerWssTransferScope {
  revision:number;sourceSha256:string;committedOffset:number;
}
export interface OwnerWssSourceSnapshot {
  totalBytes:number;sourceSha256:string;sourceIdentity:string;
}
export interface OwnerWssChunkFrame extends OwnerWssTransferScope {
  revision:number;
  offset:number;
  totalBytes:number;
  sourceSha256:string;
  chunkSha256:string;
  bytes:Uint8Array;
}
export interface OwnerWssChunkAck extends OwnerWssTransferScope {
  revision:number;sourceSha256:string;committedOffset:number;
}
export interface OwnerWssStreamDependencies {
  /** Trusted server side grants, not customer-provided envelope fields. */
  readGrant():Promise<OwnerWssTransferGrant>;
  /** Trusted durable commit offset, owner/device/project/session-scoped. */
  readReceipt():Promise<OwnerWssTransferReceipt>;
  /** Pinned source identity, owned by #08/#05 file-safe source layer. */
  sourceSnapshot():Promise<OwnerWssSourceSnapshot>;
  readSource(offset:number,length:number):Promise<Uint8Array>;
  /** Buffered output at the authenticated WSS transport. */
  bufferedAmount():number;
  sendChunk(frame:OwnerWssChunkFrame):Promise<OwnerWssChunkAck>;
}
export interface OwnerWssStreamResult {
  state:'PARTIAL'|'COMPLETE'|'BACKPRESSURE'|'UNKNOWN';
  committedOffset:number;
  sentChunks:number;
  /** UNKNOWN MUST be reconciled against independent durable receipt. */
  autoReplayAllowed:false;
}
function fail(message:string):never{
  throw new Error('Owner WSS streaming denied: '+message);
}
function safeOffset(v:unknown):v is number{
  return Number.isSafeInteger(v)&&typeof v==='number'&&v>=0;
}
function validScope(x:OwnerWssTransferScope){
  return [x.ownerId,x.deviceId,x.projectId,x.sessionId].every(
    s=>typeof s==='string'&&ID.test(s));
}
function sameScope(a:OwnerWssTransferScope,b:OwnerWssTransferScope){
  return a.ownerId===b.ownerId&&a.deviceId===b.deviceId&&
    a.projectId===b.projectId&&a.sessionId===b.sessionId;
}
function hexEqual(a:string,b:string):boolean{
  return SHA.test(a)&&SHA.test(b)&&timingSafeEqual(
    Buffer.from(a,'hex'),Buffer.from(b,'hex'),
  );
}
function assertGrant(actual:OwnerWssTransferGrant,expected:OwnerWssTransferGrant){
  if(!actual||!validScope(actual)||!sameScope(actual,expected)||
    actual.status!=='active'||actual.revision!==expected.revision||
    !hexEqual(actual.sourceSha256,expected.sourceSha256)||
    actual.sourceIdentity!==expected.sourceIdentity||
    actual.totalBytes!==expected.totalBytes){
    fail('owner/device/session grant revoked or changed');
  }
}
function assertReceipt(
  receipt:OwnerWssTransferReceipt,grant:OwnerWssTransferGrant,
){
  if(!receipt||!sameScope(receipt,grant)||
    receipt.revision!==grant.revision||
    !hexEqual(receipt.sourceSha256,grant.sourceSha256)||
    !safeOffset(receipt.committedOffset)||
    receipt.committedOffset>grant.totalBytes){
    fail('independent durable receipt invalid or wrong scope');
  }
}
function assertSource(source:OwnerWssSourceSnapshot,grant:OwnerWssTransferGrant){
  if(!source||source.totalBytes!==grant.totalBytes||
    source.sourceIdentity!==grant.sourceIdentity||
    !hexEqual(source.sourceSha256,grant.sourceSha256)){
    fail('source changed during transfer');
  }
}
function result(
  state:OwnerWssStreamResult['state'],offset:number,sentChunks:number,
):OwnerWssStreamResult{
  return {state,committedOffset:offset,sentChunks,autoReplayAllowed:false};
}

/**
 * One in-flight chunk, max 64 KiB and 32 chunks/call. Backpressure yields
 * immediately without reading data; no unlimited buffering or spin-wait.
 *
 * A lost/late ACK is UNKNOWN, not a reason to replay. Callers may initiate a
 * NEW explicit attempt only after reading independently persisted state; the
 * next call starts from the authoritative receipt, never caller offsets.
 */
export async function advanceProposedOwnerWssBoundedTransfer(
  expectedScope:OwnerWssTransferScope,
  io:OwnerWssStreamDependencies,
  maxChunks=OWNER_WSS_CHUNKS_PER_CALL,
):Promise<OwnerWssStreamResult>{
  if(!expectedScope||!validScope(expectedScope)||
    !Number.isSafeInteger(maxChunks)||maxChunks<1||
    maxChunks>OWNER_WSS_CHUNKS_PER_CALL)fail('invalid scope or chunk budget');
  const grant=await io.readGrant();
  if(!grant||!sameScope(grant,expectedScope)||!validScope(grant)||
    grant.status!=='active'||!safeOffset(grant.revision)||
    grant.revision<1||!safeOffset(grant.totalBytes)||
    !SHA.test(grant.sourceSha256)||
    typeof grant.sourceIdentity!=='string'||
    grant.sourceIdentity.length<8||grant.sourceIdentity.length>256){
    fail('independent grant unavailable, revoked, or outside scope');
  }
  assertSource(await io.sourceSnapshot(),grant);
  const starting=await io.readReceipt();
  assertReceipt(starting,grant);
  let offset=starting.committedOffset;
  let sent=0;
  while(offset<grant.totalBytes&&sent<maxChunks){
    assertGrant(await io.readGrant(),grant);
    const current=await io.readReceipt();
    assertReceipt(current,grant);
    if(current.committedOffset!==offset){
      fail('durable offset changed concurrently; no automatic replay');
    }
    const length=Math.min(OWNER_WSS_CHUNK_BYTES,grant.totalBytes-offset);
    const buffered=io.bufferedAmount();
    if(!safeOffset(buffered)||
      buffered+length>OWNER_WSS_BUFFERED_LIMIT){
      return result('BACKPRESSURE',offset,sent);
    }
    assertSource(await io.sourceSnapshot(),grant);
    const chunk=await io.readSource(offset,length);
    if(!(chunk instanceof Uint8Array)||chunk.byteLength!==length){
      fail('source chunk truncated or exceeded per-frame limit');
    }
    assertSource(await io.sourceSnapshot(),grant);
    // A second producer may have committed while source.readSource awaited.
    // Re-check server durable CAS before transmitting a potentially stale frame.
    assertGrant(await io.readGrant(),grant);
    const afterRead=await io.readReceipt();
    assertReceipt(afterRead,grant);
    if(afterRead.committedOffset!==offset){
      fail('durable offset changed during source read; no replay');
    }
    // Own the bytes: a custom source must not retain mutable frame memory.
    const owned=Buffer.from(chunk);
    const frame:OwnerWssChunkFrame={
      ownerId:grant.ownerId,deviceId:grant.deviceId,
      projectId:grant.projectId,sessionId:grant.sessionId,
      revision:grant.revision,offset,totalBytes:grant.totalBytes,
      sourceSha256:grant.sourceSha256,
      chunkSha256:createHash('sha256').update(owned).digest('hex'),
      bytes:owned,
    };
    try{
      const ack=await io.sendChunk(frame);
      if(!ack||!sameScope(ack,grant)||
        ack.revision!==grant.revision||
        !hexEqual(ack.sourceSha256,grant.sourceSha256)||
        ack.committedOffset!==offset+length){
        // Transmission may already have committed; do not retry.
        return result('UNKNOWN',offset,sent);
      }
    }catch{
      return result('UNKNOWN',offset,sent);
    }
    // Owner authority/revocation and durable CAS must still hold AFTER ACK.
    assertGrant(await io.readGrant(),grant);
    const receipt=await io.readReceipt();
    assertReceipt(receipt,grant);
    if(receipt.committedOffset!==offset+length){
      return result('UNKNOWN',offset,sent);
    }
    offset+=length;
    sent++;
  }
  return result(offset===grant.totalBytes?'COMPLETE':'PARTIAL',offset,sent);
}
