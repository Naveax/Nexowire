import {createPublicKey,verify,randomBytes,type KeyObject} from 'node:crypto';
import * as z from 'zod';
import type {AuthenticatedGrantScope} from './postgres-bound-grant-cas.js';
import {WitnessAuthorityError} from './postgres-monotonic-witness.js';

const uuid=z.string().uuid();
const scopeSchema=z.object({
  ownerId:uuid,deviceId:uuid,deviceEpoch:uuid,sessionEpoch:uuid,
  ownerEpoch:z.number().int().positive().safe(),
  expectedGeneration:z.number().int().positive().safe(),
  requiredPrivilege:z.enum(['CORE','ROOT']),
}).strict();
const operation=z.object({
  requestId:uuid,fingerprint:z.string().regex(/^[0-9a-f]{64}$/),
  capability:z.string().min(1).max(128),
  scope:scopeSchema,
}).strict();
export type BrokerDispatchRequest=z.infer<typeof operation>;
export interface ProtectedBrokerEvidence {
  verified:true;
  brokerId:string;
  /** Separately authenticated native owner epoch; Access UI state is not proof. */
  ownerEpoch:number;
  grantGeneration:number;
  highIntegrityToken:true;
  signedProtectedImage:true;
  protectedParentAndImports:true;
}
export interface DispatchClaim {
  /** Authenticated signed receipt from the independent external CAS. */
  payload:string;
  signature:string;
}
export interface DispatchRevokeRequest {
  deviceId:string;ownerId:string;deviceEpoch:string;sessionEpoch:string;
  expectedGeneration:number;signedOwnerApproval:string;
}
/**
 * Scoped release of an existing dispatch admission. Revoke may already have
 * invalidated the live owner credential: the remote authority MUST match the
 * immutable reserved claim, rather than accepting dispatchId alone or
 * reauthorizing a revoked grant. No retry after an unknown release outcome.
 */
export interface DispatchReleaseRequest {
  dispatchId:string;
  brokerId:string;
  request:BrokerDispatchRequest;
}
export interface ExternalBrokerDispatchAuthority {
  /**
   * Atomically serialize against revoke/re-pair and allocate a single-use
   * claim. Before acknowledging a reservation, persist an independent durable
   * tombstone keyed by the immutable requestId and bind it to the complete
   * request and Broker scope. Repeated begin calls for that requestId,
   * including after a lost ACK, restart, failover or restore, MUST reject or
   * return a non-authorizing UNKNOWN outcome; they MUST NEVER mint a new
   * dispatchId or permit, even with a fresh challengeNonce. Release cannot
   * delete the tombstone. Reconcile an unknown outcome by inspection; never
   * replay it as a new mutation or substitute a fresh requestId. Missing or
   * ambiguous authority state fails closed.
   */
  beginIfCurrent(operation:BrokerDispatchRequest,
    broker:ProtectedBrokerEvidence,challengeNonce:string):Promise<DispatchClaim>;
  /**
   * Remote atomic linearization of actual effect ADMISSION against
   * revokeAndDrain. A pre-revoke RESERVED claim is not executable.
   */
  commitIfCurrent(operation:BrokerDispatchRequest,
    broker:ProtectedBrokerEvidence,dispatchId:string,
    challengeNonce:string):Promise<DispatchClaim>;
  /**
   * Revoke and fence NEW claims immediately. Return only after all
   * previously admitted claims finish, or return UNKNOWN without replay.
   */
  revokeAndDrain(request:DispatchRevokeRequest):Promise<DispatchClaim>;
  /** Release a claim. Lost ACK is UNKNOWN, never execute the effect again. */
  release(release:DispatchReleaseRequest):Promise<void>;
}
const permit=z.object({
  kind:z.literal('broker_dispatch_permit_v1'),
  authorityId:uuid,brokerId:uuid,dispatchId:uuid,
  challengeNonce:z.string().regex(/^[0-9a-f]{64}$/),
  requestId:uuid,fingerprint:z.string().regex(/^[0-9a-f]{64}$/),
  capability:z.string().min(1).max(128),
  ownerId:uuid,deviceId:uuid,deviceEpoch:uuid,sessionEpoch:uuid,
  ownerEpoch:z.number().int().positive().safe(),
  generation:z.number().int().positive().safe(),
  privilege:z.enum(['CORE','ROOT']),
  issuedAtMs:z.number().int().positive().safe(),
  expiresAtMs:z.number().int().positive().safe(),
}).strict();
const committed=permit.extend({
  kind:z.literal('broker_dispatch_commit_v1'),
}).strict();
const revoked=z.object({
  kind:z.literal('broker_dispatch_revocation_v1'),
  authorityId:uuid,deviceId:uuid,ownerId:uuid,deviceEpoch:uuid,
  sessionEpoch:uuid,previousGeneration:z.number().int().positive().safe(),
  generation:z.number().int().positive().safe(),
  drained:z.literal(true),revoked:z.literal(true),
}).strict();
type Permit=z.infer<typeof permit>;
type Commit=z.infer<typeof committed>;
type RevokeProof=z.infer<typeof revoked>;
function deny(code:string):never{throw new WitnessAuthorityError(code)}
/** Source gate: does not modify #03/#04 Broker/Access owner implementation. */
export class BrokerExternalDispatchFence {
  private readonly publicKey:KeyObject;
  private readonly inFlight=new Map<string,string>();
  private readonly claimed=new Set<string>();
  private readonly locallyFenced=new Set<string>();
  constructor(private readonly config:{
    authority:ExternalBrokerDispatchAuthority;
    authorityId:string;
    publicKeyPem:string;maxPermitMs?:number;
    now?:()=>number;
    /** Protected host must authenticate the calling device/session, not UI. */
    verifyIdentity:(request:BrokerDispatchRequest)=>Promise<boolean>;
    /** Must attest REAL signed, high-integrity Windows Broker + protected ACL. */
    verifyEffectiveBroker:()=>Promise<ProtectedBrokerEvidence>;
    /** Verify an exact short-lived owner-signed revoke approval. */
    verifyOwnerRevocation:(request:DispatchRevokeRequest)=>Promise<boolean>;
  }){
    if(!uuid.safeParse(config.authorityId).success)deny('DISPATCH_AUTHORITY_INVALID');
    this.publicKey=createPublicKey(config.publicKeyPem);
    if(this.publicKey.asymmetricKeyType!=='ed25519')
      deny('DISPATCH_SIGNING_KEY_INVALID');
  }
  private now():number{return (this.config.now??Date.now)()}
  /** Refresh native Broker evidence after every remote CAS await before effect admission. */
  private async verifyBrokerFor(request:BrokerDispatchRequest,
    expectedBrokerId?:string):Promise<ProtectedBrokerEvidence>{
    let broker:ProtectedBrokerEvidence;
    try{broker=await this.config.verifyEffectiveBroker()}
    catch{return deny('DISPATCH_EFFECTIVE_BROKER_UNAVAILABLE')}
    if(!broker||broker.verified!==true||
       !uuid.safeParse(broker.brokerId).success||
       broker.highIntegrityToken!==true||
       broker.signedProtectedImage!==true||
       broker.protectedParentAndImports!==true||
       (expectedBrokerId!==undefined&&broker.brokerId!==expectedBrokerId))
      deny('DISPATCH_HIGH_TOKEN_UNVERIFIED');
    if(broker.ownerEpoch!==request.scope.ownerEpoch||
       broker.grantGeneration!==request.scope.expectedGeneration)
      deny('DISPATCH_OWNER_EPOCH_MISMATCH');
    return broker;
  }
  private decode(raw:DispatchClaim):unknown {
    if(typeof raw?.payload!=='string'||raw.payload.length>4096||
       typeof raw?.signature!=='string'||raw.signature.length>1024)
      deny('DISPATCH_PROOF_INVALID');
    let bytes:Buffer,signature:Buffer;
    try{
      bytes=Buffer.from(raw.payload,'base64url');
      signature=Buffer.from(raw.signature,'base64url');
      if(bytes.toString('base64url')!==raw.payload||
         signature.toString('base64url')!==raw.signature||
         signature.length!==64||
         !verify(null,bytes,this.publicKey,signature))
        deny('DISPATCH_SIGNATURE_UNTRUSTED');
      return JSON.parse(bytes.toString('utf8')) as unknown;
    }catch{return deny('DISPATCH_SIGNATURE_UNTRUSTED')}
  }
  private checkPermit(value:unknown,req:BrokerDispatchRequest,
    broker:ProtectedBrokerEvidence,challengeNonce:string):Permit;
  private checkPermit(value:unknown,req:BrokerDispatchRequest,
    broker:ProtectedBrokerEvidence,challengeNonce:string,
    mode:'reserve'):Permit;
  private checkPermit(value:unknown,req:BrokerDispatchRequest,
    broker:ProtectedBrokerEvidence,challengeNonce:string,
    mode:'commit'):Commit;
  private checkPermit(value:unknown,req:BrokerDispatchRequest,
    broker:ProtectedBrokerEvidence,challengeNonce:string,
    mode:'reserve'|'commit'='reserve'):Permit|Commit {
    const parse=(mode==='reserve'?permit:committed).safeParse(value);
    if(!parse.success)deny('DISPATCH_PROOF_INVALID');
    const p=parse.data;
    if(p.authorityId!==this.config.authorityId||
       p.brokerId!==broker.brokerId||
       p.challengeNonce!==challengeNonce||
       p.requestId!==req.requestId||p.fingerprint!==req.fingerprint||
       p.capability!==req.capability||
       p.ownerId!==req.scope.ownerId||
       p.deviceId!==req.scope.deviceId||
       p.deviceEpoch!==req.scope.deviceEpoch||
       p.sessionEpoch!==req.scope.sessionEpoch||
       p.ownerEpoch!==req.scope.ownerEpoch||
       p.generation!==req.scope.expectedGeneration||
       p.privilege!==req.scope.requiredPrivilege)
      deny('DISPATCH_PROOF_SCOPE_MISMATCH');
    const now=this.now();
    const ttl=this.config.maxPermitMs??5000;
    if(p.issuedAtMs>now+1000||p.expiresAtMs<=now||
       p.expiresAtMs<=p.issuedAtMs||
       p.expiresAtMs-p.issuedAtMs>ttl)
      deny('DISPATCH_PROOF_EXPIRED');
    if(this.claimed.has(p.dispatchId))deny('DISPATCH_CLAIM_REPLAY');
    return p;
  }
  /**
   * Executes ONLY after a fresh authenticated external atomic dispatch claim
   * and independent high-token Broker readback. This gate NEVER retries an
   * UNKNOWN effect. It cannot abort an already executing native operation;
   * the deployed broker must expose cancellation and dispatch barriers.
   */
  async execute<T>(raw:BrokerDispatchRequest,run:()=>Promise<T>):Promise<T>{
    const request=operation.parse(raw);
    const device=request.scope.deviceId;
    if(this.locallyFenced.has(device))deny('DISPATCH_REVOKE_PENDING');
    const identity=await this.config.verifyIdentity(request).catch(()=>false);
    if(identity!==true)deny('DISPATCH_IDENTITY_UNVERIFIED');
    const broker=await this.verifyBrokerFor(request);
    // Fresh random challenge prevents an old *validly signed* claim copied
    // from a rolled-back WAL from being accepted by a new Broker process.
    const challengeNonce=randomBytes(32).toString('hex');
    let remote:DispatchClaim;
    try{remote=await this.config.authority.beginIfCurrent(
      request,broker,challengeNonce)}
    catch{return deny('DISPATCH_EXTERNAL_CAS_UNKNOWN')}
    let proof:Permit;
    try{proof=this.checkPermit(this.decode(remote),request,broker,
      challengeNonce)}
    catch(e){this.locallyFenced.add(device);throw e}
    if(this.locallyFenced.has(device)){
      // Revoke began while this claim was only reserved.
      try{await this.config.authority.release({dispatchId:proof.dispatchId,
        brokerId:broker.brokerId,request})}
      catch{this.locallyFenced.add(device)}
      deny('DISPATCH_REVOKE_PENDING');
    }
    // The begin CAS may wait on the network; refresh the native evidence before
    // committing admission, and never pass the pre-await snapshot onward.
    let commitBroker:ProtectedBrokerEvidence;
    try{commitBroker=await this.verifyBrokerFor(request,broker.brokerId)}
    catch(e){
      this.locallyFenced.add(device);
      try{await this.config.authority.release({dispatchId:proof.dispatchId,
        brokerId:broker.brokerId,request})}catch{}
      throw e;
    }
    if(this.locallyFenced.has(device)){
      try{await this.config.authority.release({dispatchId:proof.dispatchId,
        brokerId:commitBroker.brokerId,request})}catch{this.locallyFenced.add(device)}
      deny('DISPATCH_REVOKE_PENDING');
    }
    // A native readback can itself block. Never commit a reservation whose
    // signed lifetime ended during re-attestation; a remote authority must
    // enforce this too. UNKNOWN or expiry must not retry the OS effect.
    if(proof.expiresAtMs<=this.now()){
      this.locallyFenced.add(device);
      try{await this.config.authority.release({dispatchId:proof.dispatchId,
        brokerId:commitBroker.brokerId,request})}catch{}
      deny('DISPATCH_PROOF_EXPIRED');
    }
    // Required remote dispatch admission linearized against revoke.
    // A pre-revoke reservation alone cannot authorize an OS effect.
    const commitNonce=randomBytes(32).toString('hex');
    let acknowledged:DispatchClaim;
    try{
      acknowledged=await this.config.authority.commitIfCurrent(
        request,commitBroker,proof.dispatchId,commitNonce);
    }catch{
      this.locallyFenced.add(device);
      try{await this.config.authority.release({dispatchId:proof.dispatchId,
        brokerId:broker.brokerId,request})}catch{}
      deny('DISPATCH_COMMIT_UNKNOWN');
    }
    let committedProof:Commit;
    try{
      committedProof=this.checkPermit(this.decode(acknowledged),
        request,commitBroker,commitNonce,'commit');
      if(committedProof.dispatchId!==proof.dispatchId)
        deny('DISPATCH_COMMIT_IDENTITY_MISMATCH');
    }catch(e){
      this.locallyFenced.add(device);
      try{await this.config.authority.release({dispatchId:proof.dispatchId,
        brokerId:broker.brokerId,request})}catch{}
      throw e;
    }
    if(this.locallyFenced.has(device)){
      try{await this.config.authority.release({dispatchId:proof.dispatchId,
        brokerId:commitBroker.brokerId,request})}catch{}
      deny('DISPATCH_REVOKE_PENDING');
    }
    // A valid remote commit receipt cannot prove the OS token stayed HIGH
    // while CAS I/O was pending. Refresh immediately before any effect callback.
    try{await this.verifyBrokerFor(request,commitBroker.brokerId)}
    catch(e){
      this.locallyFenced.add(device);
      try{await this.config.authority.release({dispatchId:proof.dispatchId,
        brokerId:commitBroker.brokerId,request})}catch{}
      throw e;
    }
    if(this.locallyFenced.has(device)){
      try{await this.config.authority.release({dispatchId:proof.dispatchId,
        brokerId:commitBroker.brokerId,request})}catch{}
      deny('DISPATCH_REVOKE_PENDING');
    }
    // The final asynchronous native HIGH readback may outlive the signed
    // commit lease. Recheck time synchronously directly before callback.
    // A once-valid commit receipt never permits a late effect.
    if(committedProof.expiresAtMs<=this.now()){
      this.locallyFenced.add(device);
      try{await this.config.authority.release({dispatchId:proof.dispatchId,
        brokerId:commitBroker.brokerId,request})}catch{}
      deny('DISPATCH_PROOF_EXPIRED');
    }
    // Exactly once: only after remotely committed dispatch admission and fresh
    // native Broker readback.
    this.claimed.add(proof.dispatchId);
    this.inFlight.set(proof.dispatchId,device);
    try{return await run()}
    finally{
      this.inFlight.delete(proof.dispatchId);
      // No local fallback if the remote release acknowledgment is lost.
      try{await this.config.authority.release({dispatchId:proof.dispatchId,
        brokerId:broker.brokerId,request})}
      catch{/* fail closed for future dispatch if remote reconciliation needed */
        this.locallyFenced.add(device);
      }
    }
  }
  /**
   * Blocks new local dispatches immediately, then calls the independent
   * service's atomic revoke+drain. A stalled/unknown revoke stays fenced.
   * No auto-retry, no re-enabling the old owner epoch after an UNKNOWN.
   */
  async revoke(raw:DispatchRevokeRequest):Promise<RevokeProof>{
    const device=uuid.parse(raw.deviceId),owner=uuid.parse(raw.ownerId);
    uuid.parse(raw.deviceEpoch);uuid.parse(raw.sessionEpoch);
    if(!Number.isSafeInteger(raw.expectedGeneration)||
       raw.expectedGeneration<1||
       typeof raw.signedOwnerApproval!=='string'||
       raw.signedOwnerApproval.length<32)
      deny('DISPATCH_REVOKE_INVALID');
    if(this.locallyFenced.has(device))deny('DISPATCH_REVOKE_PENDING');
    this.locallyFenced.add(device);
    const approved=await this.config.verifyOwnerRevocation(raw).catch(()=>false);
    if(approved!==true)deny('DISPATCH_REVOKE_SIGNATURE_UNTRUSTED');
    let receipt:DispatchClaim;
    try{receipt=await this.config.authority.revokeAndDrain(raw)}
    catch{return deny('DISPATCH_REVOKE_OUTCOME_UNKNOWN')}
    const data=revoked.safeParse(this.decode(receipt));
    if(!data.success)deny('DISPATCH_REVOKE_PROOF_INVALID');
    const r=data.data;
    if(r.authorityId!==this.config.authorityId||
       r.deviceId!==device||r.ownerId!==owner||
       r.deviceEpoch!==raw.deviceEpoch||
       r.sessionEpoch!==raw.sessionEpoch||
       r.previousGeneration!==raw.expectedGeneration||
       r.generation!==raw.expectedGeneration+1||
       [...this.inFlight.values()].some(id=>id===device))
      deny('DISPATCH_REVOKE_PROOF_MISMATCH');
    return r;
  }
}
