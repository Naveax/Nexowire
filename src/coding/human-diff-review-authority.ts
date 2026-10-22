/**
 * #40 independent P1 human-in-loop SOURCE consent gate.
 *
 * Contract between #32 ReviewedGitPatch.preview and #04
 * reviewAccessDiffApproval (#795). No mutation, Broker/UAC permission,
 * external CAS admission, or #32 verifyApproval=true is provided here.
 * Host integrations MUST wire the #04 verifier on the trusted server, and
 * read the #32 preview through an independently scoped authoritative port.
 */
import {createHash, verify, type KeyObject} from 'node:crypto';

const hex256 = /^[a-f0-9]{64}$/;
const gitOid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (v:string):string=>createHash('sha256').update(v,'utf8').digest('hex');

/** Structural interface for #32 PR #813 (no import from an unmerged PR). */
export interface PatchPreview40 {
  identity:{ownerId:string;taskId:string;worktreeId:string;worktreeRoot:string;
    baseSha:string;sourceSha:string;approvalEpoch:number};
  file:string;beforeSha256:string;beforeVersion:string;
  afterSha256:string;fingerprint:string;diff:string;
}

/** These values MUST be server-attested, never populated by browser state. */
export interface AuthoritativeReview40 {
  preview:PatchPreview40;
  requestId:string;logicalMutationId:string;semanticEffectSha256:string;
  ownerId:string;deviceId:string;deviceEpoch:string;sessionEpoch:string;
  ownerEpoch:number;grantGeneration:number;
  worktreeIdentitySha256:string;
  /** From #04's authenticated task/worktree binding, not the raw Git OID. */
  accessBaseSha256:string;
  requestedMode:'SAFE'|'FULL'|'ROOT'|'CORE';
  previousNativeEffectId:string|null;
  scopeVerified:boolean;gitMetadataWithinScope:boolean;
  revoking:boolean;revoked:boolean;
  mutationState:'NOT_DISPATCHED_VERIFIED'|'COMPLETED_VERIFIED'|
    'MUTATION_STATE_UNKNOWN'|'UNVERIFIED';
}

export type HumanPhase40='APPLY'|'UNDO';
/** Local human consent supplements, never replaces, #04 signed review. */
export interface HumanConsentStatement40 {
  kind:'nexowire.coding.human-diff-consent.v1';
  scope:'LOCAL_HUMAN_SOURCE_ONLY';
  approvalId:string;nonceSha256:string;phase:HumanPhase40;
  requestId:string;taskId:string;logicalMutationId:string;
  semanticEffectSha256:string;ownerId:string;deviceId:string;
  deviceEpoch:string;sessionEpoch:string;ownerEpoch:number;
  grantGeneration:number;worktreeId:string;worktreeIdentitySha256:string;
  gitBaseSha:string;gitSourceSha:string;approvalEpoch:number;
  accessBaseSha256:string;accessDiffSha256:string;
  beforeSha256:string;beforeVersion:string;afterSha256:string;
  patchFingerprintSha256:string;file:string;
  requestedMode:'SAFE'|'FULL'|'ROOT'|'CORE';
  previousNativeEffectId:string|null;
  issuedAtMs:number;expiresAtMs:number;
}
export interface SignedHumanConsent40 {
  readonly statement:unknown;
  readonly signature:unknown;
}

const signedKeys=[
  'kind','scope','approvalId','nonceSha256','phase','requestId','taskId',
  'logicalMutationId','semanticEffectSha256','ownerId','deviceId',
  'deviceEpoch','sessionEpoch','ownerEpoch','grantGeneration','worktreeId',
  'worktreeIdentitySha256','gitBaseSha','gitSourceSha','approvalEpoch',
  'accessBaseSha256','accessDiffSha256','beforeSha256','beforeVersion',
  'afterSha256','patchFingerprintSha256','file','requestedMode',
  'previousNativeEffectId','issuedAtMs','expiresAtMs',
] as const;

/** Stable ordered signing format: explicit domain and exact fields. */
export function humanConsentSigningBytes40(s:HumanConsentStatement40):Buffer {
  return Buffer.from(JSON.stringify([
    'nexowire.coding.human-diff-consent.v1:ed25519',
    ...signedKeys.map(k=>s[k]),
  ]),'utf8');
}

const exactKeys=(v:Record<string,unknown>):boolean=>
  Object.keys(v).length===signedKeys.length&&
  signedKeys.every(k=>Object.prototype.hasOwnProperty.call(v,k));

function validSnapshot(s:AuthoritativeReview40):boolean {
  const p=s.preview;
  if(!p||!p.identity||!s.scopeVerified||!s.gitMetadataWithinScope||
     s.revoking||s.revoked||s.mutationState!=='NOT_DISPATCHED_VERIFIED')return false;
  if(!uuid.test(s.requestId)||!uuid.test(s.logicalMutationId)||
     !hex256.test(s.semanticEffectSha256)||!hex256.test(s.worktreeIdentitySha256)||
     !hex256.test(s.accessBaseSha256)||!uuid.test(s.deviceEpoch)||
     !uuid.test(s.sessionEpoch)||!Number.isSafeInteger(s.ownerEpoch)||
     s.ownerEpoch<=0||!Number.isSafeInteger(s.grantGeneration)||
     s.grantGeneration<=0||!Number.isSafeInteger(p.identity.approvalEpoch)||
     p.identity.approvalEpoch<0||!gitOid.test(p.identity.baseSha)||
     !gitOid.test(p.identity.sourceSha)||!hex256.test(p.beforeSha256)||
     !hex256.test(p.afterSha256)||!hex256.test(p.fingerprint)||
     typeof p.beforeVersion!=='string'||!p.beforeVersion||
     p.beforeVersion.length>256||typeof p.diff!=='string'||
     !p.diff||p.diff.length>192*1024||
     typeof p.file!=='string'||!p.file||p.file.length>512||
     typeof p.identity.worktreeRoot!=='string'||!p.identity.worktreeRoot||
     typeof p.identity.worktreeId!=='string'||!p.identity.worktreeId||
     p.identity.ownerId!==s.ownerId||!uuid.test(p.identity.taskId)||
     !s.ownerId||!s.deviceId||!['SAFE','FULL','ROOT','CORE'].includes(s.requestedMode)||
     (s.previousNativeEffectId!==null&&!uuid.test(s.previousNativeEffectId)))return false;
  // #32's root/path safety comes from a trusted adapter, never browser input.
  return true;
}

/** Construct only from a fresh trusted #32 preview and #04 task binding. */
export function humanConsentChallenge40(s:AuthoritativeReview40,
  phase:HumanPhase40,approvalId:string,nonceSha256:string,
  issuedAtMs:number,expiresAtMs:number):HumanConsentStatement40 {
  if(!validSnapshot(s)||!uuid.test(approvalId)||!hex256.test(nonceSha256)||
     !['APPLY','UNDO'].includes(phase)||
     !Number.isSafeInteger(issuedAtMs)||issuedAtMs<0||
     !Number.isSafeInteger(expiresAtMs)||expiresAtMs<=issuedAtMs||
     expiresAtMs-issuedAtMs>30_000||
     (phase==='APPLY'&&s.previousNativeEffectId!==null)||
     (phase==='UNDO'&&s.previousNativeEffectId===null)) {
    throw new Error('REVIEW_CHALLENGE_DENIED');
  }
  const p=s.preview;
  return Object.freeze({
    kind:'nexowire.coding.human-diff-consent.v1',scope:'LOCAL_HUMAN_SOURCE_ONLY',
    approvalId,nonceSha256,phase,requestId:s.requestId,
    taskId:p.identity.taskId,logicalMutationId:s.logicalMutationId,
    semanticEffectSha256:s.semanticEffectSha256,ownerId:s.ownerId,
    deviceId:s.deviceId,deviceEpoch:s.deviceEpoch,sessionEpoch:s.sessionEpoch,
    ownerEpoch:s.ownerEpoch,grantGeneration:s.grantGeneration,
    worktreeId:p.identity.worktreeId,
    worktreeIdentitySha256:s.worktreeIdentitySha256,
    gitBaseSha:p.identity.baseSha,gitSourceSha:p.identity.sourceSha,
    approvalEpoch:p.identity.approvalEpoch,
    accessBaseSha256:s.accessBaseSha256,accessDiffSha256:sha256(p.diff),
    beforeSha256:p.beforeSha256,beforeVersion:p.beforeVersion,
    afterSha256:p.afterSha256,patchFingerprintSha256:p.fingerprint,
    file:p.file,requestedMode:s.requestedMode,
    previousNativeEffectId:s.previousNativeEffectId,issuedAtMs,expiresAtMs,
  });
}

/** Reject mixing a valid #04 receipt with a different #40 human action. */
function accessReceiptMatches40(value:unknown,s:HumanConsentStatement40):boolean {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const envelope=value as Record<string,unknown>;
  if(typeof envelope.signature!=='string'||!envelope.statement||
     typeof envelope.statement!=='object'||Array.isArray(envelope.statement))return false;
  const r=envelope.statement as Record<string,unknown>;
  const intendedAction=s.phase==='APPLY'?'apply':'rollback';
  return r.kind==='nexowire.access.reviewed-diff-approval.v1'&&
    r.scope==='LOCAL_USER_REVIEW_ONLY'&&r.action===intendedAction&&
    r.approvalId===s.approvalId&&r.reviewNonce===s.nonceSha256&&
    r.requestId===s.requestId&&r.taskId===s.taskId&&
    r.logicalMutationId===s.logicalMutationId&&
    r.semanticEffectSha256===s.semanticEffectSha256&&
    r.ownerId===s.ownerId&&r.deviceId===s.deviceId&&
    r.deviceEpoch===s.deviceEpoch&&r.sessionEpoch===s.sessionEpoch&&
    r.ownerEpoch===s.ownerEpoch&&r.grantGeneration===s.grantGeneration&&
    r.worktreeIdentitySha256===s.worktreeIdentitySha256&&
    r.preimageSha256===s.beforeSha256&&
    r.baseSha256===s.accessBaseSha256&&r.diffSha256===s.accessDiffSha256&&
    r.requestedMode===s.requestedMode&&
    r.previousNativeEffectId===s.previousNativeEffectId&&
    r.issuedAtMs===s.issuedAtMs&&r.expiresAtMs===s.expiresAtMs;
}

export interface AccessSourceRequest40 {
  action:'apply'|'rollback';requestId:string;taskId:string;
  logicalMutationId:string;semanticEffectSha256:string;
  ownerId:string;deviceId:string;deviceEpoch:string;sessionEpoch:string;
  ownerEpoch:number;grantGeneration:number;requestedMode:'SAFE'|'FULL'|'ROOT'|'CORE';
  worktreeIdentitySha256:string;preimageSha256:string;
  baseSha256:string;diffSha256:string;previousNativeEffectId:string|null;
  clientCoreEffective?:never;clientApprovalGranted?:never;
}
export interface AccessSourceVerdict40 {
  status:'DENIED'|'PREVIEW_ONLY'|'APPROVED_SOURCE_ONLY_NO_MUTATION';
  localUserApprovalSourceVerified:boolean;
  effectiveElevatedPrivilege:false;nativeEffectVerified:false;
  canApply:false;canRollback:false;canLaunchElevated:false;
}
export interface HumanDiffReviewPorts40 {
  /** Must independently call #32 preview + #04 trusted owner/task binding. */
  readCurrent:(taskId:string)=>Promise<AuthoritativeReview40>;
  /** MUST call real #795 reviewAccessDiffApproval with trusted dependencies. */
  reviewAccessSource:(request:AccessSourceRequest40,
    signedAccessApproval:unknown)=>Promise<AccessSourceVerdict40>;
  /** The signer must represent a real explicit human action; no browser pref. */
  trustedLocalHumanPublicKey:KeyObject;
  now:()=>number;
}
export interface HumanDiffDecision40 {
  status:'DENIED'|'SOURCE_REVIEWED_NO_DISPATCH';
  reason:string;
  sourceConsentVerified:boolean;
  canApply:false;canUndo:false;canLaunchElevated:false;
  effectiveElevatedPrivilege:false;canBypassBroker:false;
}
const decision=(status:HumanDiffDecision40['status'],reason:string,
  verified=false):HumanDiffDecision40=>Object.freeze({
  status,reason,sourceConsentVerified:verified,canApply:false,canUndo:false,
  canLaunchElevated:false,effectiveElevatedPrivilege:false,canBypassBroker:false,
});

function verifyHumanTicket(v:SignedHumanConsent40,key:KeyObject):
  HumanConsentStatement40|null {
  try {
    if(!v||typeof v.signature!=='string'||
       !/^[A-Za-z0-9_-]{86}$/.test(v.signature)||
       !v.statement||typeof v.statement!=='object'||
       Array.isArray(v.statement)||!key||key.type!=='public'||
       key.asymmetricKeyType!=='ed25519')return null;
    const r=v.statement as Record<string,unknown>;
    if(!exactKeys(r)||r.kind!=='nexowire.coding.human-diff-consent.v1'||
       r.scope!=='LOCAL_HUMAN_SOURCE_ONLY'||!uuid.test(String(r.approvalId))||
       !hex256.test(String(r.nonceSha256))||
       (r.phase!=='APPLY'&&r.phase!=='UNDO')||
       !Number.isSafeInteger(r.issuedAtMs)||!Number.isSafeInteger(r.expiresAtMs))return null;
    const bytes=Buffer.from(v.signature,'base64url');
    if(bytes.length!==64||bytes.toString('base64url')!==v.signature)return null;
    const signed=r as unknown as HumanConsentStatement40;
    return verify(null,humanConsentSigningBytes40(signed),key,bytes)?signed:null;
  }catch{return null;}
}

/**
 * No true dispatch authorization is issued. Independent CAS + installed
 * protected Broker / scoped atomic file writer remain separate P0 gates.
 */
export async function reviewHumanDiffConsent40(
  taskId:string,phase:HumanPhase40,
  ticket:SignedHumanConsent40|null,signedAccessApproval:unknown,
  ports:HumanDiffReviewPorts40,
):Promise<HumanDiffDecision40> {
  try {
    if(!ticket||typeof taskId!=='string'||!taskId||
       (phase!=='APPLY'&&phase!=='UNDO'))return decision('DENIED','MISSING_CONSENT');
    const receipt=verifyHumanTicket(ticket,ports.trustedLocalHumanPublicKey);
    if(!receipt||receipt.phase!==phase||receipt.taskId!==taskId)
      return decision('DENIED','INVALID_OR_FORGED_HUMAN_CONSENT');
    const t0=ports.now();
    if(!Number.isSafeInteger(t0)||receipt.issuedAtMs>t0||
       t0>=receipt.expiresAtMs||t0-receipt.issuedAtMs>30_000||
       receipt.expiresAtMs-receipt.issuedAtMs>30_000)
      return decision('DENIED','EXPIRED_HUMAN_CONSENT');
    const first=await ports.readCurrent(taskId);
    const expected=humanConsentChallenge40(first,phase,receipt.approvalId,
      receipt.nonceSha256,receipt.issuedAtMs,receipt.expiresAtMs);
    if(humanConsentSigningBytes40(expected).compare(
      humanConsentSigningBytes40(receipt))!==0)
      return decision('DENIED','PATCH_TASK_OR_OWNER_CHANGED');
    if(!accessReceiptMatches40(signedAccessApproval,expected))
      return decision('DENIED','ACCESS_RECEIPT_NOT_SAME_HUMAN_ACTION');
    const request:AccessSourceRequest40={
      action:phase==='APPLY'?'apply':'rollback',requestId:expected.requestId,
      taskId:expected.taskId,logicalMutationId:expected.logicalMutationId,
      semanticEffectSha256:expected.semanticEffectSha256,
      ownerId:expected.ownerId,deviceId:expected.deviceId,
      deviceEpoch:expected.deviceEpoch,sessionEpoch:expected.sessionEpoch,
      ownerEpoch:expected.ownerEpoch,grantGeneration:expected.grantGeneration,
      requestedMode:expected.requestedMode,
      worktreeIdentitySha256:expected.worktreeIdentitySha256,
      preimageSha256:expected.beforeSha256,baseSha256:expected.accessBaseSha256,
      diffSha256:expected.accessDiffSha256,
      previousNativeEffectId:expected.previousNativeEffectId,
    };
    const access=await ports.reviewAccessSource(request,signedAccessApproval);
    if(!access||access.status!=='APPROVED_SOURCE_ONLY_NO_MUTATION'||
      access.localUserApprovalSourceVerified!==true||
      access.effectiveElevatedPrivilege!==false||
      access.nativeEffectVerified!==false||access.canApply!==false||
      access.canRollback!==false||access.canLaunchElevated!==false)
      return decision('DENIED','ACCESS_SIGNED_REVIEW_DENIED');
    // Re-observe *after* any awaits to reject simple patch, epoch and revoke
    // races. This is NOT an external linearizable effect-admission fence.
    const final=await ports.readCurrent(taskId);
    const live=humanConsentChallenge40(final,phase,receipt.approvalId,
      receipt.nonceSha256,receipt.issuedAtMs,receipt.expiresAtMs);
    const t1=ports.now();
    if(t1>=receipt.expiresAtMs||!Number.isSafeInteger(t1)||
      humanConsentSigningBytes40(live).compare(
        humanConsentSigningBytes40(receipt))!==0)
      return decision('DENIED','REVOKED_OR_PATCH_CHANGED_DURING_REVIEW');
    return decision('SOURCE_REVIEWED_NO_DISPATCH',
      'HUMAN_AND_ACCESS_REVIEW_SOURCE_ONLY_EXTERNAL_CAS_AND_NATIVE_GATES_BLOCKED',true);
  }catch {
    return decision('DENIED','TRUSTED_REVIEW_EVIDENCE_UNAVAILABLE');
  }
}
