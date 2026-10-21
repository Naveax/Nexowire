import {createPublicKey,verify,type KeyObject} from 'node:crypto';
import * as z from 'zod';
import type {
  IndependentProvenanceCheck,IndependentOperatorApproval,WitnessOperatorIntent,
} from './postgres-monotonic-witness.js';

const uuid=z.string().uuid();
const intent=z.object({
  kind:z.enum(['enroll','migrate','freeze']),
  authorityId:uuid,deviceId:uuid,ownerId:uuid,epoch:uuid,
  nextOwnerId:uuid.optional(),nextEpoch:uuid.optional(),
  generation:z.number().int().positive().optional(),
}).strict();
const approval=z.object({
  version:z.literal(1),intent,nonce:uuid,
  issuedAt:z.number().int().nonnegative(),
  expiresAt:z.number().int().positive(),
}).strict();
const provenance=z.object({
  version:z.literal(1),authorityId:uuid,deploymentId:uuid,
  witnessDomainId:uuid,agentRollbackDomainId:uuid,
  independentlyOperated:z.literal(true),
  immutableRetentionVerified:z.literal(true),
  issuedAt:z.number().int().nonnegative(),
  expiresAt:z.number().int().positive(),
}).strict();
const envelope=z.object({
  payload:z.string().min(1).max(8192),
  signature:z.string().regex(/^[A-Za-z0-9_-]+$/).max(1024),
}).strict();
export type SignedProvenance=z.infer<typeof provenance>;
export type SignedApproval=z.infer<typeof approval>;
function decodeSigned(raw:string,key:KeyObject):unknown{
  let parsed;
  try{parsed=envelope.parse(JSON.parse(raw))}
  catch{return undefined}
  const bytes=Buffer.from(parsed.payload,'base64url');
  const signature=Buffer.from(parsed.signature,'base64url');
  if(bytes.length>4096||signature.length!==64||
     !verify(null,bytes,key,signature))return undefined;
  try{return JSON.parse(bytes.toString('utf8'))}
  catch{return undefined}
}
function matching(a:WitnessOperatorIntent,b:WitnessOperatorIntent):boolean{
  return a.kind===b.kind&&a.authorityId===b.authorityId&&
    a.deviceId===b.deviceId&&a.ownerId===b.ownerId&&
    a.epoch===b.epoch&&a.nextOwnerId===b.nextOwnerId&&
    a.nextEpoch===b.nextEpoch&&a.generation===b.generation;
}
export function signedOperatorGrantVerifier(
  trustedEd25519PublicKeyPem:string,now:()=>number=Date.now,
):IndependentOperatorApproval{
  const key=createPublicKey(trustedEd25519PublicKeyPem);
  if(key.asymmetricKeyType!=='ed25519')throw Error('WITNESS_APPROVAL_KEY_INVALID');
  return async (expected,raw)=>{
    const verified=approval.safeParse(decodeSigned(raw,key));
    if(!verified.success)return false;
    const data=verified.data;
    return data.issuedAt<=now()&&data.expiresAt>now()&&
      data.expiresAt-data.issuedAt<=5*60_000&&
      matching(data.intent,expected);
  };
}
/**
 * Verifies the operator's signed declaration of separation. It does NOT
 * independently attest cloud admin permissions, immutable audit retention,
 * point-in-time recovery policy or a restore that happened before issuance.
 */
export function signedProvenanceVerifier(config:{
  trustedEd25519PublicKeyPem:string;
  authorityId:string;
  expectedDeploymentId:string;
  expectedWitnessDomainId:string;
  expectedAgentRollbackDomainId:string;
  fetchSignedAssertion:()=>Promise<string>;
  now?:()=>number;
}):IndependentProvenanceCheck{
  const key=createPublicKey(config.trustedEd25519PublicKeyPem);
  if(key.asymmetricKeyType!=='ed25519')throw Error('WITNESS_PROVENANCE_KEY_INVALID');
  const now=config.now??Date.now;
  return async()=>{
    const raw=await config.fetchSignedAssertion();
    const attestation=provenance.safeParse(decodeSigned(raw,key));
    if(!attestation.success)return {verified:false,authorityId:config.authorityId,validUntil:0};
    const a=attestation.data;
    const verified=a.authorityId===config.authorityId&&
      a.deploymentId===config.expectedDeploymentId&&
      a.witnessDomainId===config.expectedWitnessDomainId&&
      a.agentRollbackDomainId===config.expectedAgentRollbackDomainId&&
      a.witnessDomainId!==a.agentRollbackDomainId&&
      a.issuedAt<=now()&&a.expiresAt>now()&&
      a.expiresAt-a.issuedAt<=5*60_000;
    return {verified,authorityId:a.authorityId,validUntil:a.expiresAt};
  };
}
