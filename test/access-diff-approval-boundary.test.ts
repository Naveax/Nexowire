import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {
  diffApprovalSigningBytes,reviewAccessDiffApproval,
  type DiffApprovalReceipt,type ReviewedDiffRequest,
  type SignedDiffApprovalReceipt,type AccessDiffApprovalDependencies,
  type DiffReviewTrustedContext,
} from '../src/product/access-diff-approval-boundary.js';
import type {ProductDeviceRecord} from '../src/product/control-plane-store.js';
import type {AccessEffectiveAuthority}
 from '../src/product/access-effective-authority.js';

const key=generateKeyPairSync('ed25519');
const attacker=generateKeyPairSync('ed25519');
const ts=Date.parse('2026-10-22T20:00:00.000Z');
const ids={request:randomUUID(),device:'device-A',owner:'owner-A',
  deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),
  approval:randomUUID(),effect:randomUUID(),task:randomUUID(),
  logicalMutation:randomUUID()};
const semanticEffect='1'.repeat(64),worktree='2'.repeat(64),preimage='3'.repeat(64);
const base='a'.repeat(64),diff='b'.repeat(64);
const device={id:ids.device,ownerAccountId:ids.owner,
  credentialHash:'c'.repeat(64),online:true,platform:'win32',
  accessMode:'full',privilegeMode:'broker',adminBridgeReady:true} as ProductDeviceRecord;
const session={ownerAccountId:ids.owner,sessionHash:'d'.repeat(64),
  sessionExpiresAt:'2026-10-22T21:00:00.000Z',loginIsRevoked:false};
const req=(p:Partial<ReviewedDiffRequest>={}):ReviewedDiffRequest=>({
  action:'apply',requestId:ids.request,ownerId:ids.owner,
  taskId:ids.task,logicalMutationId:ids.logicalMutation,
  semanticEffectSha256:semanticEffect,worktreeIdentitySha256:worktree,
  preimageSha256:preimage,
  deviceId:ids.device,deviceEpoch:ids.deviceEpoch,
  sessionEpoch:ids.sessionEpoch,ownerEpoch:4,grantGeneration:7,
  requestedMode:'CORE',baseSha256:base,diffSha256:diff,
  previousNativeEffectId:null,clientCoreEffective:true,
  clientApprovalGranted:true,...p,
});
const approval=(r:ReviewedDiffRequest):DiffApprovalReceipt=>({
  kind:'nexowire.access.reviewed-diff-approval.v1',
  scope:'LOCAL_USER_REVIEW_ONLY',approvalId:ids.approval,
  reviewNonce:'e'.repeat(64),requestId:r.requestId,
  taskId:r.taskId,logicalMutationId:r.logicalMutationId,
  semanticEffectSha256:r.semanticEffectSha256,
  worktreeIdentitySha256:r.worktreeIdentitySha256,
  preimageSha256:r.preimageSha256,
  action:r.action==='preview'?'apply':r.action,
  ownerId:r.ownerId,deviceId:r.deviceId,deviceEpoch:r.deviceEpoch,
  sessionEpoch:r.sessionEpoch,ownerEpoch:r.ownerEpoch,
  grantGeneration:r.grantGeneration,requestedMode:r.requestedMode,
  baseSha256:r.baseSha256,diffSha256:r.diffSha256,
  previousNativeEffectId:r.previousNativeEffectId,
  issuedAtMs:ts-1000,expiresAtMs:ts+5000,
});
function signed(raw:unknown,privateKey=key.privateKey):SignedDiffApprovalReceipt{
  const statement=raw as DiffApprovalReceipt;
  let bytes:Buffer;
  try{bytes=diffApprovalSigningBytes(statement)}
  catch{bytes=Buffer.from(JSON.stringify(raw))}
  return {statement:raw,signature:sign(null,bytes,privateKey).toString('base64url')};
}
function fixture(p:{
  currentEpoch?:number;currentGeneration?:number;
  currentOwner?:string;currentDeviceEpoch?:string;currentSessionEpoch?:string;
  revoking?:boolean;revoked?:boolean;consumed?:boolean;
  pendingRevocation?:boolean;effectState?:'COMPLETED_VERIFIED'|'MUTATION_STATE_UNKNOWN'|'UNVERIFIED';
  nativeEffectVerified?:boolean;
  effective?:boolean;throwsCAS?:boolean;
  missingTaskProvider?:boolean;taskUnknown?:boolean;
  taskState?:'NOT_DISPATCHED_VERIFIED'|'MUTATION_STATE_UNKNOWN'|'COMPLETED_VERIFIED'|'UNVERIFIED';
  taskId?:string;logicalMutationId?:string;semanticEffectSha256?:string;
  worktreeIdentitySha256?:string;preimageSha256?:string;
  gitRootWithinApprovedScope?:boolean;gitMetadataWithinApprovedScope?:boolean;
  changedTaskOnSecondRead?:boolean;
  clock?:number;
  clockSequence?:number[];
}={}){
 let epochs=0,projects=0,nativeEffects=0,clockReads=0,taskReads=0;
 const ctx={device,session,corePreferenceEnabled:true,bridgeDesiredMode:'auto' as const,
   currentBaseSha256:base,currentDiffSha256:diff};
 const d:AccessDiffApprovalDependencies={
  trustedReviewPublicKey:key.publicKey,
  effectiveAuthority:{project:async()=>{
   projects++;
   return {state:p.effective===false?'PAUSED_UNVERIFIED':'EFFECTIVE',
     effective:p.effective!==false,
     authoritySource:p.effective===false?'none':'independent-protected-windows-broker',
     actualElevatedTokenVerified:p.effective!==false,
     brokerSourceAclVerified:true,brokerVersionVerified:true};
  }} as unknown as AccessEffectiveAuthority,
  readCurrentEpoch:async()=>{
   epochs++;
   if(p.throwsCAS)throw Error('CAS_OFFLINE');
   return {ownerId:p.currentOwner??ids.owner,
     deviceEpoch:p.currentDeviceEpoch??ids.deviceEpoch,
     sessionEpoch:p.currentSessionEpoch??ids.sessionEpoch,
     ownerEpoch:p.currentEpoch??4,grantGeneration:p.currentGeneration??7,
     revoking:p.pendingRevocation===true&&epochs===2?p.pendingRevocation:!!p.revoking,
     revoked:!!p.revoked};
  },
  readAuthenticatedTaskBinding:async()=>{
    taskReads++;
    if(p.missingTaskProvider)throw Error('NO_INDEPENDENT_TASK_READBACK');
    return {
      taskId:p.taskId??ids.task,
      logicalMutationId:p.logicalMutationId??ids.logicalMutation,
      semanticEffectSha256:p.semanticEffectSha256??semanticEffect,
      worktreeIdentitySha256:p.changedTaskOnSecondRead&&taskReads===2
        ?'f'.repeat(64):p.worktreeIdentitySha256??worktree,
      preimageSha256:p.preimageSha256??preimage,
      baseSha256:base,diffSha256:diff,
      ownerId:ids.owner,deviceId:ids.device,
      deviceEpoch:ids.deviceEpoch,sessionEpoch:ids.sessionEpoch,
      ownerEpoch:p.currentEpoch??4,grantGeneration:p.currentGeneration??7,
      gitRootWithinApprovedScope:p.gitRootWithinApprovedScope??true,
      gitMetadataWithinApprovedScope:p.gitMetadataWithinApprovedScope??true,
      mutationState:p.taskUnknown?'MUTATION_STATE_UNKNOWN':
        p.taskState??'NOT_DISPATCHED_VERIFIED',
    };
  },
  isApprovalConsumed:async()=>!!p.consumed,
  readNativeEffect:async effectId=>{
   nativeEffects++;
   return {effectId,requestId:ids.request,ownerId:ids.owner,
     deviceId:ids.device,appliedDiffSha256:diff,appliedBaseSha256:base,
     verified:p.nativeEffectVerified!==false,
     state:p.effectState??'COMPLETED_VERIFIED'};
  },
  now:()=>p.clockSequence?.[clockReads++]??p.clock??ts,
 };
 return {d,ctx,calls:()=>({epochs,projects,nativeEffects})};
}
test('preview is read-only, does not create or require approval and cannot silently enter CORE',async()=>{
 const x=fixture();
 const r=await reviewAccessDiffApproval(req({action:'preview'}),x.ctx,null,x.d);
 assert.equal(r.status,'PREVIEW_ONLY');
 assert.equal(r.requestedMode,'CORE');
 assert.equal(r.effectiveElevatedPrivilege,false);
 assert.equal(r.nativeEffectVerified,false);
 assert.equal(r.canApply,false);
 assert.equal(r.canLaunchElevated,false);
 assert.deepEqual(x.calls(),{epochs:0,projects:0,nativeEffects:0});
});

test('valid signed local review receipt and source CORE status remain separate from native effect or dispatch',async()=>{
 const x=fixture(),request=req();
 const r=await reviewAccessDiffApproval(request,x.ctx,signed(approval(request)),x.d);
 assert.equal(r.status,'APPROVED_SOURCE_ONLY_NO_MUTATION',r.reason);
 assert.equal(r.localUserApprovalSourceVerified,true);
 assert.equal(r.accessSourceCandidate,true);
 assert.equal(r.effectiveElevatedPrivilege,false);
 assert.equal(r.canApply,false);
 assert.equal(r.canRollback,false);
 assert.equal(r.nativeEffectVerified,false);
 assert.equal(r.needsPerCommandWindowsUac,false);
 assert.deepEqual(x.calls(),{epochs:2,projects:1,nativeEffects:0});
});

test('requested CORE and client approved=true without independently signed local approval are denied',async()=>{
 const r=req({clientCoreEffective:true,clientApprovalGranted:true});
 const x=fixture();
 assert.equal((await reviewAccessDiffApproval(r,x.ctx,null,x.d)).status,'DENIED');
 assert.equal((await reviewAccessDiffApproval(r,x.ctx,
   signed(approval(r),attacker.privateKey),x.d)).status,'DENIED');
 assert.equal(x.calls().projects,0);
});

test('stale diff, mismatched base SHA or wrong signed action/receipt scope cannot apply',async()=>{
 const incorrect=[
  req({baseSha256:'f'.repeat(64)}),
  req({diffSha256:'0'.repeat(64)}),
  req({ownerId:'other'}),
  req({deviceId:'another'}),
  req({deviceEpoch:randomUUID()}),
  req({sessionEpoch:randomUUID()}),
  req({ownerEpoch:10}),
  req({grantGeneration:8}),
  req({requestedMode:'ROOT'}),
  req({requestId:randomUUID()}),
 ];
 for(const request of incorrect){
  const x=fixture();
  const r=await reviewAccessDiffApproval(request,x.ctx,
    signed(approval(req())),x.d);
  assert.equal(r.status,'DENIED');
  assert.equal(r.canApply,false);
 }
 const x=fixture(),r=req();
 const mismatched=signed({...approval(r),action:'rollback'});
 assert.equal((await reviewAccessDiffApproval(r,x.ctx,mismatched,x.d)).status,'DENIED');
});

test('signed review receipt cannot be replayed, expanded or forged with JSON bool/type coercion',async()=>{
 const x=fixture({consumed:true}),r=req();
 assert.equal((await reviewAccessDiffApproval(r,x.ctx,
   signed(approval(r)),x.d)).reason,'APPROVAL_ALREADY_CONSUMED');
 const bad:Array<(x:DiffApprovalReceipt)=>Record<string,unknown>>=[
  a=>({...a,scope:'WINDOWS_HIGH_CONSENT'}),
  a=>({...a,ownerEpoch:'4'}),
  a=>({...a,grantGeneration:true}),
  a=>({...a,requestedMode:'CORE',elevated:true}),
  a=>({...a,action:'preview'}),
  a=>({...a,reviewNonce:null}),
  a=>({...a,expiresAtMs:String(a.expiresAtMs)}),
 ];
 for(const mutate of bad){
  const t=fixture();
  const result=await reviewAccessDiffApproval(r,t.ctx,
    signed(mutate(approval(r))),t.d);
  assert.equal(result.status,'DENIED');
  assert.equal(result.canLaunchElevated,false);
 }
});

test('remote revoke-start, owner transfer, device re-pair and session epoch invalidate diff approval',async()=>{
 for(const cfg of [
  {revoking:true},{revoked:true},{currentEpoch:5},
  {currentGeneration:8},{currentOwner:'new-owner'},
  {currentDeviceEpoch:randomUUID()},{currentSessionEpoch:randomUUID()},
  {pendingRevocation:true},{throwsCAS:true},
 ]){
  const f=fixture(cfg),r=req();
  const v=await reviewAccessDiffApproval(r,f.ctx,signed(approval(r)),f.d);
  assert.equal(v.status,'DENIED');
  assert.equal(v.canApply,false);
 }
});

test('CORE source EFFECTIVE requires fresh independently verified Access status, never client flag',async()=>{
 const f=fixture({effective:false}),r=req();
 const v=await reviewAccessDiffApproval(r,f.ctx,signed(approval(r)),f.d);
 assert.equal(v.status,'DENIED');
 assert.equal(v.reason,'INDEPENDENT_ELEVATED_AUTHORITY_UNVERIFIED');
 assert.equal(v.localUserApprovalSourceVerified,true);
 assert.equal(v.effectiveElevatedPrivilege,false);
});

test('FULL diff review does not inherit CORE elevation; same signed review is not high OS consent',async()=>{
 const f=fixture(),r=req({requestedMode:'FULL',clientCoreEffective:true});
 const v=await reviewAccessDiffApproval(r,f.ctx,signed(approval(r)),f.d);
 assert.equal(v.status,'APPROVED_SOURCE_ONLY_NO_MUTATION');
 assert.equal(v.accessSourceCandidate,false);
 assert.equal(v.canLaunchElevated,false);
 assert.equal(f.calls().projects,0);
});

test('rollback requires separate rollback-scope receipt and independent VERIFIED native effect; UNKNOWN never rolls back blindly',async()=>{
 const r=req({action:'rollback',previousNativeEffectId:ids.effect});
 for(const p of [
  {effectState:'MUTATION_STATE_UNKNOWN' as const},
  {effectState:'UNVERIFIED' as const},
  {nativeEffectVerified:false},
 ]){
   const f=fixture(p);
   const v=await reviewAccessDiffApproval(r,f.ctx,signed(approval(r)),f.d);
   assert.equal(v.status,'DENIED');
   assert.equal(v.reason,'ROLLBACK_NATIVE_EFFECT_UNVERIFIED_OR_UNKNOWN');
   assert.equal(v.canRollback,false);
 }
 const f=fixture();
 const v=await reviewAccessDiffApproval(r,f.ctx,signed(approval(r)),f.d);
 assert.equal(v.status,'APPROVED_SOURCE_ONLY_NO_MUTATION');
 assert.equal(v.nativeEffectVerified,false,'independent previous receipt != rollback executed');
 assert.equal(v.canRollback,false);
 assert.equal(f.calls().nativeEffects,1);
 const wrong=fixture();
 assert.equal((await reviewAccessDiffApproval(r,wrong.ctx,
   signed({...approval(r),previousNativeEffectId:randomUUID()}),wrong.d)).status,'DENIED');
});

test('expired local user review approval and closed owner login fail-closed without additional Windows UAC',async()=>{
 const r=req(),f=fixture({clock:ts+6000});
 const v=await reviewAccessDiffApproval(r,f.ctx,signed(approval(r)),f.d);
 assert.equal(v.status,'DENIED');
 assert.equal(v.needsPerCommandWindowsUac,false);
 const lost=fixture();
 const s={...lost.ctx,session:{...session,loginIsRevoked:true}};
 assert.equal((await reviewAccessDiffApproval(r,s,signed(approval(r)),lost.d)).status,'DENIED');
});

test('CORE preference OFF or SAFE Broker context cannot be overridden by synthetic signed review or source EFFECTIVE',async()=>{
 const r=req();
 for(const changes of [
  {corePreferenceEnabled:false},
  {bridgeDesiredMode:'off' as const},
  {device:{...device,accessMode:'safe'}},
  {device:{...device,privilegeMode:'direct'}},
 ]){
  const f=fixture();
  const ctx={...f.ctx,...changes} as DiffReviewTrustedContext;
  const v=await reviewAccessDiffApproval(r,ctx,signed(approval(r)),f.d);
  assert.equal(v.status,'DENIED');
  assert.equal(v.effectiveElevatedPrivilege,false);
  assert.equal(v.canApply,false);
 }
});

test('signed diff approval expired during external epoch readback never becomes source-approved',async()=>{
 const f=fixture({clockSequence:[ts,ts,ts+5001]});
 const r=req();
 const v=await reviewAccessDiffApproval(r,f.ctx,signed(approval(r)),f.d);
 assert.equal(v.status,'DENIED');
 assert.equal(v.reason,'OWNER_REVOKED_DURING_APPROVAL_REVIEW');
 assert.equal(v.nativeEffectVerified,false);
 assert.equal(v.canApply,false);
 assert.equal(f.calls().epochs,2);
});

test('#786 same Git base+diff SHA cannot approve a different linked-worktree root or Git metadata outside task scope',async()=>{
 for(const options of [
  {worktreeIdentitySha256:'f'.repeat(64)},
  {preimageSha256:'f'.repeat(64)},
  {gitRootWithinApprovedScope:false},
  {gitMetadataWithinApprovedScope:false},
  {missingTaskProvider:true},
 ]){
   const f=fixture(options),r=req();
   const v=await reviewAccessDiffApproval(r,f.ctx,signed(approval(r)),f.d);
   assert.equal(v.status,'DENIED');
   assert.equal(v.canApply,false);
   assert.equal(v.canLaunchElevated,false);
 }
});

test('signed approval for old task/worktree cannot be transplanted across task, logical operation or preimage',async()=>{
 const original=req();
 for(const request of [
   req({taskId:randomUUID()}),
   req({logicalMutationId:randomUUID()}),
   req({worktreeIdentitySha256:'f'.repeat(64)}),
   req({preimageSha256:'f'.repeat(64)}),
   req({semanticEffectSha256:'f'.repeat(64)}),
 ]){
  const f=fixture();
  const v=await reviewAccessDiffApproval(request,f.ctx,
    signed(approval(original)),f.d);
  assert.equal(v.status,'DENIED');
  assert.equal(v.canApply,false);
 }
 // Even freshly signed client fields require a separately authenticated
 // canonical task scope/semantic effect witness.
 for(const fields of [
  {taskId:randomUUID()},{logicalMutationId:randomUUID()},
  {worktreeIdentitySha256:'f'.repeat(64)},
  {semanticEffectSha256:'f'.repeat(64)},
 ]){
  const request=req(fields),f=fixture();
  const v=await reviewAccessDiffApproval(request,f.ctx,
    signed(approval(request)),f.d);
  assert.equal(v.status,'DENIED');
  assert.equal(v.reason,'TASK_WORKTREE_SCOPE_OR_UNKNOWN_MUTATION_STALE');
 }
});

test('#781 cloned durable runbook with new requestId cannot mask persisted UNKNOWN for same semantic effect',async()=>{
 const first=req(),clone=req({
  requestId:randomUUID(),taskId:randomUUID(),
  logicalMutationId:randomUUID(),
  // Cloning runbook names or task graph IDs does NOT change the
  // canonical semantic effect content hash.
  semanticEffectSha256:first.semanticEffectSha256,
 });
 const alreadyUnknown=fixture({taskUnknown:true});
 const f=await reviewAccessDiffApproval(first,alreadyUnknown.ctx,
   signed(approval(first)),alreadyUnknown.d);
 assert.equal(f.status,'DENIED');
 assert.equal(f.reason,'TASK_WORKTREE_SCOPE_OR_UNKNOWN_MUTATION_STALE');
 const duplicate=fixture({taskUnknown:true,taskId:clone.taskId,
   logicalMutationId:clone.logicalMutationId});
 const again=await reviewAccessDiffApproval(clone,duplicate.ctx,
   signed(approval(clone)),duplicate.d);
 assert.equal(again.status,'DENIED');
 assert.equal(again.reason,'TASK_WORKTREE_SCOPE_OR_UNKNOWN_MUTATION_STALE');
 assert.equal(again.canApply,false);
 assert.equal(again.canLaunchElevated,false);
});

test('a formerly approved diff goes stale when worktree identity changes during external CAS review',async()=>{
 const f=fixture({changedTaskOnSecondRead:true}),r=req();
 const v=await reviewAccessDiffApproval(r,f.ctx,signed(approval(r)),f.d);
 assert.equal(v.status,'DENIED');
 assert.equal(v.reason,'TASK_CHANGED_OR_UNKNOWN_DURING_APPROVAL_REVIEW');
 assert.equal(v.canApply,false);
});

test('even with valid local consent and source CORE, completed/unknown mutation requires reconciliation rather than new approval',async()=>{
 for(const taskState of [
  'COMPLETED_VERIFIED','UNVERIFIED','MUTATION_STATE_UNKNOWN',
 ] as const){
   const f=fixture({taskState}),r=req();
   const v=await reviewAccessDiffApproval(r,f.ctx,signed(approval(r)),f.d);
   assert.equal(v.status,'DENIED');
   assert.equal(v.canLaunchElevated,false);
 }
});

test('malformed signed task/semantic/worktree identity fields cannot bypass typed consent boundary',async()=>{
 const r=req();
 const mutated=[
  {...approval(r),taskId:'not-a-uuid'},
  {...approval(r),logicalMutationId:false},
  {...approval(r),semanticEffectSha256:7},
  {...approval(r),worktreeIdentitySha256:'wrong'},
  {...approval(r),preimageSha256:null},
 ];
 for(const payload of mutated){
  const f=fixture();
  const v=await reviewAccessDiffApproval(r,f.ctx,signed(payload),f.d);
  assert.equal(v.status,'DENIED');
  assert.equal(v.canLaunchElevated,false);
 }
});
