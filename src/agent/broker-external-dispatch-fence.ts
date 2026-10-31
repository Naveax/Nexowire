import {createPublicKey,verify,randomBytes,type KeyObject} from 'node:crypto';
import * as z from 'zod';
import type {AuthenticatedGrantScope} from './postgres-bound-grant-cas.js';
import {WitnessAuthorityError} from './postgres-monotonic-witness.js';

const uuid=z.string().uuid();
const MAX_PERMIT_MS=5_000;
const NS_PER_MS=1_000_000n;
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
const revokeInput=z.object({
  deviceId:uuid,ownerId:uuid,deviceEpoch:uuid,sessionEpoch:uuid,
  expectedGeneration:z.number().int().positive().safe(),
  signedOwnerApproval:z.string().min(32).max(8192),
}).strict();
export type BrokerDispatchRequest=z.infer<typeof operation>;
/** Validated, detached and frozen dispatch input passed into the effect boundary. */
export type FrozenBrokerDispatchRequest=Readonly<
  Omit<BrokerDispatchRequest,'scope'>&{
    scope:Readonly<BrokerDispatchRequest['scope']>;
  }>;
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
  revokeAndDrain(request:DispatchRevokeRequest,challengeNonce:string):Promise<DispatchClaim>;
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
  sessionEpoch:uuid,challengeNonce:z.string().regex(/^[0-9a-f]{64}$/),
  previousGeneration:z.number().int().positive().safe(),
  generation:z.number().int().positive().safe(),
  drained:z.literal(true),revoked:z.literal(true),
}).strict();
type Permit=z.infer<typeof permit>;
type Commit=z.infer<typeof committed>;
type RevokeProof=z.infer<typeof revoked>;
function deny(code:string):never{throw new WitnessAuthorityError(code)}
/**
 * The native witness boundary may supply an object whose property getters,
 * prototype or references change between validation and a remote CAS await.
 * Read a fixed set of own DATA descriptors exactly once and freeze primitives
 * before checking any security field. This is a source-side TOCTOU fence,
 * NOT proof of an independently protected Windows token or process.
 */
function snapshotProtectedBrokerEvidence(raw:unknown):ProtectedBrokerEvidence {
  if(!raw || typeof raw!=='object' || Array.isArray(raw))
    deny('DISPATCH_HIGH_TOKEN_UNVERIFIED');
  try {
    const prototype=Object.getPrototypeOf(raw);
    if(prototype!==Object.prototype && prototype!==null)
      deny('DISPATCH_HIGH_TOKEN_UNVERIFIED');
    const descriptors=Object.getOwnPropertyDescriptors(raw);
    const fields=[
      'verified','brokerId','ownerEpoch','grantGeneration',
      'highIntegrityToken','signedProtectedImage','protectedParentAndImports',
    ] as const;
    const snapshot:Record<string,unknown>=Object.create(null);
    for(const key of fields) {
      const descriptor=descriptors[key];
      if(!descriptor || !Object.hasOwn(descriptor,'value') ||
         descriptor.enumerable!==true)
        deny('DISPATCH_HIGH_TOKEN_UNVERIFIED');
      snapshot[key]=descriptor.value;
    }
    return Object.freeze(snapshot) as unknown as ProtectedBrokerEvidence;
  }catch{
    return deny('DISPATCH_HIGH_TOKEN_UNVERIFIED');
  }
}

/** Source gate: does not modify #03/#04 Broker/Access owner implementation. */
export class BrokerExternalDispatchFence {
  private readonly publicKey:KeyObject;
  private readonly maxPermitMs:number;
  private readonly readClock:()=>number;
  private readonly readMonotonic:()=>bigint;
  private lastClockMs=0;
  private lastMonotonicNs=0n;
  private clockUntrusted=false;
  private readonly inFlight=new Map<string,string>();
  private readonly claimed=new Set<string>();
  /** One request UUID may have only one in-flight local admission. */
  private readonly pendingRequests=new Set<string>();
  private readonly locallyFenced=new Set<string>();
  /** Revocation remains single-attempt even after a local execution fence. */
  private readonly revocations=new Set<string>();
  constructor(private readonly config:{
    authority:ExternalBrokerDispatchAuthority;
    authorityId:string;
    publicKeyPem:string;maxPermitMs?:number;
    now?:()=>number;
    /** Test injection only; production requires a protected native time source. */
    monotonicNowNs?:()=>bigint;
    /** Protected host must authenticate the calling device/session, not UI. */
    verifyIdentity:(request:BrokerDispatchRequest)=>Promise<boolean>;
    /** Must attest REAL signed, high-integrity Windows Broker + protected ACL. */
    verifyEffectiveBroker:()=>Promise<ProtectedBrokerEvidence>;
    /** Verify an exact short-lived owner-signed revoke approval. */
    verifyOwnerRevocation:(request:DispatchRevokeRequest)=>Promise<boolean>;
  }){
    if(!uuid.safeParse(config.authorityId).success)deny('DISPATCH_AUTHORITY_INVALID');
    const max=config.maxPermitMs===undefined?MAX_PERMIT_MS:config.maxPermitMs;
    if(!Number.isSafeInteger(max)||max<1||max>MAX_PERMIT_MS)
      deny('DISPATCH_PERMIT_TTL_INVALID');
    this.maxPermitMs=max;
    this.readClock=config.now??Date.now;
    this.readMonotonic=config.monotonicNowNs??process.hrtime.bigint;
    this.publicKey=createPublicKey(config.publicKeyPem);
    if(this.publicKey.asymmetricKeyType!=='ed25519')
      deny('DISPATCH_SIGNING_KEY_INVALID');
  }
  private now():number{
    if(this.clockUntrusted)deny('DISPATCH_CLOCK_UNTRUSTED');
    try{
      const value=this.readClock();
      if(!Number.isSafeInteger(value)||value<=0||value<this.lastClockMs)
        throw new Error('CLOCK_INVALID');
      this.lastClockMs=value;
      return value;
    }catch{
      this.clockUntrusted=true;
      return deny('DISPATCH_CLOCK_UNTRUSTED');
    }
  }
  private monotonicNow():bigint{
    if(this.clockUntrusted)deny('DISPATCH_CLOCK_UNTRUSTED');
    try{
      const value=this.readMonotonic();
      if(typeof value!=='bigint'||value<0n||value<this.lastMonotonicNs)
        throw new Error('MONOTONIC_CLOCK_INVALID');
      this.lastMonotonicNs=value;
      return value;
    }catch{
      this.clockUntrusted=true;
      return deny('DISPATCH_CLOCK_UNTRUSTED');
    }
  }
  /** Refresh native Broker evidence after every remote CAS await before effect admission. */
  private async verifyBrokerFor(request:BrokerDispatchRequest,
    expectedBrokerId?:string):Promise<ProtectedBrokerEvidence>{
    let raw:ProtectedBrokerEvidence;
    try{raw=await this.config.verifyEffectiveBroker()}
    catch{return deny('DISPATCH_EFFECTIVE_BROKER_UNAVAILABLE')}
    // Never retain a provider-owned live object across the next await.
    const broker=snapshotProtectedBrokerEvidence(raw);
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
      // A valid signature over ambiguous JSON is not an authorization.
      // JSON.parse accepts duplicate keys, UTF-8 replacement and equivalent
      // escape sequences that other parsers may interpret differently.
      const parsed=JSON.parse(bytes.toString('utf8')) as unknown;
      const canonical=JSON.stringify(parsed);
      if(!canonical || !Buffer.from(canonical,'utf8').equals(bytes))
        deny('DISPATCH_SIGNATURE_UNTRUSTED');
      return parsed;
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
    const ttl=this.maxPermitMs;
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
  async execute<T>(raw:BrokerDispatchRequest,
    run:(approved:FrozenBrokerDispatchRequest)=>Promise<T>):Promise<T>{
    // Zod provides a validated deep copy, not an immutable one. Neither the
    // caller nor an injected same-process identity/CAS adapter may rewrite
    // the admission identity after validation. Freeze the nested scope first:
    // freezing only the outer object permits owner/session substitution.
    const request=operation.parse(raw);
    Object.freeze(request.scope);
    Object.freeze(request);
    const requestId=request.requestId;
    if(this.pendingRequests.has(requestId))
      deny('DISPATCH_EXTERNAL_CAS_UNKNOWN');
    this.pendingRequests.add(requestId);
    return this.executeOnce(request,run).finally(()=>{
      // The UUID used for cleanup is the validated ORIGINAL value, never a
      // property subsequently read from an untrusted/shared reference.
      this.pendingRequests.delete(requestId);
    });
  }
  private async executeOnce<T>(request:BrokerDispatchRequest,
    run:(approved:FrozenBrokerDispatchRequest)=>Promise<T>):Promise<T>{
    const device=request.scope.deviceId;
    if(this.locallyFenced.has(device))deny('DISPATCH_REVOKE_PENDING');
    try{this.now();this.monotonicNow()}
    catch(e){this.locallyFenced.add(device);throw e}
    const identity=await this.config.verifyIdentity(request).catch(()=>false);
    if(identity!==true)deny('DISPATCH_IDENTITY_UNVERIFIED');
    const broker=await this.verifyBrokerFor(request);
    // Fresh random challenge prevents an old *validly signed* claim copied
    // from a rolled-back WAL from being accepted by a new Broker process.
    let beginStartedNs:bigint;
    try{beginStartedNs=this.monotonicNow()}
    catch(e){this.locallyFenced.add(device);throw e}
    const challengeNonce=randomBytes(32).toString('hex');
    let remote:DispatchClaim;
    try{remote=await this.config.authority.beginIfCurrent(
      request,broker,challengeNonce)}
    catch{
      // The reservation may have committed remotely despite a lost ACK.
      // Keep this Broker instance fenced; new instances still rely on the
      // external authority's durable requestId tombstone for global safety.
      this.locallyFenced.add(device);
      return deny('DISPATCH_EXTERNAL_CAS_UNKNOWN');
    }
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
    let preCommitNow:number,preCommitNs:bigint;
    try{preCommitNow=this.now();preCommitNs=this.monotonicNow()}catch(e){
      this.locallyFenced.add(device);
      try{await this.config.authority.release({dispatchId:proof.dispatchId,
        brokerId:commitBroker.brokerId,request})}catch{}
      throw e;
    }
    if(proof.expiresAtMs<=preCommitNow||
       preCommitNs-beginStartedNs>=
        BigInt(proof.expiresAtMs-proof.issuedAtMs)*NS_PER_MS){
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
    let beforeEffectNow:number,beforeEffectNs:bigint;
    try{beforeEffectNow=this.now();beforeEffectNs=this.monotonicNow()}catch(e){
      this.locallyFenced.add(device);
      try{await this.config.authority.release({dispatchId:proof.dispatchId,
        brokerId:commitBroker.brokerId,request})}catch{}
      throw e;
    }
    if(committedProof.expiresAtMs<=beforeEffectNow||
       beforeEffectNs-preCommitNs>=
        BigInt(committedProof.expiresAtMs-committedProof.issuedAtMs)*NS_PER_MS){
      this.locallyFenced.add(device);
      try{await this.config.authority.release({dispatchId:proof.dispatchId,
        brokerId:commitBroker.brokerId,request})}catch{}
      deny('DISPATCH_PROOF_EXPIRED');
    }
    // Exactly once: only after remotely committed dispatch admission and fresh
    // native Broker readback.
    this.claimed.add(proof.dispatchId);
    this.inFlight.set(proof.dispatchId,device);
    try{return await run(request)}
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
    const parsed=revokeInput.safeParse(raw);
    if(!parsed.success)deny('DISPATCH_REVOKE_INVALID');
    const request:DispatchRevokeRequest=parsed.data;
    Object.freeze(request);
    const device=request.deviceId,owner=request.ownerId;
    if(this.revocations.has(device))deny('DISPATCH_REVOKE_PENDING');
    this.revocations.add(device);
    this.locallyFenced.add(device);
    const approved=await this.config.verifyOwnerRevocation(request).catch(()=>false);
    if(approved!==true){
      // No remote revocation was attempted; a valid owner approval may retry.
      this.revocations.delete(device);
      deny('DISPATCH_REVOKE_SIGNATURE_UNTRUSTED');
    }
    const challengeNonce=randomBytes(32).toString('hex');
    let receipt:DispatchClaim;
    try{receipt=await this.config.authority.revokeAndDrain(request,challengeNonce)}
    catch{return deny('DISPATCH_REVOKE_OUTCOME_UNKNOWN')}
    const data=revoked.safeParse(this.decode(receipt));
    if(!data.success)deny('DISPATCH_REVOKE_PROOF_INVALID');
    const r=data.data;
    if(r.authorityId!==this.config.authorityId||
       r.deviceId!==device||r.ownerId!==owner||
       r.deviceEpoch!==request.deviceEpoch||
       r.sessionEpoch!==request.sessionEpoch||
       r.challengeNonce!==challengeNonce||
       r.previousGeneration!==request.expectedGeneration||
       r.generation!==request.expectedGeneration+1||
       [...this.inFlight.values()].some(id=>id===device))
      deny('DISPATCH_REVOKE_PROOF_MISMATCH');
    return r;
  }
}
