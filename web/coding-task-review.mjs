/**
 * #48 Task review UI (SOURCE-ONLY). A human intent is never an OS/native grant.
 * No fetch(), storage, shell, dispatch, elevated execution or UI fallback truth.
 */
const SHA=/^[a-f0-9]{64}$/;
const GIT_SHA=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ID=/^[a-zA-Z0-9._:@-]{1,160}$/;
const KEYS=['ownerId','deviceId','taskId','logicalMutationId','requestId',
  'gitBaseSha','gitSourceSha','worktreeIdentitySha256','preimageSha256',
  'baseSha256','sourceSha256',
  'diffSha256','semanticEffectSha256','deviceEpoch','sessionEpoch',
  'ownerEpoch','grantGeneration'];
const HASHES=new Set(['worktreeIdentitySha256','preimageSha256','baseSha256',
  'sourceSha256','diffSha256','semanticEffectSha256']);
const MAX_DIFF=20000;
const MAX_FILES=80;
const MAX_INTENT_MS=300000;
const scalar=(x)=>typeof x==='string'&&ID.test(x);
const validField=(key,value)=>HASHES.has(key)?typeof value==='string'&&SHA.test(value)
  :key==='gitBaseSha'||key==='gitSourceSha'
    ?typeof value==='string'&&GIT_SHA.test(value)
    :key==='ownerEpoch'||key==='grantGeneration'
    ?Number.isSafeInteger(value)&&value>0
    :scalar(value);
const equalScope=(a,b)=>KEYS.every(key=>a[key]===b[key]);
const allowedPath=(p)=>typeof p==='string'&&p.length>0&&p.length<=500&&
  !p.startsWith('/')&&!p.includes('\\')&&!p.includes('\0')&&
  !p.split('/').some(s=>s==='..'||s==='.'||s==='')&&
  !/[\x00-\x1f\x7f]/.test(p);


/**
 * #40 HumanConsentStatement40 vs #32 ReviewedPreview display-only cross-check.
 * Neither envelope nor the supplied diff is authenticated in the browser.
 * A successful match never means signed approval or native admission.
 * Any present but incomplete/mismatched record is STALE_READ_ONLY.
 */
/**
 * #32 ReviewedPreview.identity is separate from the flattened UI patch row.
 * When its native-shaped identity is present, any lost field or mismatch
 * between displayed and current identity must make #40's approval STALE.
 * Worktree root comparison is display-only: lexical equality cannot prove
 * symlink safety, same-volume inode identity, or authorized OS root scope.
 */
function nativePatchIdentityMatches(shown,live,statement,scope){
  const shownHas=Object.hasOwn(shown,'identity');
  const liveHas=Object.hasOwn(live,'identity');
  // Old flattened UI fixtures have no #32 identity. The server must require
  // a complete authoritative #32 preview before considering any approval.
  if(!shownHas&&!liveHas)return true;
  if(!shownHas||!liveHas)return false;
  const original=shown.identity, latest=live.identity;
  if(!original||!latest||typeof original!=='object'||
     typeof latest!=='object'||Array.isArray(original)||
     Array.isArray(latest))return false;
  const keys=['ownerId','taskId','worktreeId','worktreeRoot',
    'baseSha','sourceSha','approvalEpoch'];
  if(!keys.every(k=>Object.hasOwn(original,k)&&Object.hasOwn(latest,k)&&
     original[k]===latest[k]))return false;
  const root=original.worktreeRoot;
  if(typeof root!=='string'||root.length<1||root.length>1024||
     !(root.startsWith('/')||/^[A-Za-z]:[\\\\/]/.test(root)))return false;
  if(!scalar(original.ownerId)||!scalar(original.taskId)||
     !scalar(original.worktreeId)||!GIT_SHA.test(original.baseSha)||
     !GIT_SHA.test(original.sourceSha)||
     !Number.isSafeInteger(original.approvalEpoch)||
     original.approvalEpoch<0)return false;
  if(!Object.hasOwn(shown,'beforeSha256')||
     !Object.hasOwn(live,'beforeSha256')||
     !SHA.test(shown.beforeSha256)||
     shown.beforeSha256!==live.beforeSha256)return false;
  return original.ownerId===scope.ownerId&&
    original.taskId===scope.taskId&&
    original.worktreeId===shown.worktreeId&&
    original.worktreeId===statement.worktreeId&&
    original.baseSha===scope.gitBaseSha&&
    original.baseSha===statement.gitBaseSha&&
    original.sourceSha===scope.gitSourceSha&&
    original.sourceSha===statement.gitSourceSha&&
    original.approvalEpoch===shown.approvalEpoch&&
    original.approvalEpoch===statement.approvalEpoch&&
    shown.beforeSha256===scope.preimageSha256&&
    shown.beforeSha256===statement.beforeSha256;
}

function approvedSnapshotMatches(view,proposed,current,scope,nowMs){
  const statement=view?.statement;
  const shown=proposed?.patch;
  const live=current?.patch;
  const fields=[
    'file','beforeVersion','afterSha256','fingerprint',
    'approvalEpoch','worktreeId'
  ];
  if(!statement||typeof statement!=='object'||Array.isArray(statement)||
    !scope||typeof scope!=='object'||
    !shown||!live||!Number.isSafeInteger(nowMs))return false;
  if(!fields.every(k=>Object.hasOwn(shown,k)&&Object.hasOwn(live,k)&&
      shown[k]===live[k]))return false;
  if(!nativePatchIdentityMatches(shown,live,statement,scope))return false;
  if(typeof shown.file!=='string'||!allowedPath(shown.file)||
    typeof shown.beforeVersion!=='string'||!shown.beforeVersion||
    shown.beforeVersion.length>256||!SHA.test(shown.afterSha256)||
    !SHA.test(shown.fingerprint)||!Number.isSafeInteger(shown.approvalEpoch)||
    shown.approvalEpoch<0||!scalar(shown.worktreeId))return false;
  if(!['SAFE','FULL','ROOT','CORE'].includes(proposed?.requestedMode)||
    proposed.requestedMode!==current?.requestedMode)return false;
  if(!Array.isArray(proposed.files)||proposed.files.length!==1||
    proposed.files[0]?.path!==shown.file||
    typeof proposed.diff!=='string'||view.diff!==proposed.diff)return false;
  if(statement.kind!=='nexowire.coding.human-diff-consent.v1'||
    statement.scope!=='LOCAL_HUMAN_SOURCE_ONLY'||
    !['APPLY','UNDO'].includes(statement.phase)||
    statement.issuedAtMs>nowMs||statement.expiresAtMs<=nowMs||
    !Number.isSafeInteger(statement.issuedAtMs)||
    !Number.isSafeInteger(statement.expiresAtMs)||
    statement.issuedAtMs<0||
    statement.expiresAtMs-statement.issuedAtMs>30000)return false;
  const matched={
    ownerId:'ownerId',deviceId:'deviceId',taskId:'taskId',
    requestId:'requestId',logicalMutationId:'logicalMutationId',
    semanticEffectSha256:'semanticEffectSha256',
    deviceEpoch:'deviceEpoch',sessionEpoch:'sessionEpoch',
    ownerEpoch:'ownerEpoch',grantGeneration:'grantGeneration',
    worktreeIdentitySha256:'worktreeIdentitySha256',
    gitBaseSha:'gitBaseSha',gitSourceSha:'gitSourceSha',
    accessBaseSha256:'baseSha256',accessDiffSha256:'diffSha256',
    beforeSha256:'preimageSha256'
  };
  if(!Object.entries(matched).every(([approvedKey,scopeKey])=>
    statement[approvedKey]===scope[scopeKey]))return false;
  return statement.requestedMode===proposed.requestedMode&&
    statement.file===shown.file&&statement.beforeVersion===shown.beforeVersion&&
    statement.afterSha256===shown.afterSha256&&
    statement.patchFingerprintSha256===shown.fingerprint&&
    statement.approvalEpoch===shown.approvalEpoch&&
    statement.worktreeId===shown.worktreeId;
}

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
  const hasApprovedReview=Object.hasOwn(input??{},'approvedReview');
  const approvedViewMatches=hasApprovedReview&&
    approvedSnapshotMatches(input.approvedReview,proposed,current,a,nowMs);
  if(hasApprovedReview&&!approvedViewMatches)
    reasons.push('APPROVED_BASE_OR_PATCH_STALE_READ_ONLY');
  if(input?.proof?.physicalVerified===true||input?.proof?.nativeHigh===true||
    input?.proof?.externalCas===true)reasons.push('UNTRUSTED_PHYSICAL_PROOF_CLAIM');
  if(input?.claimedApproval===true||input?.canApply===true||
    input?.canDispatch===true||input?.canRollback===true||
    input?.signedApproval===true||input?.clientApprovalGranted===true||
    input?.effectiveWindowsHigh===true||
    input?.clientPreference?.nativeHigh===true||
    input?.clientPreference?.coreEffective===true||
    input?.clientPreference?.canDispatch===true)
    reasons.push('UNTRUSTED_CLIENT_APPROVAL_OR_APPLY_CLAIM');
  const unique=[...new Set(reasons)];
  const safeFiles=Array.isArray(files)?files.slice(0,MAX_FILES).filter(f=>allowedPath(f?.path)&&
    Number.isSafeInteger(f.additions)&&Number.isSafeInteger(f.deletions)&&
    f.additions>=0&&f.deletions>=0).map(f=>Object.freeze({
      path:f.path,status:f.status,additions:f.additions,deletions:f.deletions
    })):[];
  return Object.freeze({
    status:unique.includes('APPROVED_BASE_OR_PATCH_STALE_READ_ONLY')
      ?'STALE_READ_ONLY':unique.length?'BLOCKED':'REVIEW_INTENT_ONLY',
    approvedReviewStatus:hasApprovedReview
      ?approvedViewMatches?'DISPLAY_MATCH_UNVERIFIED':'STALE_READ_ONLY'
      :'NOT_PRESENT',
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
  pair(doc,meta,'#40 approval snapshot',view.approvedReviewStatus);
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
    if(button.disabled)return;
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
