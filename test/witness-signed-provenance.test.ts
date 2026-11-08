import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import {signedOperatorGrantVerifier,signedProvenanceVerifier}
 from '../src/agent/witness-signed-provenance.js';
import type {WitnessOperatorIntent} from '../src/agent/postgres-monotonic-witness.js';

const keypair=generateKeyPairSync('ed25519');
const publicKeyPem=keypair.publicKey.export({format:'pem',type:'spki'}).toString();
const signEnvelope=(payload:unknown,privateKey=keypair.privateKey)=>{
 const bytes=Buffer.from(JSON.stringify(payload));
 return JSON.stringify({payload:bytes.toString('base64url'),
  signature:sign(null,bytes,privateKey).toString('base64url')});
};
const intent:WitnessOperatorIntent={
 kind:'migrate',authorityId:randomUUID(),deviceId:randomUUID(),
 ownerId:randomUUID(),epoch:randomUUID(),
 nextOwnerId:randomUUID(),nextEpoch:randomUUID(),generation:3,
};
const now=1_800_000_000_000;
const operatorGrant=(target=intent,issuedAt=now-20_000,expiresAt=now+20_000)=>({
 version:1,intent:target,nonce:randomUUID(),issuedAt,expiresAt,
});
test('operator signature and exact owner/device/epoch/generation are checked',async()=>{
 const verify=signedOperatorGrantVerifier(publicKeyPem,()=>now);
 const grant=signEnvelope(operatorGrant());
 assert.equal(await verify(intent,grant),true);
 assert.equal(await verify({...intent,nextEpoch:randomUUID()},grant),false);
 assert.equal(await verify({...intent,ownerId:randomUUID()},grant),false);
 assert.equal(await verify({...intent,generation:4},grant),false);
 assert.equal(await verify({...intent,kind:'enroll'},grant),false);
 const altered=JSON.parse(grant) as {payload:string;signature:string};
 const data=JSON.parse(Buffer.from(altered.payload,'base64url').toString('utf8')) as
  ReturnType<typeof operatorGrant>;
 data.intent.nextOwnerId=randomUUID();
 altered.payload=Buffer.from(JSON.stringify(data)).toString('base64url');
 assert.equal(await verify(intent,JSON.stringify(altered)),false);
 const attackerKey=generateKeyPairSync('ed25519');
 assert.equal(await verify(intent,signEnvelope(operatorGrant(),attackerKey.privateKey)),false);
});
test('signed operator grants are short-lived, expired and too-early denied',async()=>{
 const check=signedOperatorGrantVerifier(publicKeyPem,()=>now);
 assert.equal(await check(intent,signEnvelope(operatorGrant(intent,now-10000,now-1))),false);
 assert.equal(await check(intent,signEnvelope(operatorGrant(intent,now+1000,now+2000))),false);
 assert.equal(await check(intent,signEnvelope(operatorGrant(intent,now-10,now+600000))),false);
});
test('provenance signature binds independent deployment and strict restore domain',async()=>{
 const authorityId=randomUUID(),deploymentId=randomUUID(),
  witnessDomainId=randomUUID(),agentRollbackDomainId=randomUUID();
 let signed=signEnvelope({version:1,authorityId,deploymentId,
  witnessDomainId,agentRollbackDomainId,
  independentlyOperated:true,immutableRetentionVerified:true,
  issuedAt:now-30_000,expiresAt:now+30_000});
 const verify=signedProvenanceVerifier({
  trustedEd25519PublicKeyPem:publicKeyPem,authorityId,
  expectedDeploymentId:deploymentId,expectedWitnessDomainId:witnessDomainId,
  expectedAgentRollbackDomainId:agentRollbackDomainId,
  now:()=>now,fetchSignedAssertion:async()=>signed,
 });
 assert.deepEqual(await verify(),{
  verified:true,authorityId,validUntil:now+30_000,
 });
 // Signed by a legitimate key but not for this independent storage identity.
 signed=signEnvelope({version:1,authorityId,deploymentId,
  witnessDomainId:agentRollbackDomainId,agentRollbackDomainId,
  independentlyOperated:true,immutableRetentionVerified:true,
  issuedAt:now-30_000,expiresAt:now+30_000});
 assert.equal((await verify()).verified,false);
 signed=signEnvelope({version:1,authorityId,deploymentId,
  witnessDomainId,agentRollbackDomainId,
  independentlyOperated:true,immutableRetentionVerified:true,
  issuedAt:now-70_000,expiresAt:now-1});
 assert.equal((await verify()).verified,false);
 signed=signEnvelope({version:1,authorityId,deploymentId,
  witnessDomainId,agentRollbackDomainId,
  independentlyOperated:true,immutableRetentionVerified:true,
  issuedAt:now-30_000,expiresAt:now+30_000},
  generateKeyPairSync('ed25519').privateKey);
 assert.equal((await verify()).verified,false);
});
