import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {
  humanConsentChallenge40,humanConsentSigningBytes40,reviewHumanDiffConsent40,
  type AuthoritativeReview40,type SignedHumanConsent40,
  type HumanDiffReviewPorts40,type HumanPhase40,type AccessSourceVerdict40,
} from '../src/coding/human-diff-review-authority.js';

const localHuman=generateKeyPairSync('ed25519');
const forgery=generateKeyPairSync('ed25519');
const at=1_800_000_000_000;
const sha=(char:string)=>char.repeat(64);
const green:AccessSourceVerdict40={
  status:'APPROVED_SOURCE_ONLY_NO_MUTATION',localUserApprovalSourceVerified:true,
  effectiveElevatedPrivilege:false,nativeEffectVerified:false,
  canApply:false,canRollback:false,canLaunchElevated:false,
};
function snapshot():AuthoritativeReview40 {
  const taskId=randomUUID();
  return {
    preview:{identity:{ownerId:'owner-1',taskId,worktreeId:'task-wt-1',
      worktreeRoot:'/isolated/TEMP/task-wt-1',baseSha:'a'.repeat(40),
      sourceSha:'b'.repeat(40),approvalEpoch:9},
      file:'src/main.ts',beforeSha256:sha('c'),beforeVersion:'generation:17',
      afterSha256:sha('d'),fingerprint:sha('e'),
      diff:'diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n'},
    requestId:randomUUID(),logicalMutationId:randomUUID(),
    semanticEffectSha256:sha('f'),ownerId:'owner-1',deviceId:'device-1',
    deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),ownerEpoch:4,
    grantGeneration:6,worktreeIdentitySha256:sha('1'),
    accessBaseSha256:sha('2'),requestedMode:'FULL',
    previousNativeEffectId:null,scopeVerified:true,
    gitMetadataWithinScope:true,revoking:false,revoked:false,
    mutationState:'NOT_DISPATCHED_VERIFIED',
  };
}
function ticket(s:AuthoritativeReview40,phase:HumanPhase40='APPLY',
  privateKey=localHuman.privateKey,issuedAt=at-1000,expiresAt=at+10000):
  SignedHumanConsent40 {
  const r=humanConsentChallenge40(s,phase,randomUUID(),sha('3'),issuedAt,expiresAt);
  return {statement:r,signature:sign(null,humanConsentSigningBytes40(r),privateKey)
    .toString('base64url')};
}
function harness(overrides:{
  snap?:AuthoritativeReview40;
  second?:AuthoritativeReview40;
  phase?:HumanPhase40;
  signer?:typeof localHuman.privateKey;
  time?:number;
  access?:AccessSourceVerdict40;
  failAccess?:boolean;
  failRead?:boolean;
}={}) {
  const s=overrides.snap??snapshot();
  const t=ticket(s,overrides.phase??'APPLY',overrides.signer??localHuman.privateKey);
  const consent=t.statement as ReturnType<typeof humanConsentChallenge40>;
  // Structural #795 receipt fixture only. Real #04 signature verification
  // must run in the production reviewAccessSource adapter, not this stub.
  const sourceApproval={statement:{
    kind:'nexowire.access.reviewed-diff-approval.v1',
    scope:'LOCAL_USER_REVIEW_ONLY',approvalId:consent.approvalId,
    reviewNonce:consent.nonceSha256,
    action:consent.phase==='APPLY'?'apply':'rollback',
    requestId:consent.requestId,taskId:consent.taskId,
    logicalMutationId:consent.logicalMutationId,
    semanticEffectSha256:consent.semanticEffectSha256,ownerId:consent.ownerId,
    deviceId:consent.deviceId,deviceEpoch:consent.deviceEpoch,
    sessionEpoch:consent.sessionEpoch,ownerEpoch:consent.ownerEpoch,
    grantGeneration:consent.grantGeneration,
    worktreeIdentitySha256:consent.worktreeIdentitySha256,
    preimageSha256:consent.beforeSha256,baseSha256:consent.accessBaseSha256,
    diffSha256:consent.accessDiffSha256,requestedMode:consent.requestedMode,
    previousNativeEffectId:consent.previousNativeEffectId,
    issuedAtMs:consent.issuedAtMs,expiresAtMs:consent.expiresAtMs,
  },signature:'SOURCE_ONLY_FIXTURE_NOT_CRYPTOGRAPHIC'};
  let readCount=0,accessCount=0;
  const ports:HumanDiffReviewPorts40={
    trustedLocalHumanPublicKey:localHuman.publicKey,
    now:()=>overrides.time??at,
    readCurrent:async()=>{
      readCount++;
      if(overrides.failRead)throw new Error('PROVIDER_OFFLINE');
      return readCount===2&&overrides.second?overrides.second:s;
    },
    reviewAccessSource:async(r,receipt)=>{
      accessCount++;
      // Adapter is invoked ONLY server side. Production wiring MUST call
      // real #795; this stub is deliberately NOT #04 signature validation.
      assert.equal(receipt,sourceApproval);
      assert.equal(r.requestId,s.requestId);
      assert.equal(r.taskId,s.preview.identity.taskId);
      assert.equal(r.preimageSha256,s.preview.beforeSha256);
      assert.equal(r.action,(overrides.phase??'APPLY')==='APPLY'?'apply':'rollback');
      assert.equal(r.clientCoreEffective,undefined);
      if(overrides.failAccess)throw new Error('ACCESS_OFFLINE');
      return overrides.access??green;
    },
  };
  return {s,t,sourceApproval,ports,reads:()=>readCount,accessCalls:()=>accessCount};
}
async function inspect(h:ReturnType<typeof harness>,
  phase:HumanPhase40='APPLY', signed:SignedHumanConsent40|null=h.t) {
  return reviewHumanDiffConsent40(h.s.preview.identity.taskId,phase,
    signed,h.sourceApproval,h.ports);
}

test('valid two-source human and #04-style verdict is NEVER native Git/CORE admission',async()=>{
  const h=harness();
  const d=await inspect(h);
  assert.equal(d.status,'SOURCE_REVIEWED_NO_DISPATCH');
  assert.equal(d.sourceConsentVerified,true);
  assert.equal(d.canApply,false);
  assert.equal(d.canUndo,false);
  assert.equal(d.canLaunchElevated,false);
  assert.equal(d.effectiveElevatedPrivilege,false);
  assert.equal(d.canBypassBroker,false);
  assert.equal(h.reads(),2);
  assert.equal(h.accessCalls(),1);
});

test('stale human consent 30-second limit fails before any provider operation',async()=>{
  const h=harness({time:at+10001});
  const d=await inspect(h);
  assert.equal(d.reason,'EXPIRED_HUMAN_CONSENT');
  assert.equal(h.reads(),0);
  assert.equal(h.accessCalls(),0);
});

test('cloned task ID with same patch/owner rejects previously signed task consent',async()=>{
  const h=harness();
  const clonedTask=randomUUID();
  const s=h.s;
  const result=await reviewHumanDiffConsent40(clonedTask,'APPLY',h.t,
    h.sourceApproval,{...h.ports,readCurrent:async()=>({
      ...s,preview:{...s.preview,identity:{...s.preview.identity,
        taskId:clonedTask}},
    })});
  assert.equal(result.status,'DENIED');
  assert.equal(result.reason,'INVALID_OR_FORGED_HUMAN_CONSENT');
});

test('forged approval signed by an unrelated Ed25519 key fails closed',async()=>{
  const h=harness({signer:forgery.privateKey});
  assert.equal((await inspect(h)).reason,'INVALID_OR_FORGED_HUMAN_CONSENT');
  assert.equal(h.accessCalls(),0);
});

test('tampered signed preview fingerprint, SHA or consent field cannot pass',async()=>{
  const h=harness();
  for(const update of [
    {patchFingerprintSha256:sha('4')},{gitBaseSha:'8'.repeat(40)},
    {gitSourceSha:'9'.repeat(40)},{approvalEpoch:10},
    {ownerEpoch:5},{worktreeId:'different'},{file:'elsewhere'},
    {scope:'NATIVE_HIGH_GRANT'},{phase:'UNDO'},{unknownExtra:true},
  ]){
    const v={statement:{...(h.t.statement as object),...update},
      signature:h.t.signature};
    assert.equal((await inspect(h,'APPLY',v)).status,'DENIED');
  }
  assert.equal(h.accessCalls(),0);
});

test('correctly signed prior approval cannot authorize different patch/diff/version/source',async()=>{
  for(const mutation of [
    (s:AuthoritativeReview40)=>s.preview.fingerprint=sha('4'),
    (s:AuthoritativeReview40)=>s.preview.beforeVersion='generation:18',
    (s:AuthoritativeReview40)=>s.preview.identity.sourceSha='7'.repeat(40),
    (s:AuthoritativeReview40)=>s.preview.identity.baseSha='8'.repeat(40),
    (s:AuthoritativeReview40)=>s.preview.diff+='\n+extra\n',
    (s:AuthoritativeReview40)=>s.preview.afterSha256=sha('9'),
    (s:AuthoritativeReview40)=>s.worktreeIdentitySha256=sha('a'),
  ]){
    const h=harness();
    const changed=structuredClone(h.s);
    mutation(changed);
    const d=await inspect({...h,ports:{...h.ports,readCurrent:async()=>changed}});
    assert.equal(d.status,'DENIED');
    assert.equal(d.reason,'PATCH_TASK_OR_OWNER_CHANGED');
  }
});

test('revocation/owner epoch change before review fails closed',async()=>{
  for(const mutation of [
    (s:AuthoritativeReview40)=>s.revoking=true,
    (s:AuthoritativeReview40)=>s.revoked=true,
    (s:AuthoritativeReview40)=>s.ownerEpoch++,
    (s:AuthoritativeReview40)=>s.grantGeneration++,
    (s:AuthoritativeReview40)=>s.gitMetadataWithinScope=false,
    (s:AuthoritativeReview40)=>s.scopeVerified=false,
    (s:AuthoritativeReview40)=>s.mutationState='MUTATION_STATE_UNKNOWN' as const,
  ]) {
    const h=harness(),s=structuredClone(h.s);
    mutation(s);
    const d=await inspect({...h,ports:{...h.ports,readCurrent:async()=>s}});
    assert.equal(d.status,'DENIED');
    assert.equal(d.canApply,false);
  }
});

test('revoke or patch swap during #04 async review fails second read',async()=>{
  const h=harness();
  const changed=structuredClone(h.s);
  changed.revoking=true;
  const d=await inspect({...h,ports:{...h.ports,readCurrent:
    (()=>{let n=0;return async()=>++n===1?h.s:changed;})()}});
  assert.equal(d.status,'DENIED');
  assert.equal(d.canBypassBroker,false);
});

test('cross-mixed #04 signed receipt from a different approval ID or nonce is denied',async()=>{
  for(const field of ['approvalId','reviewNonce','requestId','taskId',
    'baseSha256','diffSha256','expiresAtMs'] as const){
    const h=harness();
    const mismatched={...h.sourceApproval,statement:{...h.sourceApproval.statement,
      [field]:field==='expiresAtMs'?at+9000:'forged-other-action'}};
    const d=await reviewHumanDiffConsent40(h.s.preview.identity.taskId,'APPLY',
      h.t,mismatched,h.ports);
    assert.equal(d.status,'DENIED');
    assert.equal(d.reason,'ACCESS_RECEIPT_NOT_SAME_HUMAN_ACTION');
    assert.equal(h.accessCalls(),0);
  }
});

test('browser preference or fake source with canApply=true cannot become approval',async()=>{
  const h=harness({access:{...green,canApply:true} as unknown as AccessSourceVerdict40});
  const d=await inspect(h);
  assert.equal(d.reason,'ACCESS_SIGNED_REVIEW_DENIED');
  assert.equal(d.canApply,false);
});

test('missing #04 real verifier or provider error fails closed',async()=>{
  const h=harness({failAccess:true});
  assert.equal((await inspect(h)).reason,'TRUSTED_REVIEW_EVIDENCE_UNAVAILABLE');
  const h2=harness({failRead:true});
  assert.equal((await inspect(h2)).status,'DENIED');
});

test('apply and undo use distinct signed human intent plus #04 action',async()=>{
  const s=snapshot();
  s.previousNativeEffectId=randomUUID();
  const h=harness({snap:s,phase:'UNDO'});
  assert.equal((await inspect(h,'UNDO')).status,'SOURCE_REVIEWED_NO_DISPATCH');
  assert.equal((await inspect(h,'APPLY')).status,'DENIED');
  assert.equal((await inspect(h,'UNDO',null)).status,'DENIED');
});

test('UNKNOWN logical mutation blocks re-review regardless of cloned request ID',async()=>{
  const h=harness();
  const mutated=structuredClone(h.s);
  mutated.requestId=randomUUID();
  mutated.logicalMutationId=randomUUID();
  mutated.mutationState='MUTATION_STATE_UNKNOWN';
  const d=await inspect({...h,ports:{...h.ports,readCurrent:async()=>mutated}});
  assert.equal(d.status,'DENIED');
  assert.equal(d.canApply,false);
});

test('NEXT2: same-phase replay is SOURCE-ONLY, not durable one-use proof or patch admission',async()=>{
  const h=harness();
  // #795's isApprovalConsumed is a read-only dependency and #40 has no
  // durable atomic consume operation. Deliberately demonstrate that source
  // verification can be repeated with an unchanged ticket and snapshot.
  const first=await inspect(h,'APPLY');
  const repeated=await inspect(h,'APPLY');
  assert.equal(first.status,'SOURCE_REVIEWED_NO_DISPATCH');
  assert.equal(repeated.status,'SOURCE_REVIEWED_NO_DISPATCH');
  assert.equal(h.accessCalls(),2);
  for(const verdict of [first,repeated]){
    assert.equal(verdict.canApply,false);
    assert.equal(verdict.canUndo,false);
    assert.equal(verdict.canLaunchElevated,false);
    assert.equal(verdict.canBypassBroker,false);
    assert.equal(verdict.effectiveElevatedPrivilege,false);
  }
  // Re-labeling the same signed APPLY source as #32 UNDO is denied BEFORE
  // invoking the #04 source verifier, independent of UI review preferences.
  const opposite=await inspect(h,'UNDO');
  assert.equal(opposite.status,'DENIED');
  assert.equal(opposite.reason,'INVALID_OR_FORGED_HUMAN_CONSENT');
  assert.equal(h.accessCalls(),2);
});

test('NEXT2: #32 opaque approval ticket cannot be synthesized from #48 review intent',async()=>{
  const h=harness();
  const uiIntent={
    kind:'NEXOWIRE_CODING_REVIEW_INTENT_REQUEST_V1',
    requestedAction:'REVIEW_PATCH',signedApproval:false,
    consumedApproval:false,canApply:false,canRollback:false,
  };
  const denied=await reviewHumanDiffConsent40(h.s.preview.identity.taskId,
    'APPLY',{statement:uiIntent,signature:'signed-by-browser-preference'},
    uiIntent,h.ports);
  assert.equal(denied.status,'DENIED');
  assert.equal(denied.sourceConsentVerified,false);
  assert.equal(denied.canApply,false);
  assert.equal(denied.canUndo,false);
  assert.equal(denied.canLaunchElevated,false);
  assert.equal(h.accessCalls(),0);
});
