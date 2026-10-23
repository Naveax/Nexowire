import test from 'node:test';
import assert from 'node:assert/strict';
import {projectTaskReview,makeReviewIntent,mountTaskReview}
  from '../web/coding-task-review.mjs';

const NOW=1_800_000_000_000;
const H='a'.repeat(64),J='b'.repeat(64),C='c'.repeat(64),D='d'.repeat(64);
const E='e'.repeat(64),F='f'.repeat(64);
function fixture(){
  const scope={
    ownerId:'owner-A',deviceId:'device-A',taskId:'task-A',
    logicalMutationId:'mutation-original',requestId:'request-original',
    gitBaseSha:'1'.repeat(40),gitSourceSha:'2'.repeat(40),
    worktreeIdentitySha256:H,preimageSha256:J,
    baseSha256:C,sourceSha256:D,diffSha256:E,semanticEffectSha256:F,
    deviceEpoch:'device-epoch-1',sessionEpoch:'session-epoch-1',
    ownerEpoch:8,grantGeneration:5
  };
  return {
    proposed:{scope:{...scope},
      files:[{path:'src/safe.ts',status:'modified',additions:1,deletions:1}],
      diff:'diff --git a/src/safe.ts b/src/safe.ts\n-old\n+new\n'},
    current:{scope:{...scope},revoking:false,revoked:false,conflict:false,
      effectState:'NOT_DISPATCHED_VERIFIED'},
    intentExpiresAtMs:NOW+60000,proof:{},
  };
}
test('#48 clean preview allows review INTENT only; never native authority',()=>{
  const f=fixture();
  const v=projectTaskReview(f,NOW);
  assert.equal(v.status,'REVIEW_INTENT_ONLY');
  assert.equal(v.canRecordIntent,true);
  assert.equal(v.canDispatch,false);
  assert.equal(v.canApply,false);
  assert.equal(v.canRollback,false);
  assert.equal(v.physicalVerified,false);
  assert.equal(v.effectiveWindowsHigh,false);
  assert.equal(v.additions,1);
  const intent=makeReviewIntent(f,NOW);
  assert.ok(intent);
  assert.equal(intent.signedApproval,false);
  assert.equal(intent.canDispatch,false);
  assert.equal(intent.requestedAction,'REVIEW_PATCH');
  assert.equal(intent.scope.logicalMutationId,'mutation-original');
  assert.equal(Object.isFrozen(intent),true);
  assert.equal(Object.isFrozen(intent.scope),true);
});
test('#48 forged signed/native/CAS/physical flags cannot flip physical verified',()=>{
  const f=fixture();
  Object.assign(f.proof,{physicalVerified:true,nativeHigh:true,externalCas:true});
  (f as Record<string,unknown>).canApply=true;
  const v=projectTaskReview(f,NOW);
  assert.equal(v.canRecordIntent,false);
  assert.equal(v.canDispatch,false);
  assert.equal(v.physicalEvidence,'NOT_PHYSICALLY_VERIFIED');
  assert.ok(v.reasons.includes('UNTRUSTED_PHYSICAL_PROOF_CLAIM'));
  assert.equal(makeReviewIntent(f,NOW),null);
});
test('#48 changed source/diff/base/worktree/preimage and cloned request block intent',()=>{
  for(const key of ['gitBaseSha','gitSourceSha','sourceSha256','diffSha256','baseSha256','worktreeIdentitySha256',
    'preimageSha256','logicalMutationId','requestId','ownerId','deviceId']){
    const f=fixture();
    const scope=f.current.scope as Record<string,string|number>;
    scope[key]=key.endsWith('Sha256')?H:key.startsWith('git')?'3'.repeat(40):'cloned-or-stale';
    if(scope[key]===f.proposed.scope[key as keyof typeof f.proposed.scope])
      scope[key]=J;
    const v=projectTaskReview(f,NOW);
    assert.ok(v.reasons.includes('STALE_REVISION_OR_OWNER_EPOCH'),key);
    assert.equal(v.canRecordIntent,false,key);
  }
});
test('#48 expired owner epoch, re-pair generation and active revoke deny',()=>{
  for(const field of ['ownerEpoch','grantGeneration'] as const){
    const f=fixture();
    f.current.scope[field]++;
    assert.ok(projectTaskReview(f,NOW).reasons.includes('STALE_REVISION_OR_OWNER_EPOCH'));
  }
  for(const state of [{revoking:true},{revoked:true},{revoking:undefined}]){
    const f=fixture();
    Object.assign(f.current,state);
    assert.ok(projectTaskReview(f,NOW).reasons.includes('OWNER_EPOCH_REVOKED_OR_UNVERIFIED'));
  }
});
test('#48 UNKNOWN remains reconciliation not replay, completed is post-effect',()=>{
  const f=fixture();
  f.current.effectState='MUTATION_STATE_UNKNOWN';
  let v=projectTaskReview(f,NOW);
  assert.equal(v.canRecordIntent,false);
  assert.ok(v.reasons.includes('UNKNOWN_RECONCILE_REQUIRED'));
  assert.equal(makeReviewIntent(f,NOW),null);
  f.current.effectState='COMPLETED_VERIFIED';
  v=projectTaskReview(f,NOW);
  assert.ok(v.reasons.includes('POST_EFFECT_REVIEW_CANNOT_UNDO_EFFECT'));
  assert.equal(v.canRollback,false);
  f.current.effectState='NOT_DISPATCHED_VERIFIED';
  f.current.conflict=true;
  assert.ok(projectTaskReview(f,NOW).reasons.includes('WORKTREE_CONFLICT_OR_UNVERIFIED'));
});
test('#48 intent window: missing, expired, exact timeout, excessive TTL and invalid clock deny',()=>{
  for(const deadline of [NOW-1,NOW,NOW+300001,NaN,-1]){
    const f=fixture();
    f.intentExpiresAtMs=deadline;
    assert.equal(makeReviewIntent(f,NOW),null,String(deadline));
  }
  assert.equal(makeReviewIntent(fixture(),NaN),null);
  const f=fixture();f.intentExpiresAtMs=NOW+300000;
  assert.ok(makeReviewIntent(f,NOW));
});
test('#48 oversized or path hostile previews block unseen changes',()=>{
  const f=fixture();
  f.proposed.diff='x'.repeat(20001);
  assert.equal(projectTaskReview(f,NOW).diffTruncated,true);
  assert.equal(makeReviewIntent(f,NOW),null);
  const g=fixture();g.proposed.files[0]!.path='../escape';
  assert.equal(makeReviewIntent(g,NOW),null);
  const h=fixture();h.proposed.files=Array.from({length:81},
    (_,i)=>({path:'src/'+i+'.ts',status:'added',additions:1,deletions:0}));
  assert.equal(makeReviewIntent(h,NOW),null);
});
class FakeNode {
  ownerDocument:FakeDocument;
  children:FakeNode[]=[];
  attributes:Record<string,string>={};
  handlers:Record<string,()=>void>={};
  disabled=false;
  type='';
  className='';
  textContent='';
  constructor(readonly tagName:string,doc:FakeDocument){this.ownerDocument=doc}
  set innerHTML(_value:string){throw new Error('HTML INJECTION ATTEMPT')}
  setAttribute(k:string,v:string){this.attributes[k]=v}
  append(...nodes:FakeNode[]){this.children.push(...nodes)}
  replaceChildren(...nodes:FakeNode[]){this.children=[...nodes]}
  addEventListener(type:string,fn:()=>void){this.handlers[type]=fn}
  click(){this.handlers.click?.()}
}
class FakeDocument{
  createElement(tag:string){return new FakeNode(tag,this)}
}
test('#48 UI uses safe text nodes even with hostile diff/path markup',()=>{
  const f=fixture();
  const marker='<img src=x onerror=alert(1)>';
  f.proposed.diff=marker;
  f.proposed.files[0]!.path='src/'+marker+'.ts';
  const doc=new FakeDocument(),root=new FakeNode('div',doc);
  const mounted=mountTaskReview(root,f,{now:()=>NOW,onIntent:()=>{}});
  assert.equal(mounted.view.canRecordIntent,true);
  const all:FakeNode[]=[];
  function visit(n:FakeNode){all.push(n);for(const c of n.children)visit(c)}
  visit(root);
  assert.ok(all.some(n=>n.tagName==='pre'&&n.textContent===marker));
  assert.ok(all.some(n=>n.tagName==='li'&&n.textContent.includes(marker)));
  assert.equal(all.some(n=>n.tagName==='img'),false);
});
test('#48 DOM handoff emits only frozen time-bounded intent, not apply/rollback',()=>{
  const f=fixture();const doc=new FakeDocument(),root=new FakeNode('main',doc);
  const received:unknown[]=[];
  const mounted=mountTaskReview(root,f,{now:()=>NOW,
    onIntent:record=>{received.push(record)}});
  assert.equal(mounted.button.disabled,false);
  mounted.button.click();
  mounted.button.click();
  assert.equal(received.length,1);
  assert.equal(mounted.button.disabled,true);
  assert.match(mounted.message.textContent,/NO EXECUTION GRANTED/);
});
test('#48 UI click revalidates expired clock and post-render owner revoke',()=>{
  for(const variant of ['time','revoke']){
    const f=fixture(),doc=new FakeDocument(),root=new FakeNode('main',doc);
    let tick=NOW, calls=0;
    const mounted=mountTaskReview(root,f,{now:()=>tick,onIntent:()=>{calls++}});
    assert.equal(mounted.button.disabled,false);
    if(variant==='time')tick=NOW+60000;
    else f.current.revoked=true;
    mounted.button.click();
    assert.equal(calls,0,variant);
    assert.equal(mounted.button.disabled,true);
    assert.match(mounted.message.textContent,/DENIED/);
  }
});
test('#48 absent current context is blocked and standalone UI cannot submit',()=>{
  const v=projectTaskReview(null,NOW);
  assert.equal(v.status,'BLOCKED');
  const doc=new FakeDocument(),root=new FakeNode('main',doc);
  const mounted=mountTaskReview(root,null,{now:()=>NOW});
  assert.equal(mounted.button.disabled,true);
  assert.equal(mounted.view.canDispatch,false);
});


function approvedFixture(){
  const f=fixture();
  const patch={
    file:'src/safe.ts',beforeVersion:'version-001',
    afterSha256:'9'.repeat(64),fingerprint:'8'.repeat(64),
    approvalEpoch:12,worktreeId:'worktree-one'
  };
  const proposed=Object.assign(f.proposed,{patch,requestedMode:'CORE'});
  const current=Object.assign(f.current,{patch:{...patch},requestedMode:'CORE'});
  return Object.assign(f,{proposed,current,
    approvedReview:{
      // Untrusted client display data, NOT a cryptographically verified ticket.
      statement:{
        kind:'nexowire.coding.human-diff-consent.v1',
        scope:'LOCAL_HUMAN_SOURCE_ONLY',
        phase:'APPLY',
        ownerId:f.proposed.scope.ownerId,
        deviceId:f.proposed.scope.deviceId,
        taskId:f.proposed.scope.taskId,
        logicalMutationId:f.proposed.scope.logicalMutationId,
        requestId:f.proposed.scope.requestId,
        semanticEffectSha256:f.proposed.scope.semanticEffectSha256,
        deviceEpoch:f.proposed.scope.deviceEpoch,
        sessionEpoch:f.proposed.scope.sessionEpoch,
        ownerEpoch:f.proposed.scope.ownerEpoch,
        grantGeneration:f.proposed.scope.grantGeneration,
        worktreeIdentitySha256:f.proposed.scope.worktreeIdentitySha256,
        gitBaseSha:f.proposed.scope.gitBaseSha,
        gitSourceSha:f.proposed.scope.gitSourceSha,
        accessBaseSha256:f.proposed.scope.baseSha256,
        accessDiffSha256:f.proposed.scope.diffSha256,
        beforeSha256:f.proposed.scope.preimageSha256,
        requestedMode:'CORE',
        file:patch.file,beforeVersion:patch.beforeVersion,
        afterSha256:patch.afterSha256,patchFingerprintSha256:patch.fingerprint,
        approvalEpoch:patch.approvalEpoch,worktreeId:patch.worktreeId,
        issuedAtMs:NOW-1000,expiresAtMs:NOW+29000
      },
      diff:f.proposed.diff
    }
  });
}
test('#48 #40 consent display match is unverified and NEVER Windows HIGH',()=>{
  const f=approvedFixture();
  const v=projectTaskReview(f,NOW);
  assert.equal(v.status,'REVIEW_INTENT_ONLY');
  assert.equal(v.approvedReviewStatus,'DISPLAY_MATCH_UNVERIFIED');
  assert.equal(v.canDispatch,false);
  assert.equal(v.effectiveWindowsHigh,false);
  assert.equal(v.physicalVerified,false);
  assert.equal(makeReviewIntent(f,NOW)?.nativeHigh,false);
});
test('#48 #40 approved Git base/source and patch SHA mismatches are STALE_READ_ONLY',()=>{
  for(const field of ['gitBaseSha','gitSourceSha','accessBaseSha256',
    'accessDiffSha256','beforeSha256','patchFingerprintSha256',
    'afterSha256','file','beforeVersion','approvalEpoch','worktreeId',
    'logicalMutationId','requestId','ownerEpoch','grantGeneration']){
    const f=approvedFixture();
    const s=f.approvedReview.statement as Record<string,unknown>;
    s[field]=field==='ownerEpoch'||field==='grantGeneration'||
      field==='approvalEpoch'?300:'tampered';
    const view=projectTaskReview(f,NOW);
    assert.equal(view.status,'STALE_READ_ONLY',field);
    assert.equal(view.approvedReviewStatus,'STALE_READ_ONLY',field);
    assert.ok(view.reasons.includes('APPROVED_BASE_OR_PATCH_STALE_READ_ONLY'),field);
    assert.equal(view.canRecordIntent,false,field);
    assert.equal(view.canDispatch,false,field);
    assert.equal(makeReviewIntent(f,NOW),null,field);
  }
});
test('#48 #40 changed displayed diff and changed current patch version deny old approval',()=>{
  for(const variant of ['diff','currentPatch','file','mode','expired','missingPatch']){
    const f=approvedFixture();
    if(variant==='diff')f.proposed.diff+='\n+unapproved line';
    if(variant==='currentPatch')f.current.patch.beforeVersion='changed-live';
    if(variant==='file')f.proposed.patch.file='src/other.ts';
    if(variant==='mode')f.current.requestedMode='SAFE';
    if(variant==='expired')f.approvedReview.statement.expiresAtMs=NOW;
    if(variant==='missingPatch')delete (f.current as Record<string,unknown>).patch;
    const view=projectTaskReview(f,NOW);
    assert.equal(view.status,'STALE_READ_ONLY',variant);
    assert.equal(view.canRecordIntent,false,variant);
    assert.equal(makeReviewIntent(f,NOW),null,variant);
  }
});
test('#48 UI mismatched approval remains readonly even if client requests HIGH',()=>{
  const f=approvedFixture();
  f.approvedReview.statement.gitBaseSha='3'.repeat(40);
  Object.assign(f,{clientPreference:{nativeHigh:true,coreEffective:true,canDispatch:true},
    signedApproval:true,effectiveWindowsHigh:true,clientApprovalGranted:true});
  const doc=new FakeDocument(),root=new FakeNode('main',doc);
  let count=0;
  const m=mountTaskReview(root,f,{now:()=>NOW,onIntent:()=>{count++}});
  assert.equal(m.view.status,'STALE_READ_ONLY');
  assert.equal(m.view.effectiveWindowsHigh,false);
  assert.equal(m.view.canApply,false);
  assert.equal(m.button.disabled,true);
  m.button.click();
  assert.equal(count,0);
  assert.equal(m.view.physicalEvidence,'NOT_PHYSICALLY_VERIFIED');
});


test('#48 #32 nested preview drift after consent renders STALE_READ_ONLY (no HIGH)',()=>{
  const seeded=()=>{
    const f:any=approvedFixture();
    const identity={
      ownerId:f.proposed.scope.ownerId,
      taskId:f.proposed.scope.taskId,
      worktreeId:f.proposed.patch.worktreeId,
      worktreeRoot:'C:\\\\tasks\\\\review-one',
      baseSha:f.proposed.scope.gitBaseSha,
      sourceSha:f.proposed.scope.gitSourceSha,
      approvalEpoch:f.proposed.patch.approvalEpoch
    };
    f.proposed.patch.identity={...identity};
    f.current.patch.identity={...identity};
    f.proposed.patch.beforeSha256=f.proposed.scope.preimageSha256;
    f.current.patch.beforeSha256=f.current.scope.preimageSha256;
    return f;
  };
  assert.equal(projectTaskReview(seeded(),NOW).status,'REVIEW_INTENT_ONLY');
  for(const [caseName,alter] of [
    ['cloned approvalEpoch', (f:any)=>{f.current.patch.identity.approvalEpoch+=1}],
    ['hidden worktree root', (f:any)=>{f.current.patch.identity.worktreeRoot='C:\\\\tasks\\\\other'}],
    ['source SHA', (f:any)=>{f.current.patch.identity.sourceSha='3'.repeat(40)}],
    ['Git base SHA', (f:any)=>{f.current.patch.identity.baseSha='4'.repeat(40)}],
    ['changed afterSha256', (f:any)=>{f.current.patch.afterSha256='7'.repeat(64)}],
    ['changed preimage SHA', (f:any)=>{f.current.patch.beforeSha256='6'.repeat(64)}],
    ['missing native identity', (f:any)=>{delete f.current.patch.identity}]
  ] as const){
    const f=seeded();
    alter(f);
    const v=projectTaskReview(f,NOW);
    assert.equal(v.status,'STALE_READ_ONLY',caseName);
    assert.equal(v.approvedReviewStatus,'STALE_READ_ONLY',caseName);
    assert.equal(v.canRecordIntent,false,caseName);
    assert.equal(v.canDispatch,false,caseName);
    assert.equal(v.canApply,false,caseName);
    assert.equal(v.effectiveWindowsHigh,false,caseName);
    assert.equal(makeReviewIntent(f,NOW),null,caseName);
  }
  const f=seeded();
  const root=new FakeNode('main',new FakeDocument());
  let emitted=0;
  const mounted=mountTaskReview(root,f,{now:()=>NOW,onIntent:()=>{emitted++}});
  assert.equal(mounted.button.disabled,false);
  f.current.patch.identity.worktreeRoot='C:\\\\tasks\\\\swapped-during-preview';
  assert.equal(projectTaskReview(f,NOW).status,'STALE_READ_ONLY');
  mounted.button.click();
  assert.equal(emitted,0);
  assert.equal(mounted.button.disabled,true);
  assert.match(mounted.message.textContent,/DENIED/);
});
