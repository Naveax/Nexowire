import {createHash,createPublicKey,randomBytes,verify} from 'node:crypto';
import type {HelperAuthorityEvidenceRequest} from './postgres-helper-selection-authority.js';

const DOMAIN='nexowire.helper-selection-native-evidence.v1';
const REQUIRED={
  BEGIN_RUNTIME:['protected-runtime','current-grant','runtime-incarnation','lease-bound'],
  BEGIN_DEPLOYMENT:['owner-intent','current-grant','prior-runtime-drained','deployment-incarnation','lease-bound'],
  READ:['protected-caller','current-grant','exact-lease','selection-current'],
  COMMIT:['owner-intent','current-grant','quiesced','desired-artifact-or-detach-verified','stop-revoke-fenced','lease-bound'],
  RELEASE:['exact-lease','permanent-native-drain','future-effects-fenced'],
} as const;
type Phase=HelperAuthorityEvidenceRequest['phase'];
export type HelperEvidenceChallenge=Readonly<{domain:typeof DOMAIN;nonce:string;requestSha256:string;phase:Phase}>;
export interface SignedHelperEvidenceConfig {
  /** Independent native evidence authority, not the Agent/installer signer. */
  observerPublicKeyPem:string;
  /** Transport to the already provisioned independent observer. The observer
   * must authenticate the actual native incarnation and evaluate every required
   * fact; a caller-supplied JSON assertion is not a proof. */
  requestProof:(challenge:HelperEvidenceChallenge,request:HelperAuthorityEvidenceRequest)=>Promise<unknown>;
  timeoutMs?:number;
}
export function helperEvidenceRequiredFacts(phase:Phase):readonly string[]{
  return Object.freeze([...REQUIRED[phase]]);
}
function requestHash(request:HelperAuthorityEvidenceRequest):string {
  const {phase,scope:s,lease:l,selection:v,request:r}=request;
  const pin=(p:{sha256:string;signerSha256:string}|null)=>p===null?null:[p.sha256,p.signerSha256];
  // Explicit ordered tuples, not caller-controlled key order. Source path is
  // included in the binding but not exposed in the signed reply or logs.
  const body=JSON.stringify([DOMAIN,phase,[s.authorityId,s.deviceId,s.ownerId,s.deviceEpoch,s.sessionEpoch,s.ownerEpoch,s.generation,s.brokerId],
    [l.id,l.requestId,l.kind,l.expectedRevision],[v.revision,pin(v.pin)],
    r?[r.requestId,r.operation,r.expected.revision,pin(r.expected.pin),pin(r.desired),r.sourcePath??null]:null]);
  return createHash('sha256').update(body,'utf8').digest('hex');
}
const own=(v:unknown,keys:readonly string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));

/** Verification only. No key generation, native consent synthesis, local
 * fallback or self-issued proof. Each observation requires a fresh challenge,
 * the exact scope/lease/selection/intent and all phase-specific facts. */
export function createSignedHelperSelectionEvidenceVerifier(c:SignedHelperEvidenceConfig){
  const key=createPublicKey(c.observerPublicKeyPem),timeout=c.timeoutMs??3000;
  if(key.asymmetricKeyType!=='ed25519'||typeof c.requestProof!=='function'||!Number.isSafeInteger(timeout)||timeout<250||timeout>3500)
    throw Error('HELPER_NATIVE_EVIDENCE_CONFIG_INVALID');
  const requestProof=c.requestProof;
  return async(request:HelperAuthorityEvidenceRequest):Promise<boolean>=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const started=Date.now(),monotonic=process.hrtime.bigint();
      const challenge:HelperEvidenceChallenge=Object.freeze({domain:DOMAIN,nonce:randomBytes(32).toString('hex'),requestSha256:requestHash(request),phase:request.phase});
      const reply=await Promise.race([requestProof(challenge,request),new Promise<undefined>(resolve=>{timer=setTimeout(()=>resolve(undefined),timeout);})]);
      if(process.hrtime.bigint()-monotonic>=BigInt(timeout)*1000000n||
         !own(reply,['payload','proof'])||typeof reply.payload!=='string'||Buffer.byteLength(reply.payload)>8192||
         typeof reply.proof!=='string'||! /^[A-Za-z0-9_-]{86}$/.test(reply.proof))return false;
      const proof=Buffer.from(reply.proof,'base64url');
      if(proof.length!==64||proof.toString('base64url')!==reply.proof||!verify(null,Buffer.from(reply.payload,'utf8'),key,proof))return false;
      const p:unknown=JSON.parse(reply.payload),now=Date.now();
      if(!own(p,['domain','nonce','requestSha256','phase','accepted','facts','observedAt','expiresAt'])||
         p.domain!==DOMAIN||p.nonce!==challenge.nonce||p.requestSha256!==challenge.requestSha256||p.phase!==request.phase||p.accepted!==true||
         typeof p.observedAt!=='number'||typeof p.expiresAt!=='number'||!Number.isSafeInteger(p.observedAt)||!Number.isSafeInteger(p.expiresAt)||
         now<started||p.observedAt<started||p.observedAt>now||p.expiresAt<=now||p.expiresAt-p.observedAt>5000||
         !Array.isArray(p.facts))return false;
      const expected=REQUIRED[request.phase];
      return p.facts.length===expected.length&&expected.every((fact,i)=>(p.facts as unknown[])[i]===fact);
    }catch{return false;}
    finally{if(timer)clearTimeout(timer);}
  };
}
