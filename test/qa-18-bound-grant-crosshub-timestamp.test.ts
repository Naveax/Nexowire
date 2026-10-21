/**
 * #18 independent hostile QA targeting #676's ACTUAL exported source adapters.
 * Both Hubs share test-only deterministic SQL and external-CAS state. No
 * PostgreSQL server or physical remote monotonic authority is deployed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign,type KeyObject} from 'node:crypto';
import {signedOperatorGrantVerifier,signedProvenanceVerifier}
  from '../src/agent/witness-signed-provenance.js';
import type {WitnessOperatorIntent}
  from '../src/agent/postgres-monotonic-witness.js';
import {fixture,copy} from './fixtures/qa-18-bound-grant-hostile.js';

const denied=(p:Promise<unknown>,code:string)=>
  assert.rejects(p,{code});
function envelope(payload:Record<string,unknown>,key:KeyObject):string{
 const data=Buffer.from(JSON.stringify(payload));
 return JSON.stringify({payload:data.toString('base64url'),
  signature:sign(null,data,key).toString('base64url')});
}

test('#18 #676: remote revoke wins pending Hub A reserve; Hub B local rollback still fenced',async()=>{
 const f=fixture(),hubA=f.cas,hubB=f.createCas(),request=f.request();
 const localBefore=copy(f.pg.state);
 const gate=f.external.pauseNextReserve();
 const whenRevoked=f.external.whenRevokeIsExternallyCommitted();
 const pending=hubA.reserve(request);
 await gate.entered;
 let transitioning:ReturnType<typeof f.coordinator.revoke>|undefined;
 try{
  transitioning=f.coordinator.revoke(f.revoke());
  await whenRevoked; // remote revoke committed BEFORE paused reserve enters CAS
 }finally{gate.release();}
 await denied(pending,'BOUND_CAS_EXTERNAL_RESERVATION_UNKNOWN');
 const revoked=await transitioning!;
 assert.equal(revoked.external.revoked,true);
 assert.equal(revoked.local.mode,'NONE');
 assert.equal(f.external.reserved.size,0);
 assert.equal(f.pg.state.reservations.size,0);
 f.pg.state=copy(localBefore); // BOTH stale local grant and journal cache
 await denied(hubB.reserve(request),'BOUND_CAS_EXTERNAL_RESERVATION_UNKNOWN');
 assert.equal(f.external.reserved.size,0);
});

test('#18 #676: two Hub objects, one atomic duplicate UUID; rollback local row cannot re-create',async()=>{
 const f=fixture(),a=f.cas,b=f.createCas(),req=f.request();
 const old=copy(f.pg.state);
 const results=await Promise.all(Array.from({length:32},(_,i)=>
  (i%2?a:b).reserve(req)));
 assert.equal(results.filter(x=>x.created).length,1);
 assert.equal(new Set(results.map(x=>x.sequence)).size,1);
 assert.equal(f.external.reserved.size,1);
 f.pg.state=copy(old);
 assert.equal((await b.reserve(req)).created,false);
 assert.equal(f.pg.state.reservations.size,0);
 assert.equal(f.external.reserved.size,1);
});

test('#18 #676: signed owner re-pair fences two stale Hubs even after PostgreSQL restore',async()=>{
 const f=fixture(),a=f.cas,b=f.createCas();
 const historical=f.request();
 assert.equal((await a.reserve(historical)).created,true);
 const backup=copy(f.pg.state);
 const oldIdentity={...f.scope},oldOwner=f.ids.ownerId,oldEpoch=f.ids.epoch;
 const nextOwner=randomUUID(),nextEpoch=randomUUID(),nextSession=randomUUID();
 const transition=await f.coordinator.rePair({
  action:'re_pair',deviceId:f.ids.deviceId,ownerId:oldOwner,
  deviceEpoch:oldEpoch,sessionEpoch:oldIdentity.sessionEpoch,
  expectedGeneration:2,signedProof:'SIGNED_APPROVAL_FIXTURE_'.repeat(3),
  newOwnerId:nextOwner,newDeviceEpoch:nextEpoch,newSessionEpoch:nextSession,
 });
 assert.equal(transition.local.mode,'NONE');
 assert.equal(transition.external.generation,3);
 assert.equal(f.external.reserved.size,1);
 // Recover BOTH local grant + tombstone from a stale disk snapshot;
 // the synthetic external authority alone retains authoritative new epoch.
 f.pg.state=copy(backup);
 await denied(a.reserve(f.request()),'BOUND_CAS_EXTERNAL_RESERVATION_UNKNOWN');
 await denied(b.reserve(historical),'BOUND_CAS_EXTERNAL_RESERVATION_UNKNOWN');
 assert.equal(f.external.reserved.size,1);
 assert.equal(f.pg.state.reservations.size,1);
 assert.equal(f.pg.state.grant.get(f.ids.deviceId)?.core_enabled,true);
 // Stale local CORE=true is NEVER evidence of externally effective CORE.
 assert.equal(f.external.ids.ownerId,nextOwner);
 assert.equal(f.external.ids.epoch,nextEpoch);
 assert.equal(f.external.ids.session,nextSession);
});

test('#18 #676: forged external generation receipt is rejected after remote reservation',async()=>{
 const f=fixture(),req=f.request();
 const original=f.external.reserveIfCurrent.bind(f.external);
 f.external.reserveIfCurrent=async(request,scope)=>({
  ...await original(request,scope),grantGeneration:scope.expectedGeneration+1,
 });
 await denied(f.cas.reserve(req),'BOUND_CAS_EXTERNAL_PROOF_MISMATCH');
 assert.equal(f.external.reserved.size,1);
 assert.equal(f.pg.state.reservations.size,0);
 // With genuinely generated original receipt, follow-up is created:false.
 f.external.reserveIfCurrent=original;
 assert.equal((await f.createCas().reserve(req)).created,false);
});

test('#18 #676: actual Ed25519 future, expired, length-forged and tampered owner timestamps deny revoke',async()=>{
 let now=Date.now();
 const keys=generateKeyPairSync('ed25519');
 const pub=keys.publicKey.export({type:'spki',format:'pem'}).toString();
 const verifier=signedOperatorGrantVerifier(pub,()=>now);
 const f=fixture({verifyOperatorApproval:verifier});
 const c=f.revoke();
 const intent:WitnessOperatorIntent={
  kind:'revoke',authorityId:f.ids.authorityId,deviceId:c.deviceId,
  ownerId:c.ownerId,epoch:c.deviceEpoch,sessionEpoch:c.sessionEpoch,
  generation:c.expectedGeneration,
 };
 const approval=(issuedAt:number,expiresAt:number,kind:WitnessOperatorIntent['kind']='revoke')=>
  envelope({version:1,intent:{...intent,kind},nonce:randomUUID(),
   issuedAt,expiresAt},keys.privateKey);
 const bad=[approval(now+1,now+60_000),approval(now-60_000,now-1),
  approval(now-1000,now+300_001),approval(now-1000,now+60_000,'re_pair')];
 const legit=approval(now-1000,now+60_000);
 const obj=JSON.parse(legit) as {payload:string;signature:string};
 const altered=JSON.parse(Buffer.from(obj.payload,'base64url').toString()) as
  Record<string,unknown>;
 altered.issuedAt=now+1000; // keep real signature, forge only claimed clock
 bad.push(JSON.stringify({...obj,
  payload:Buffer.from(JSON.stringify(altered)).toString('base64url')}));
 for(const proof of bad){
  await denied(f.coordinator.revoke({...c,signedProof:proof}),
   'TRANSITION_SIGNATURE_UNTRUSTED');
 }
 assert.equal(f.external.revoked,false);
 assert.equal(f.pg.state.grant.get(f.ids.deviceId)?.generation,2);
 const outcome=await f.coordinator.revoke({...c,signedProof:legit});
 assert.equal(outcome.external.revoked,true);
 now+=1;
 // Still time-valid signed approval does not resurrect a revoked CORE grant.
 await denied(f.coordinator.revoke({...c,signedProof:legit}),
  'REVOKE_EXTERNAL_OUTCOME_UNKNOWN');
 assert.equal(f.external.revoked,true);
});

test('#18 #676: signed provenance future/expired timestamps deny bound reserve',async()=>{
 const keys=generateKeyPairSync('ed25519');
 const authority=randomUUID(),deployment=randomUUID(),
  witnessDomain=randomUUID(),agentDomain=randomUUID();
 let now=Date.now();
 const attest=(issuedAt:number,expiresAt:number,key=keys.privateKey)=>
  envelope({version:1,authorityId:authority,deploymentId:deployment,
   witnessDomainId:witnessDomain,agentRollbackDomainId:agentDomain,
   independentlyOperated:true,immutableRetentionVerified:true,
   issuedAt,expiresAt},key);
 let assertion=attest(now+1,now+60_000);
 const checker=signedProvenanceVerifier({
  trustedEd25519PublicKeyPem:keys.publicKey.export({
   type:'spki',format:'pem'}).toString(),authorityId:authority,
  expectedDeploymentId:deployment,expectedWitnessDomainId:witnessDomain,
  expectedAgentRollbackDomainId:agentDomain,
  fetchSignedAssertion:async()=>assertion,now:()=>now,
 });
 assert.equal((await checker()).verified,false);
 assertion=attest(now-60_000,now-1);
 assert.equal((await checker()).verified,false);
 assertion=attest(now-1000,now+300_001);
 assert.equal((await checker()).verified,false);
 const attacker=generateKeyPairSync('ed25519');
 assertion=attest(now-1000,now+60_000,attacker.privateKey);
 assert.equal((await checker()).verified,false);
 assertion=attest(now-1000,now+60_000);
 assert.equal((await checker()).verified,true);
 now+=60_001;
 assert.equal((await checker()).verified,false);
 // Valid signature alone is a claim; no physically independent remote
 // storage, immutable high-water or custody is proved by this test.
});
