/**
 * #11 staging-only runtime adapter for #616 owner-scoped transfer and CORE
 * cancellation. No production authority, Agent process, store or Job owner is
 * wired here. The caller must supply independently authenticated read-only
 * transports and three separate pinned public keys.
 */
import { createHash, verify, type KeyObject } from 'node:crypto';
import { ProgressSupervisor } from './progress-supervisor.js';
import type { ProgressProofRequest } from './progress-proof-verifier.js';
import {
  verifyOffhostCompletion, type CompletionExpected, type SignedCompletion,
  type TrustedCompletionPorts, type OwnerGrantView, type TransferView,
} from './trusted-worker-completion.js';

const SHA=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const B64=/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const LIMIT_MS=30_000;
/** Signed independently of both the worker/issuer and off-host custody seal. */
export interface PostconditionWitness {
  version:1;
  requestId:string;
  jobId:string;
  ownerAccountId:string;
  projectId:string;
  targetDeviceId:string;
  targetPath:string;
  ownerGrantEpoch:number;
  sha256:string;
  bytesConfirmed:number;
  observedAt:string;
  signatureBase64:string;
}
type WitnessPayload=Omit<PostconditionWitness,'signatureBase64'>;
export function canonicalPostconditionWitness(v:WitnessPayload):Buffer {
  return Buffer.from('NEXOWIRE_COMPLETION_POSTCONDITION_V1\n'+JSON.stringify([
    v.version,v.requestId,v.jobId,v.ownerAccountId,v.projectId,
    v.targetDeviceId,v.targetPath,v.ownerGrantEpoch,v.sha256,
    v.bytesConfirmed,v.observedAt,
  ])+'\n');
}
export interface RuntimeCompletionPorts extends TrustedCompletionPorts {
  /** Result returned by an independent trusted postcondition witness. */
  readPostcondition():Promise<PostconditionWitness>;
}
export interface RuntimeCompletionKeys {
  issuer:KeyObject;
  immutableStorage:KeyObject;
  publication:KeyObject;
  monotonicCommit:KeyObject;
  postcondition:KeyObject;
}
export type RuntimeCompletionStatus=
  'REPORTED_ONLY'|'COMPLETED_VERIFIED'|'CANCELLED_OR_STALE_CORE'|
  'MUTATION_UNKNOWN'|'POSTCONDITION_MISMATCH'|'PROOF_UNVERIFIED';

function keyOk(k:KeyObject):boolean{
  return k?.type==='public'&&k.asymmetricKeyType==='ed25519';
}
function distinct(a:KeyObject,b:KeyObject):boolean{
  return !a.export({type:'spki',format:'der'}).equals(
    b.export({type:'spki',format:'der'}));
}
function grantMatches(g:OwnerGrantView,e:CompletionExpected):boolean {
  return g.ownerAccountId===e.ownerAccountId&&g.deviceId===e.deviceId&&
    g.projectId===e.projectId&&g.grantId===e.grantId&&
    g.epoch===e.ownerGrantEpoch&&g.role==='CORE'&&g.state==='ACTIVE';
}
function transferMatches(t:TransferView,s:SignedCompletion):boolean{
  const x=s.statement;
  return t.id===x.jobId&&t.state==='COMPLETED'&&
    t.errorCode===undefined&&
    t.sourceDeviceId===x.sourceDeviceId&&t.targetDeviceId===x.targetDeviceId&&
    t.targetPath===x.targetPath&&t.sha256===x.immutableObjectSha256&&
    Number.isSafeInteger(t.bytesTotal)&&t.bytesTotal>0&&t.bytesTotal<=131072&&
    t.bytesConfirmed===t.bytesTotal;
}
function postconditionMatches(w:PostconditionWitness,
  e:CompletionExpected,s:SignedCompletion,t:TransferView,
  key:KeyObject,now:number):boolean{
  const x=s.statement;
  if(!w||w.version!==1||!UUID.test(w.requestId)||
     w.requestId!==e.requestId||w.jobId!==x.jobId||
     w.ownerAccountId!==e.ownerAccountId||w.projectId!==e.projectId||
     w.targetDeviceId!==e.targetDeviceId||w.targetPath!==e.targetPath||
     w.ownerGrantEpoch!==e.ownerGrantEpoch||!SHA.test(w.sha256)||
     w.sha256!==x.immutableObjectSha256||w.sha256!==t.sha256||
     w.bytesConfirmed!==t.bytesTotal||
     !Number.isSafeInteger(w.bytesConfirmed)||w.bytesConfirmed<1||
     typeof w.observedAt!=='string'||!Number.isFinite(Date.parse(w.observedAt))||
     new Date(Date.parse(w.observedAt)).toISOString()!==w.observedAt||
     Date.parse(w.observedAt)>now+2000||now-Date.parse(w.observedAt)>LIMIT_MS||
     Date.parse(w.observedAt)<Date.parse(x.committedAt)-2000||
     typeof w.signatureBase64!=='string'||!B64.test(w.signatureBase64))return false;
  const signature=Buffer.from(w.signatureBase64,'base64');
  if(signature.length!==64||signature.toString('base64')!==w.signatureBase64)return false;
  const {signatureBase64:_ignore,...payload}=w;
  return verify(null,canonicalPostconditionWitness(payload),key,signature);
}
/**
 * Persistent across in-process calls and *sticky* for UNKNOWN outcomes:
 * no local automatic replay/retry/refresh can turn a missing ACK into success.
 * A new authorized session/reconciliation requires another adapter instance
 * and separate owner authority. No store or ProcessManager effects.
 */
export class ProgressRuntimePostconditionAdapter {
  private blocked:RuntimeCompletionStatus|null=null;
  private lastResult:RuntimeCompletionStatus='REPORTED_ONLY';
  private lastWitnessDigest:string|null=null;
  private pending=false;
  constructor(
    private readonly supervisor:ProgressSupervisor,
    private readonly request:ProgressProofRequest,
    private readonly expected:CompletionExpected,
    private readonly keys:RuntimeCompletionKeys,
    private readonly ports:RuntimeCompletionPorts,
    private readonly now:()=>number=Date.now,
  ) {
    if(expected.sessionId!==request.scope.sessionId||
       expected.ownerAccountId!==request.scope.ownerAccountId||
       expected.deviceId!==request.scope.deviceId||
       expected.projectId!==request.scope.projectId||
       expected.runId!==request.scope.runId||
       expected.completedCount!==request.expectedCount||
       !keyOk(keys.issuer)||!keyOk(keys.immutableStorage)||
       !keyOk(keys.postcondition)||!keyOk(keys.publication)||
       !keyOk(keys.monotonicCommit)||
       !distinct(keys.issuer,keys.immutableStorage)||
       !distinct(keys.issuer,keys.postcondition)||
       !distinct(keys.immutableStorage,keys.postcondition)||
       !distinct(keys.publication,keys.issuer)||
       !distinct(keys.publication,keys.postcondition)||
       !distinct(keys.publication,keys.immutableStorage)||
       !distinct(keys.monotonicCommit,keys.issuer)||
       !distinct(keys.monotonicCommit,keys.immutableStorage)||
       !distinct(keys.monotonicCommit,keys.publication)||
       !distinct(keys.monotonicCommit,keys.postcondition))
      throw new Error('RUNTIME_TRUST_BOUNDARY_INVALID');
  }
  private blockUnknown():RuntimeCompletionStatus{
    this.lastWitnessDigest=null;
    this.blocked='MUTATION_UNKNOWN';
    this.supervisor.invalidateOwnerGrant(this.expected.sessionId);
    this.lastResult=this.blocked;
    return this.blocked;
  }
  private cancel():RuntimeCompletionStatus{
    this.lastWitnessDigest=null;
    this.blocked='CANCELLED_OR_STALE_CORE';
    this.supervisor.invalidateOwnerGrant(this.expected.sessionId);
    this.lastResult=this.blocked;
    return this.blocked;
  }
  /** A lost ACK after a possible native write cannot be replayed. */
  observeLostAck():RuntimeCompletionStatus{return this.blockUnknown();}
  /** Invoked by a trusted process observer; never infer recovery from stdout. */
  observeLostPid():RuntimeCompletionStatus{return this.blockUnknown();}
  /** A cancel requested during a potentially dispatched native write is UNKNOWN. */
  observeNativeWriteCancelPending():RuntimeCompletionStatus{return this.blockUnknown();}
  private sourceProcessUnknown():boolean{
    const state=this.supervisor.snapshot(this.expected.sessionId);
    return state.processState==='lost'||state.processState==='orphaned'||
      state.state==='stalled';
  }
  /** Never expose a cached COMPLETED result after the trusted supervisor
   * invalidates its owner grant, reconnect generation or proof freshness.
   * This local read is NOT independent off-host grant readback. */
  private acceptedProofNoLongerCurrent():boolean{
    return this.lastResult==='COMPLETED_VERIFIED' &&
      this.supervisor.snapshot(this.expected.sessionId).state!=='completed_verified';
  }
  snapshot(){
    const invalidated=this.acceptedProofNoLongerCurrent();
    return {status:this.blocked??(invalidated?'MUTATION_UNKNOWN':this.lastResult),
      pending:this.pending,
      postconditionSha256:invalidated?null:this.lastWitnessDigest,
      automaticReplayAllowed:false,productionAuthorityConnected:false};
  }
  async reconcile(signed:SignedCompletion):Promise<RuntimeCompletionStatus>{
    if(this.blocked)return this.blocked;
    if(this.acceptedProofNoLongerCurrent())return this.blockUnknown();
    if(this.sourceProcessUnknown())return this.blockUnknown();
    if(this.pending)return this.blockUnknown();
    this.pending=true;
    const proofGeneration=this.supervisor.proofGenerationOf(this.expected.sessionId);
    if(proofGeneration===null){this.pending=false;return this.blockUnknown();}
    const proofChanged=()=>this.supervisor.proofGenerationOf(
      this.expected.sessionId)!==proofGeneration;
    try{
      let grant:OwnerGrantView,transfer:TransferView;
      try{
        [grant,transfer]=await Promise.all([
          this.ports.readGrant(),this.ports.readTransfer(),
        ]);
      }catch{return this.blockUnknown();}
      if(this.blocked||this.sourceProcessUnknown()||proofChanged())return this.blockUnknown();
      if(!grantMatches(grant,this.expected))return this.cancel();
      if(!transferMatches(transfer,signed)){
        // #725: a forensic Native error survives cancel/reconnect. Never
        // downgrade FORGED_WRITE_RECEIPT or revoked owner to CANCELLED or
        // accept a counterfeit COMPLETED snapshot carrying an old error.
        if(transfer.errorCode!==undefined)return this.blockUnknown();
        if(transfer.state==='CANCEL_REQUESTED')return this.blockUnknown();
        if(transfer.state==='CANCELLED')return this.cancel();
        // An invalid terminal COMPLETED, FAILED, or a native-write outcome
        // that requires recovery is ambiguous, not safe to re-poll/replay.
        // In particular, a counterfeit COMPLETED receipt must be sticky
        // UNKNOWN even if a later status happens to look plausible.
        if(['MUTATION_UNKNOWN','RECOVERY_REQUIRED','FAILED','COMPLETED'].includes(
          transfer.state))return this.blockUnknown();
        // QUEUED/RUNNING/PUBLISHING are merely non-terminal observations;
        // none can authorize completed_verified.
        if(['QUEUED','RUNNING','PUBLISHING'].includes(transfer.state)){
          this.lastResult='REPORTED_ONLY';return this.lastResult;
        }
        return this.blockUnknown();
      }
      let witness:PostconditionWitness;
      try{witness=await this.ports.readPostcondition();}
      catch{return this.blockUnknown();}
      if(!postconditionMatches(witness,this.expected,signed,transfer,
        this.keys.postcondition,this.now())){
        // Counterfeit signed completion must remain UNKNOWN, not become
        // eligible for a blind second verification after another RPC reply.
        return this.blockUnknown();
      }
      const permit=await verifyOffhostCompletion(signed,this.expected,
        this.keys.issuer,this.keys.immutableStorage,
        this.keys.publication,this.keys.monotonicCommit,this.ports,this.now);
      if(this.blocked||this.sourceProcessUnknown()||proofChanged())return this.blockUnknown();
      if(!permit){
        // An in-flight CORE revoke can make the lower-level verifier fail
        // after its second grant check. Reconcile the grant once more so a
        // real cancellation is classified as revoked, never as success.
        try {
          const [latest,latestTransfer]=await Promise.all([
            this.ports.readGrant(),this.ports.readTransfer(),
          ]);
          if(!grantMatches(latest,this.expected))return this.cancel();
          if(latestTransfer.errorCode!==undefined)return this.blockUnknown();
          if(latestTransfer.state==='CANCEL_REQUESTED')return this.blockUnknown();
          if(latestTransfer.state==='CANCELLED')return this.cancel();
        }catch {return this.blockUnknown();}
        // Could be corruption, missing readback or lost ACK. No retry.
        return this.blockUnknown();
      }
      // Revalidate CORE and the last transfer state after async SHA/readback.
      let g2:OwnerGrantView,t2:TransferView;
      try{[g2,t2]=await Promise.all([
        this.ports.readGrant(),this.ports.readTransfer(),
      ]);}catch{return this.blockUnknown();}
      if(this.blocked||this.sourceProcessUnknown()||proofChanged())return this.blockUnknown();
      if(!grantMatches(g2,this.expected))return this.cancel();
      if(!transferMatches(t2,signed))return this.blockUnknown();
      const verified=await this.supervisor.verifySessionFromDisk(
        this.expected.sessionId,this.request,permit);
      if(this.blocked||this.sourceProcessUnknown()||proofChanged())return this.blockUnknown();
      if(verified.status!=='verified'){
        this.lastResult='PROOF_UNVERIFIED';return this.lastResult;
      }
      // Guard last mutation window across local disk inspection too.
      const [g3,t3]=await Promise.all([
        this.ports.readGrant(),this.ports.readTransfer(),
      ]).catch(()=>[null,null] as const);
      if(this.blocked||this.sourceProcessUnknown()||proofChanged())return this.blockUnknown();
      if(!g3||!t3)return this.blockUnknown();
      if(!grantMatches(g3,this.expected))return this.cancel();
      if(!transferMatches(t3,signed))return this.blockUnknown();
      const snapshot=this.supervisor.snapshot(this.expected.sessionId);
      if(snapshot.state!=='completed_verified'){
        this.lastResult='PROOF_UNVERIFIED';return this.lastResult;
      }
      const {signatureBase64:_signature,...body}=witness;
      this.lastWitnessDigest=createHash('sha256').update(
        canonicalPostconditionWitness(body)).digest('hex');
      if(this.blocked||this.sourceProcessUnknown()||proofChanged())return this.blockUnknown();
      this.lastResult='COMPLETED_VERIFIED';
      return this.lastResult;
    }catch{
      return this.blockUnknown();
    }finally{this.pending=false;}
  }
}
