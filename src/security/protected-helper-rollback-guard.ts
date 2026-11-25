import {createPublicKey,verify} from 'node:crypto';
import type {HelperAuthorityEvidenceRequest} from './postgres-helper-selection-authority.js';
import type {HelperEvidenceChallenge,SignedHelperEvidenceConfig} from './signed-helper-selection-evidence.js';
import {createPostgresHelperSelectionService} from './protected-helper-selection-service.js';
const DOMAIN='nexowire.helper-rollback-guard.v1';
const isHash=(v:unknown):v is string=>typeof v==='string'&&v.length===64&&/^[a-f0-9]{64}$/.test(v);
const exact=(v:unknown,k:readonly string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===k.length&&k.every(x=>Object.hasOwn(v,x));
export interface HelperRollbackGuardConfig {
  observerPublicKeyPem:string;
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
  const observe=guard.requestProof,requestNative=native.requestProof;
  return Object.freeze({...native,async requestProof(challenge:HelperEvidenceChallenge,request:HelperAuthorityEvidenceRequest){
    if(request.request?.operation!=='rollback'||(request.phase!=='BEGIN_DEPLOYMENT'&&request.phase!=='COMMIT'))return requestNative(challenge,request);
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
      if(!exact(v,['domain','nonce','requestSha256','phase','approvedStateSha256','currentStateSha256','writerFenced','unknownOperations','recoveryPending','priorHelperCompatible','observedAt','expiresAt'])||
         v.domain!==DOMAIN||v.nonce!==challenge.nonce||v.requestSha256!==challenge.requestSha256||v.phase!==request.phase||
         !isHash(v.approvedStateSha256)||v.approvedStateSha256!==v.currentStateSha256||v.writerFenced!==true||v.unknownOperations!==false||
         v.recoveryPending!==false||v.priorHelperCompatible!==true||typeof v.observedAt!=='number'||typeof v.expiresAt!=='number'||
         !Number.isSafeInteger(v.observedAt)||!Number.isSafeInteger(v.expiresAt)||now<started||v.observedAt<started||
         v.observedAt>now||v.expiresAt<=now||v.expiresAt-v.observedAt>5000)throw Error('HELPER_ROLLBACK_GUARD_DENIED');
      return nativeReply;
    }finally{if(timer)clearTimeout(timer);}
  }});
}
/** Explicit composed service, requires both independent issuers. */
export function createRollbackGuardedHelperSelectionService(config:Parameters<typeof createPostgresHelperSelectionService>[0]&{rollbackGuard:HelperRollbackGuardConfig}){
  return createPostgresHelperSelectionService({...config,nativeEvidence:bindHelperRollbackGuard(config.nativeEvidence,config.rollbackGuard)});
}
