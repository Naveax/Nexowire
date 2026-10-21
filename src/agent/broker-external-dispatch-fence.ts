import {createPublicKey,verify,type KeyObject} from 'node:crypto';
import * as z from 'zod';
import type {AuthenticatedGrantScope} from './postgres-bound-grant-cas.js';
import {WitnessAuthorityError} from './postgres-monotonic-witness.js';

const uuid=z.string().uuid();
const scopeSchema=z.object({
  ownerId:uuid,deviceId:uuid,deviceEpoch:uuid,sessionEpoch:uuid,
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
export interface ExternalBrokerDispatchAuthority {
  /** Must be atomic with revoke/re-pair and single-use claim allocation. */
  beginIfCurrent(operation:BrokerDispatchRequest,
    broker:ProtectedBrokerEvidence):Promise<DispatchClaim>;
  /**
   * Revoke and fence NEW claims immediately. Return only after all
   * previously admitted claims finish, or return UNKNOWN without replay.
   */
  revokeAndDrain(request:DispatchRevokeRequest):Promise<DispatchClaim>;
  /** Release a claim. Lost ACK is UNKNOWN, never execute the effect again. */
  release(claimId:string):Promise<void>;
}
const permit=z.object({
  kind:z.literal('broker_dispatch_permit_v1'),
  authorityId:uuid,brokerId:uuid,dispatchId:uuid,
  requestId:uuid,fingerprint:z.string().regex(/^[0-9a-f]{64}$/),
  capability:z.string().min(1).max(128),
  ownerId:uuid,deviceId:uuid,deviceEpoch:uuid,sessionEpoch:uuid,
  generation:z.number().int().positive().safe(),
  privilege:z.enum(['CORE','ROOT']),
  issuedAtMs:z.number().int().positive().safe(),
  expiresAtMs:z.number().int().positive().safe(),
}).strict();
const revoked=z.object({
  kind:z.literal('broker_dispatch_revocation_v1'),
  authorityId:uuid,deviceId:uuid,ownerId:uuid,deviceEpoch:uuid,
  sessionEpoch:uuid,previousGeneration:z.number().int().positive().safe(),
  generation:z.number().int().positive().safe(),
  drained:z.literal(true),revoked:z.literal(true),
}).strict();
type Permit=z.infer<typeof permit>;
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
    broker:ProtectedBrokerEvidence):Permit {
    const parse=permit.safeParse(value);
    if(!parse.success)deny('DISPATCH_PROOF_INVALID');
    const p=parse.data;
    if(p.authorityId!==this.config.authorityId||
       p.brokerId!==broker.brokerId||
       p.requestId!==req.requestId||p.fingerprint!==req.fingerprint||
       p.capability!==req.capability||
       p.ownerId!==req.scope.ownerId||
       p.deviceId!==req.scope.deviceId||
       p.deviceEpoch!==req.scope.deviceEpoch||
       p.sessionEpoch!==req.scope.sessionEpoch||
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
    let broker:ProtectedBrokerEvidence;
    try{broker=await this.config.verifyEffectiveBroker()}
    catch{return deny('DISPATCH_EFFECTIVE_BROKER_UNAVAILABLE')}
    if(!broker||broker.verified!==true||
       !uuid.safeParse(broker.brokerId).success||
       broker.highIntegrityToken!==true||
       broker.signedProtectedImage!==true||
       broker.protectedParentAndImports!==true)
      deny('DISPATCH_HIGH_TOKEN_UNVERIFIED');
    let remote:DispatchClaim;
    try{remote=await this.config.authority.beginIfCurrent(request,broker)}
    catch{return deny('DISPATCH_EXTERNAL_CAS_UNKNOWN')}
    let proof:Permit;
    try{proof=this.checkPermit(this.decode(remote),request,broker)}
    catch(e){this.locallyFenced.add(device);throw e}
    if(this.locallyFenced.has(device)){
      // Revoke began while a claim was in flight. Release it so remote
      // drain cannot wait indefinitely for an abandoned dispatch lease.
      try{await this.config.authority.release(proof.dispatchId)}
      catch{this.locallyFenced.add(device)}
      deny('DISPATCH_REVOKE_PENDING');
    }
    // Execute only once. A revoked/UNKNOWN request is never replayed.
    this.claimed.add(proof.dispatchId);
    this.inFlight.set(proof.dispatchId,device);
    try{return await run()}
    finally{
      this.inFlight.delete(proof.dispatchId);
      // No local fallback if the remote release acknowledgment is lost.
      try{await this.config.authority.release(proof.dispatchId)}
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
