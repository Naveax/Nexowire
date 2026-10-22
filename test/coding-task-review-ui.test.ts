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
  for(const key of ['sourceSha256','diffSha256','baseSha256','worktreeIdentitySha256',
    'preimageSha256','logicalMutationId','requestId','ownerId','deviceId']){
    const f=fixture();
    const scope=f.current.scope as Record<string,string|number>;
    scope[key]=key.endsWith('Sha256')?H:'cloned-or-stale';
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
