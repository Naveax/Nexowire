/**
 * #48 Task review UI (SOURCE-ONLY). A human intent is never an OS/native grant.
 * No fetch(), storage, shell, dispatch, elevated execution or UI fallback truth.
 */
const SHA=/^[a-f0-9]{64}$/;
const ID=/^[a-zA-Z0-9._:@-]{1,160}$/;
const KEYS=['ownerId','deviceId','taskId','logicalMutationId','requestId',
  'worktreeIdentitySha256','preimageSha256','baseSha256','sourceSha256',
  'diffSha256','semanticEffectSha256','deviceEpoch','sessionEpoch',
  'ownerEpoch','grantGeneration'];
const HASHES=new Set(['worktreeIdentitySha256','preimageSha256','baseSha256',
  'sourceSha256','diffSha256','semanticEffectSha256']);
const MAX_DIFF=20000;
const MAX_FILES=80;
const MAX_INTENT_MS=300000;
const scalar=(x)=>typeof x==='string'&&ID.test(x);
const validField=(key,value)=>HASHES.has(key)?typeof value==='string'&&SHA.test(value)
  :key==='ownerEpoch'||key==='grantGeneration'
    ?Number.isSafeInteger(value)&&value>0
    :scalar(value);
const equalScope=(a,b)=>KEYS.every(key=>a[key]===b[key]);
const allowedPath=(p)=>typeof p==='string'&&p.length>0&&p.length<=500&&
  !p.startsWith('/')&&!p.includes('\\')&&!p.includes('\0')&&
  !p.split('/').some(s=>s==='..'||s==='.'||s==='')&&
  !/[\x00-\x1f\x7f]/.test(p);

/**
 * Both 'proposed' and 'current' are untrusted view data. An independent
 * server-side signer, authoritative readback and atomic effect admission
 * MUST revalidate everything; equality here proves neither identity nor CAS.
 */
export function projectTaskReview(input,nowMs=Date.now()){
  const reasons=[];
  const proposed=input?.proposed;
  const current=input?.current;
  const a=proposed?.scope, b=current?.scope;
  if(!a||!b||!KEYS.every(k=>validField(k,a[k])&&validField(k,b[k])))
    reasons.push('INVALID_OR_MISSING_IMMUTABLE_SCOPE');
  else if(!equalScope(a,b))reasons.push('STALE_REVISION_OR_OWNER_EPOCH');
  if(!current||current.revoking!==false||current.revoked!==false)
    reasons.push('OWNER_EPOCH_REVOKED_OR_UNVERIFIED');
  if(!current||current.conflict!==false)reasons.push('WORKTREE_CONFLICT_OR_UNVERIFIED');
  const effect=current?.effectState;
  if(effect==='MUTATION_STATE_UNKNOWN')reasons.push('UNKNOWN_RECONCILE_REQUIRED');
  else if(effect==='COMPLETED_VERIFIED')reasons.push('POST_EFFECT_REVIEW_CANNOT_UNDO_EFFECT');
  else if(effect!=='NOT_DISPATCHED_VERIFIED')reasons.push('EFFECT_STATE_UNVERIFIED');
  if(!Number.isSafeInteger(nowMs)||nowMs<0)reasons.push('INVALID_CLOCK');
  const expiresAtMs=input?.intentExpiresAtMs;
  if(!Number.isSafeInteger(expiresAtMs)||expiresAtMs<=nowMs||
    expiresAtMs-nowMs>MAX_INTENT_MS)reasons.push('REVIEW_INTENT_EXPIRED_OR_UNBOUNDED');
  const files=proposed?.files;
  if(!Array.isArray(files)||files.length<1||files.length>MAX_FILES||
    !files.every(f=>allowedPath(f?.path)&&
      Number.isSafeInteger(f?.additions)&&f.additions>=0&&
      Number.isSafeInteger(f?.deletions)&&f.deletions>=0&&
      ['modified','added','deleted','renamed'].includes(f?.status)))
    reasons.push('INVALID_OR_UNBOUNDED_CHANGE_SUMMARY');
  const diff=proposed?.diff;
  if(typeof diff!=='string'||diff.length===0||diff.length>MAX_DIFF)
    reasons.push('DIFF_MISSING_OR_TRUNCATED');
  if(input?.proof?.physicalVerified===true||input?.proof?.nativeHigh===true||
    input?.proof?.externalCas===true)reasons.push('UNTRUSTED_PHYSICAL_PROOF_CLAIM');
  if(input?.claimedApproval===true||input?.canApply===true)
    reasons.push('UNTRUSTED_CLIENT_APPROVAL_OR_APPLY_CLAIM');
  const unique=[...new Set(reasons)];
  const safeFiles=Array.isArray(files)?files.slice(0,MAX_FILES).filter(f=>allowedPath(f?.path)&&
    Number.isSafeInteger(f.additions)&&Number.isSafeInteger(f.deletions)&&
    f.additions>=0&&f.deletions>=0).map(f=>Object.freeze({
      path:f.path,status:f.status,additions:f.additions,deletions:f.deletions
    })):[];
  return Object.freeze({
    status:unique.length?'BLOCKED':'REVIEW_INTENT_ONLY',
    reasons:Object.freeze(unique),
    canRecordIntent:unique.length===0,
    canDispatch:false,canApply:false,canRollback:false,
    effectiveWindowsHigh:false,physicalVerified:false,
    scope:a&&typeof a==='object'?Object.freeze(Object.fromEntries(
      KEYS.filter(k=>validField(k,a[k])).map(k=>[k,a[k]]))):Object.freeze({}),
    files:Object.freeze(safeFiles),
    additions:safeFiles.reduce((s,f)=>s+f.additions,0),
    deletions:safeFiles.reduce((s,f)=>s+f.deletions,0),
    diff:typeof diff==='string'?diff.slice(0,MAX_DIFF):'',
    diffTruncated:typeof diff==='string'&&diff.length>MAX_DIFF,
    deadlineMs:Number.isSafeInteger(expiresAtMs)?expiresAtMs:null,
    sourceEvidence:'SOURCE_ONLY_UNVERIFIED',
    physicalEvidence:'NOT_PHYSICALLY_VERIFIED',
    postEffectWarning:'Review preference cannot authorize Windows HIGH/UAC, native effects or rollback. After effects, filesystem undo cannot reverse external side effects.',
  });
}

/** Local *intent request* only. Never an approval receipt or dispatch permit. */
export function makeReviewIntent(input,nowMs=Date.now()){
  const view=projectTaskReview(input,nowMs);
  if(!view.canRecordIntent)return null;
  return Object.freeze({
    kind:'NEXOWIRE_CODING_REVIEW_INTENT_REQUEST_V1',
    scope:view.scope,
    requestedAtMs:nowMs,expiresAtMs:view.deadlineMs,
    requestedAction:'REVIEW_PATCH',
    signedApproval:false,consumedApproval:false,
    canDispatch:false,canApply:false,canRollback:false,
    nativeHigh:false,externalCasWitness:false,
  });
}
const el=(doc,tag,txt,cls)=>{
  const n=doc.createElement(tag);
  if(txt!==undefined)n.textContent=String(txt);
  if(cls)n.className=cls;
  return n;
};
const pair=(doc,box,k,v)=>{
  const dt=el(doc,'dt',k),dd=el(doc,'dd',v===undefined?'UNAVAILABLE':v);
  box.append(dt,dd);
};
/**
 * No innerHTML and no backend calls. Host must inject authenticated data and
 * independently authenticate every intent after it leaves this view.
 */
export function mountTaskReview(root,input,{now=()=>Date.now(),onIntent}={}){
  if(!root||!root.ownerDocument||typeof root.replaceChildren!=='function')
    throw new TypeError('A DOM root is required');
  const doc=root.ownerDocument;
  const view=projectTaskReview(input,now());
  const wrapper=el(doc,'section',undefined,'nexowire-task-review');
  wrapper.setAttribute('aria-label','Coding task diff review');
  wrapper.append(el(doc,'h1','Coding task | patch review'));
  wrapper.append(el(doc,'p','SOURCE-ONLY UI. Review intent is not approval authority, Windows HIGH/UAC, external CAS or native execution.'));
  wrapper.append(el(doc,'h2',view.status));
  const errors=el(doc,'ul');
  for(const reason of view.reasons)errors.append(el(doc,'li',reason));
  if(view.reasons.length)wrapper.append(errors);
  const meta=el(doc,'dl');
  for(const key of KEYS)pair(doc,meta,key,view.scope[key]);
  pair(doc,meta,'Intent expires',view.deadlineMs===null?'UNAVAILABLE':new Date(view.deadlineMs).toISOString());
  pair(doc,meta,'Source CI claim',view.sourceEvidence);
  pair(doc,meta,'Physical proof',view.physicalEvidence);
  pair(doc,meta,'Native dispatch/apply/rollback','DENIED / DENIED / DENIED');
  wrapper.append(meta);
  wrapper.append(el(doc,'h2','Change summary'));
  wrapper.append(el(doc,'p',String(view.files.length)+' files, +'+view.additions+' / -'+view.deletions));
  const changes=el(doc,'ul');
  for(const f of view.files)changes.append(el(doc,'li',f.status+' '+f.path+' (+'+f.additions+' / -'+f.deletions+')'));
  wrapper.append(changes);
  wrapper.append(el(doc,'h2','Unified diff (untrusted display only)'));
  wrapper.append(el(doc,'pre',view.diff||'NO DIFF AVAILABLE'));
  wrapper.append(el(doc,'p',view.postEffectWarning));
  const message=el(doc,'p','No review intent submitted');
  message.setAttribute('role','status');
  const button=el(doc,'button','Request time-bounded review intent (not execution)');
  button.type='button';
  button.disabled=!view.canRecordIntent||typeof onIntent!=='function';
  button.addEventListener('click',()=>{
    // Re-check the view data and deadline at click; still never a native grant.
    const intent=makeReviewIntent(input,now());
    if(!intent||typeof onIntent!=='function'){
      button.disabled=true;
      message.textContent='DENIED: stale, revoked, expired or UNKNOWN. Reconcile independently.';
      return;
    }
    button.disabled=true; // single local emission; durable dedupe belongs to #01/#40
    message.textContent='Intent requested. Server must verify scope, signer, epoch and effect state independently; NO EXECUTION GRANTED.';
    try{onIntent(intent)}catch{
      message.textContent='Intent handoff failed. NO EXECUTION GRANTED.';
    }
  });
  wrapper.append(button,message);
  root.replaceChildren(wrapper);
  return Object.freeze({view,button,message});
}
