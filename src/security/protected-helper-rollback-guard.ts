import {createPublicKey,verify} from 'node:crypto';
import type {HelperAuthorityEvidenceRequest} from './postgres-helper-selection-authority.js';
import type {HelperEvidenceChallenge,SignedHelperEvidenceConfig} from './signed-helper-selection-evidence.js';
import {createPostgresHelperSelectionService} from './protected-helper-selection-service.js';
import type {ReviewedSqliteRollbackRuntime} from '../../scripts/ai02-signed-sqlite-rollback-review.js';
import type {HelperPin} from '../installer/protected-transfer-helper-lifecycle.js';
const DOMAIN='nexowire.helper-rollback-guard.v2';
const isHash=(v:unknown):v is string=>typeof v==='string'&&v.length===64&&/^[a-f0-9]{64}$/.test(v);
const exact=(v:unknown,k:readonly string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===k.length&&k.every(x=>Object.hasOwn(v,x));
export interface ApprovedHelperRollbackReview {
  readonly runtime:ReviewedSqliteRollbackRuntime;
  readonly helperPin:HelperPin;
  readonly approvedStateSha256:string;
  readonly sqliteTreeSha256:string;
  readonly sqliteRecords:number;
}
export interface HelperRollbackGuardConfig {
  observerPublicKeyPem:string;
  /** Independent reviewed runtime and baseline, not derived from reply. */
  approved:ApprovedHelperRollbackReview;
  requestProof:(challenge:HelperEvidenceChallenge,request:HelperAuthorityEvidenceRequest)=>Promise<unknown>;
}
/** Separate AI-02 witness must retain the approved quiesced durable-state
 * baseline across admission and commit. Never restore/copy state. Signed
 * claims must come from a real independent observer, not this verifier. */
export function bindHelperRollbackGuard(native:SignedHelperEvidenceConfig,guard:HelperRollbackGuardConfig):SignedHelperEvidenceConfig{
  const key=createPublicKey(guard.observerPublicKeyPem),nativeKey=createPublicKey(native.observerPublicKeyPem);
  if(key.asymmetricKeyType!=='ed25519'||nativeKey.asymmetricKeyType!=='ed25519'||
    key.export({format:'der',type:'spki'}).equals(nativeKey.export({format:'der',type:'spki'}))||
    typeof guard.requestProof!=='function'||typeof native.requestProof!=='function')throw Error('HELPER_ROLLBACK_GUARD_CONFIG_INVALID');
  const approved=guard.approved,r=approved?.runtime,p=approved?.helperPin;
  if(!r||!p||!isHash(r.manifestSha256)||typeof r.sourceCommit!=='string'||r.sourceCommit.length!==40||! /^[a-f0-9]{40}$/.test(r.sourceCommit)||
     !Number.isSafeInteger(r.releaseSequence)||r.releaseSequence<1||r.reader!=='sqlite-only'||r.schemaVersion!==1||
     !isHash(p.sha256)||!isHash(p.signerSha256)||!isHash(approved.approvedStateSha256)||!isHash(approved.sqliteTreeSha256)||
     !Number.isSafeInteger(approved.sqliteRecords)||approved.sqliteRecords<0)throw Error('HELPER_ROLLBACK_REVIEW_PIN_REQUIRED');
  const review=Object.freeze({...approved,runtime:Object.freeze({...r}),helperPin:Object.freeze({...p})});
  const observe=guard.requestProof,requestNative=native.requestProof;
  return Object.freeze({...native,async requestProof(challenge:HelperEvidenceChallenge,request:HelperAuthorityEvidenceRequest){
    if(request.request?.operation!=='rollback'||(request.phase!=='BEGIN_DEPLOYMENT'&&request.phase!=='COMMIT'))return requestNative(challenge,request);
    if(request.request.desired?.sha256!==review.helperPin.sha256||request.request.desired?.signerSha256!==review.helperPin.signerSha256)
      throw Error('HELPER_ROLLBACK_GUARD_DENIED');
    const started=Date.now(),mono=process.hrtime.bigint(),timeout=Math.min(native.timeoutMs??3000,3000);
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const pair=await Promise.race([Promise.all([observe(challenge,request),requestNative(challenge,request)]),
        new Promise<undefined>(resolve=>{timer=setTimeout(()=>resolve(undefined),timeout);})]);
      if(!pair||process.hrtime.bigint()-mono>=BigInt(timeout)*1000000n)throw Error('HELPER_ROLLBACK_GUARD_DENIED');
      const [reply,nativeReply]=pair;
      if(!exact(reply,['payload','proof'])||typeof reply.payload!=='string'||Buffer.byteLength(reply.payload)>8192||
        typeof reply.proof!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(reply.proof))throw Error('HELPER_ROLLBACK_GUARD_DENIED');
      const proof=Buffer.from(reply.proof,'base64url');
      if(proof.length!==64||proof.toString('base64url')!==reply.proof||!verify(null,Buffer.from(reply.payload,'utf8'),key,proof))throw Error('HELPER_ROLLBACK_GUARD_DENIED');
      const v:unknown=JSON.parse(reply.payload),now=Date.now();
      if(!exact(v,['domain','nonce','requestSha256','phase','approvedStateSha256','currentStateSha256','writerFenced','unknownOperations','recoveryPending','priorHelperCompatible','sqliteReview','observedAt','expiresAt'])||
         v.domain!==DOMAIN||v.nonce!==challenge.nonce||v.requestSha256!==challenge.requestSha256||v.phase!==request.phase||
         v.approvedStateSha256!==review.approvedStateSha256||v.currentStateSha256!==review.approvedStateSha256||v.writerFenced!==true||v.unknownOperations!==false||
         v.recoveryPending!==false||v.priorHelperCompatible!==true||typeof v.observedAt!=='number'||typeof v.expiresAt!=='number'||
         !Number.isSafeInteger(v.observedAt)||!Number.isSafeInteger(v.expiresAt)||now<started||v.observedAt<started||
         v.observedAt>now||v.expiresAt<=now||v.expiresAt-v.observedAt>5000)throw Error('HELPER_ROLLBACK_GUARD_DENIED');
      const checked=v.sqliteReview;
      if(!exact(checked,['manifestSha256','sourceCommit','releaseSequence','schemaVersion','treeSha256','sqliteRecords','succeeded','failed','unknown','inProgress','releaseAnchorAdvanced','productionRollbackAuthorized'])||
         checked.manifestSha256!==review.runtime.manifestSha256||checked.sourceCommit!==review.runtime.sourceCommit||
         checked.releaseSequence!==review.runtime.releaseSequence||checked.schemaVersion!==review.runtime.schemaVersion||
         checked.treeSha256!==review.sqliteTreeSha256||checked.sqliteRecords!==review.sqliteRecords||
         typeof checked.succeeded!=='number'||!Number.isSafeInteger(checked.succeeded)||checked.succeeded<0||
         typeof checked.failed!=='number'||!Number.isSafeInteger(checked.failed)||checked.failed<0||
         checked.succeeded+checked.failed!==review.sqliteRecords||checked.unknown!==0||checked.inProgress!==0||
         checked.releaseAnchorAdvanced!==false||checked.productionRollbackAuthorized!==false)throw Error('HELPER_ROLLBACK_GUARD_DENIED');
      return nativeReply;
    }finally{if(timer)clearTimeout(timer);}
  }});
}
/** Explicit composed service, requires both independent issuers. */
export function createRollbackGuardedHelperSelectionService(config:Parameters<typeof createPostgresHelperSelectionService>[0]&{rollbackGuard:HelperRollbackGuardConfig}){
  return createPostgresHelperSelectionService({...config,nativeEvidence:bindHelperRollbackGuard(config.nativeEvidence,config.rollbackGuard)});
}
