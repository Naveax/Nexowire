import {verify,type KeyObject} from 'node:crypto';
import * as z from 'zod';
import type {AccessEffectiveAuthority,EffectiveOwnerSession}
  from './access-effective-authority.js';
import type {ProductDeviceRecord} from './control-plane-store.js';

/**
 * #04 Access owner boundary for the P1 #780 reviewed diff workflow.
 * Approval is intent evidence, NOT an OS elevation, native effect, or
 * durable atomic dispatch permit. No file changes or Broker execution.
 */
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const uuid=z.string().uuid();
const diffApproval=z.strictObject({
  kind:z.literal('nexowire.access.reviewed-diff-approval.v1'),
  scope:z.literal('LOCAL_USER_REVIEW_ONLY'),
  approvalId:uuid,requestId:uuid,reviewNonce:sha,
  action:z.enum(['apply','rollback']),
  ownerId:z.string().min(1).max(128),deviceId:z.string().min(1).max(128),
  deviceEpoch:uuid,sessionEpoch:uuid,
  ownerEpoch:z.number().int().positive().safe(),
  grantGeneration:z.number().int().positive().safe(),
  requestedMode:z.enum(['SAFE','FULL','ROOT','CORE']),
  baseSha256:sha,diffSha256:sha,
  /** Rollback must be independently reviewed for a specific applied effect. */
  previousNativeEffectId:uuid.nullable(),
  issuedAtMs:z.number().int().nonnegative().safe(),
  expiresAtMs:z.number().int().positive().safe(),
});
export type DiffApprovalReceipt=z.infer<typeof diffApproval>;
export const diffApprovalSigningBytes=(x:DiffApprovalReceipt):Buffer=>{
  const r=diffApproval.parse(x);
  return Buffer.from(JSON.stringify([
    r.kind,r.scope,r.approvalId,r.requestId,r.reviewNonce,
    r.action,r.ownerId,r.deviceId,r.deviceEpoch,r.sessionEpoch,
    r.ownerEpoch,r.grantGeneration,r.requestedMode,r.baseSha256,
    r.diffSha256,r.previousNativeEffectId,r.issuedAtMs,r.expiresAtMs,
  ]),'utf8');
};
export interface SignedDiffApprovalReceipt{
  readonly statement:unknown;
  readonly signature:string;
}
export interface ReviewedDiffRequest{
  action:'preview'|'apply'|'rollback';
  requestId:string;ownerId:string;deviceId:string;
  deviceEpoch:string;sessionEpoch:string;
  ownerEpoch:number;grantGeneration:number;
  requestedMode:'SAFE'|'FULL'|'ROOT'|'CORE';
  baseSha256:string;diffSha256:string;
  previousNativeEffectId:string|null;
  /** Diagnostic only; cannot be converted to effective privilege. */
  clientCoreEffective?:boolean;
  clientApprovalGranted?:boolean;
}
export interface DiffReviewTrustedContext{
  device:ProductDeviceRecord;
  session:EffectiveOwnerSession|null;
  currentBaseSha256:string;
  currentDiffSha256:string;
  /** Current owner enrollment and root policy, never a UI claim. */
  corePreferenceEnabled:boolean;
  bridgeDesiredMode:'auto'|'on'|'off';
}
export interface AccessDiffApprovalDependencies{
  readonly trustedReviewPublicKey:KeyObject;
  readonly effectiveAuthority:AccessEffectiveAuthority;
  /** Server-provisioned live external readback, not the signed approval. */
  readonly readCurrentEpoch:(deviceId:string)=>Promise<{
    ownerId:string;deviceEpoch:string;sessionEpoch:string;
    ownerEpoch:number;grantGeneration:number;
    revoking:boolean;revoked:boolean;
  }>;
  /** Durable one-time approval ledger, not an in-memory UI flag. */
  readonly isApprovalConsumed:(approvalId:string)=>Promise<boolean>;
  /** Rollback requires an independent authenticated prior EFFECT receipt. */
  readonly readNativeEffect:(effectId:string)=>Promise<{
    verified:boolean;effectId:string;requestId:string;
    ownerId:string;deviceId:string;
    appliedDiffSha256:string;appliedBaseSha256:string;
    state:'COMPLETED_VERIFIED'|'MUTATION_STATE_UNKNOWN'|'UNVERIFIED';
  }>;
  readonly now?:()=>number;
}
export interface DiffAccessReview{
  status:'PREVIEW_ONLY'|'DENIED'|'APPROVED_SOURCE_ONLY_NO_MUTATION';
  reason:string;
  requestedMode:ReviewedDiffRequest['requestedMode'];
  /** This reviewer never attests an installed physical HIGH-token Broker. */
  accessSourceCandidate:boolean;
  effectiveElevatedPrivilege:false;
  localUserApprovalSourceVerified:boolean;
  nativeEffectVerified:false;
  canApply:false;
  canRollback:false;
  canLaunchElevated:false;
  needsPerCommandWindowsUac:false;
}
const deny=(x:ReviewedDiffRequest,reason:string,status:DiffAccessReview['status']='DENIED',
  approved=false,source=false):DiffAccessReview=>Object.freeze({
    status,reason,requestedMode:x.requestedMode,accessSourceCandidate:source,
    effectiveElevatedPrivilege:false,localUserApprovalSourceVerified:approved,
    nativeEffectVerified:false,canApply:false,canRollback:false,
    canLaunchElevated:false,needsPerCommandWindowsUac:false,
  });
function isSigned(x:SignedDiffApprovalReceipt,key:KeyObject):DiffApprovalReceipt|null{
  try{
    const r=diffApproval.safeParse(x?.statement);
    if(!r.success||key?.type!=='public'||key.asymmetricKeyType!=='ed25519'||
      typeof x.signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(x.signature))return null;
    const bytes=Buffer.from(x.signature,'base64url');
    if(bytes.length!==64||bytes.toString('base64url')!==x.signature||
      !verify(null,diffApprovalSigningBytes(r.data),key,bytes))return null;
    return r.data;
  }catch{return null}
}
/**
 * SOURCE review only. #780's task/worktree engine and actual file mutations
 * are separate owners. #01 atomic commit and #03 physical installed Broker
 * remain hard requirements before any elevated action.
 */
export async function reviewAccessDiffApproval(
  request:ReviewedDiffRequest,
  context:DiffReviewTrustedContext,
  signedApproval:SignedDiffApprovalReceipt|null,
  dependencies:AccessDiffApprovalDependencies,
):Promise<DiffAccessReview>{
  if(request.action==='preview'){
    return deny(request,'READ_ONLY_PREVIEW_NOT_APPROVAL','PREVIEW_ONLY');
  }
  try{
    const now=(dependencies.now??Date.now)();
    const session=context.session;
    const dev=context.device;
    if(!Number.isSafeInteger(now)||!session||session.loginIsRevoked||
      Date.parse(session.sessionExpiresAt)<=now||
      dev.id!==request.deviceId||dev.ownerAccountId!==request.ownerId||
      session.ownerAccountId!==request.ownerId||
      !uuid.safeParse(request.requestId).success||
      !uuid.safeParse(request.deviceEpoch).success||
      !uuid.safeParse(request.sessionEpoch).success||
      !sha.safeParse(request.baseSha256).success||
      !sha.safeParse(request.diffSha256).success||
      request.baseSha256!==context.currentBaseSha256||
      request.diffSha256!==context.currentDiffSha256){
      return deny(request,'OWNER_LOGIN_OR_GIT_SOURCE_STALE');
    }
    const grant=isSigned(signedApproval!,dependencies.trustedReviewPublicKey);
    if(!grant||grant.action!==request.action||
      grant.requestId!==request.requestId||
      grant.ownerId!==request.ownerId||grant.deviceId!==request.deviceId||
      grant.deviceEpoch!==request.deviceEpoch||
      grant.sessionEpoch!==request.sessionEpoch||
      grant.ownerEpoch!==request.ownerEpoch||
      grant.grantGeneration!==request.grantGeneration||
      grant.requestedMode!==request.requestedMode||
      grant.baseSha256!==request.baseSha256||
      grant.diffSha256!==request.diffSha256||
      grant.previousNativeEffectId!==request.previousNativeEffectId||
      grant.issuedAtMs>now+1000||now-grant.issuedAtMs>60000||
      grant.expiresAtMs<=now||grant.expiresAtMs-grant.issuedAtMs>60000){
      return deny(request,'LOCAL_REVIEW_APPROVAL_INVALID_OR_STALE');
    }
    if(await dependencies.isApprovalConsumed(grant.approvalId)){
      return deny(request,'APPROVAL_ALREADY_CONSUMED');
    }
    // Correctly signed review grant is NOT a rollback postcondition.
    if(request.action==='rollback'){
      if(!uuid.safeParse(request.previousNativeEffectId).success)
        return deny(request,'ROLLBACK_TARGET_MISSING');
      const effect=await dependencies.readNativeEffect(request.previousNativeEffectId!);
      if(!effect||effect.verified!==true||
        effect.state!=='COMPLETED_VERIFIED'||
        effect.effectId!==request.previousNativeEffectId||
        effect.ownerId!==request.ownerId||effect.deviceId!==request.deviceId||
        effect.appliedDiffSha256!==request.diffSha256||
        effect.appliedBaseSha256!==request.baseSha256){
        return deny(request,'ROLLBACK_NATIVE_EFFECT_UNVERIFIED_OR_UNKNOWN');
      }
    }else if(request.previousNativeEffectId!==null){
      return deny(request,'APPLY_REUSES_ROLLBACK_RECEIPT');
    }
    const e=await dependencies.readCurrentEpoch(request.deviceId);
    if(!e||e.revoking!==false||e.revoked!==false||
      e.ownerId!==request.ownerId||e.deviceEpoch!==request.deviceEpoch||
      e.sessionEpoch!==request.sessionEpoch||
      e.ownerEpoch!==request.ownerEpoch||
      e.grantGeneration!==request.grantGeneration){
      return deny(request,'EXTERNAL_OWNER_EPOCH_REVOKED_OR_REPAIRED');
    }
    let elevatedSource=false;
    if(request.requestedMode==='CORE'&&(!context.corePreferenceEnabled||
      dev.platform!=='win32'||dev.accessMode!=='full'||!dev.online||
      dev.privilegeMode!=='broker'||context.bridgeDesiredMode==='off')){
      return deny(request,'CORE_PREFERENCE_NOT_EFFECTIVE',undefined,true);
    }
    if(request.requestedMode==='ROOT'&&(
      dev.platform!=='win32'||dev.accessMode!=='full'||!dev.online||
      dev.privilegeMode!=='broker'||context.bridgeDesiredMode==='off')){
      return deny(request,'ROOT_BROKER_NOT_EFFECTIVE',undefined,true);
    }
    if(request.requestedMode==='ROOT'||request.requestedMode==='CORE'){
      // UI requested CORE, local approval, and Agent ready are never native
      // EFFECTIVE authority. Re-project from D1 and independent proof.
      const current=await dependencies.effectiveAuthority.project({
        device:dev,mode:request.requestedMode,session,
        corePreferenceEnabled:context.corePreferenceEnabled,
        bridgeDesiredMode:context.bridgeDesiredMode,
      });
      if(!current.effective||current.state!=='EFFECTIVE'||
        current.authoritySource!=='independent-protected-windows-broker'||
        !current.actualElevatedTokenVerified||
        !current.brokerSourceAclVerified||
        !current.brokerVersionVerified){
        return deny(request,'INDEPENDENT_ELEVATED_AUTHORITY_UNVERIFIED',undefined,true);
      }
      elevatedSource=true;
    }
    // Catch remote revoke that begins while native/effective checks are
    // pending; still not an atomic effect fence (production stays blocked).
    const last=await dependencies.readCurrentEpoch(request.deviceId);
    if(!last||last.revoking!==false||last.revoked!==false||
      last.ownerId!==request.ownerId||last.deviceEpoch!==request.deviceEpoch||
      last.sessionEpoch!==request.sessionEpoch||
      last.ownerEpoch!==request.ownerEpoch||
      last.grantGeneration!==request.grantGeneration||
      Date.parse(session.sessionExpiresAt)<=(dependencies.now??Date.now)()||
      grant.expiresAtMs<=(dependencies.now??Date.now)()) {
      return deny(request,'OWNER_REVOKED_DURING_APPROVAL_REVIEW',undefined,true);
    }
    return deny(request,'REVIEW_APPROVAL_NOT_NATIVE_EFFECT_OR_ATOMIC_DISPATCH',
      'APPROVED_SOURCE_ONLY_NO_MUTATION',true,elevatedSource);
  }catch{
    return deny(request,'EXTERNAL_REVIEW_EVIDENCE_UNAVAILABLE');
  }
}
