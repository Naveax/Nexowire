/**
 * Independent #10 QA for #925. This is an in-process fetch fixture.
 * No TLS listener, deployed CAS, protected credential or rollback storage.
 * Verifies fresh challenge association for reserve/revoke/re-pair responses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {HttpsExternalGrantCas} from '../src/agent/https-external-grant-cas.js';

test('old reserve/revoke/re-pair response cannot answer any fresh challenge', async()=>{
 const originalFetch=globalThis.fetch;
 const authorityId=randomUUID(),deviceId=randomUUID(),deviceEpoch=randomUUID(),
   sessionEpoch=randomUUID(),ownerId=randomUUID();
 const challengeHistory=new Map<string,string[]>();
 const firstResponse=new Map<string,Record<string,unknown>>();
 const replay=new Set<string>();
 const accepted:string[]=[];
 const transport=new HttpsExternalGrantCas({
  endpoint:'https://cas-fixture.invalid/v1/grant-cas/reserve',
  authorityId,credentialFor:async()=>('TEST_CREDENTIAL_NON_PRODUCTION_'.repeat(2)),
 });
 const scope={ownerId,deviceId,deviceEpoch,sessionEpoch,
  expectedGeneration:7,requiredPrivilege:'CORE' as const};
 const request={deviceId,epoch:deviceEpoch,requestId:randomUUID(),
  fingerprint:'c'.repeat(64),capability:'shell.exec'};
 const revoke={deviceId,ownerId,deviceEpoch,sessionEpoch,
  expectedGeneration:7,signedOwnerApproval:'fixture-owner-approval-'.repeat(3)};
 const repair={...revoke,newOwnerId:randomUUID(),newDeviceEpoch:randomUUID(),
  newSessionEpoch:randomUUID()};
 const reply=(route:string,input:Record<string,any>):Record<string,unknown>=>{
  const challengeNonce=input.challengeNonce as string;
  if(route==='reserve'){
   const operation=input.request,authorization=input.scope;
   return {challengeNonce,authorityId,deviceId:operation.deviceId,
    epoch:operation.epoch,requestId:operation.requestId,
    ownerId:authorization.ownerId,sessionEpoch:authorization.sessionEpoch,
    grantGeneration:authorization.expectedGeneration,
    fingerprint:operation.fingerprint,capability:operation.capability,
    created:true,sequence:1};
  }
  const common={challengeNonce,authorityId,deviceId:input.deviceId,
   ownerId:input.ownerId,deviceEpoch:input.deviceEpoch,
   sessionEpoch:input.sessionEpoch,
   previousGeneration:input.expectedGeneration,
   generation:input.expectedGeneration+1,revoked:true};
  return route==='revoke'?common:{
   ...common,newOwnerId:input.newOwnerId,
   newDeviceEpoch:input.newDeviceEpoch,
   newSessionEpoch:input.newSessionEpoch,coreCleared:true};
 };
 try{
  globalThis.fetch=async(input,init)=>{
   const route=new URL(String(input)).pathname.split('/').at(-1)!;
   assert.ok(['reserve','revoke','re-pair'].includes(route));
   const data=JSON.parse(String(init?.body)) as Record<string,any>;
   assert.match(data.challengeNonce,/^[0-9a-f]{64}$/);
   assert.equal(new Headers(init?.headers).get('authorization'),
    'Bearer '+('TEST_CREDENTIAL_NON_PRODUCTION_'.repeat(2)));
   const prior=challengeHistory.get(route)??[];
   prior.push(data.challengeNonce);
   challengeHistory.set(route,prior);
   const created=reply(route,data);
   if(!firstResponse.has(route))firstResponse.set(route,created);
   const body=replay.has(route)?firstResponse.get(route)!:created;
   return new Response(JSON.stringify(body),{
    status:200,headers:{'content-type':'application/json'}});
  };
  // Each replay returns the complete older response, including valid scope.
  // The only changed property on identical-request replay is client nonce.
  accepted.push('reserve');
  assert.equal((await transport.reserveIfCurrent(request,scope)).created,true);
  replay.add('reserve');
  await assert.rejects(transport.reserveIfCurrent(request,scope),
   {code:'EXTERNAL_GRANT_PROOF_SCOPE_MISMATCH'});
  // Different request ID must also be rejected, even when old response
  // advertises created:true and a plausible positive sequence.
  await assert.rejects(transport.reserveIfCurrent({...request,
    requestId:randomUUID()},scope),
   {code:'EXTERNAL_GRANT_PROOF_SCOPE_MISMATCH'});
  replay.delete('reserve');

  accepted.push('revoke');
  assert.equal((await transport.revokeIfCurrent(revoke)).revoked,true);
  replay.add('revoke');
  await assert.rejects(transport.revokeIfCurrent(revoke),
   {code:'EXTERNAL_REVOKE_PROOF_SCOPE_MISMATCH'});
  replay.delete('revoke');

  accepted.push('re-pair');
  assert.equal((await transport.rePairIfCurrent(repair)).coreCleared,true);
  replay.add('re-pair');
  await assert.rejects(transport.rePairIfCurrent(repair),
   {code:'EXTERNAL_REPAIR_PROOF_SCOPE_MISMATCH'});
  replay.delete('re-pair');

  for(const route of ['reserve','revoke','re-pair']){
   const history=challengeHistory.get(route)!;
   assert.ok(history.length>=2);
   assert.equal(new Set(history).size,history.length,
    route+': every request must generate an independent 256-bit nonce');
  }
  assert.deepEqual(accepted,['reserve','revoke','re-pair'],
   'no replay response was accepted as a new receipt');
 }finally{
  globalThis.fetch=originalFetch;
 }
});

test('missing challenge in an otherwise scoped grant receipt fails closed',async()=>{
 const originalFetch=globalThis.fetch;
 const authorityId=randomUUID(),deviceId=randomUUID(),deviceEpoch=randomUUID(),
  ownerId=randomUUID(),sessionEpoch=randomUUID(),requestId=randomUUID();
 const input={deviceId,epoch:deviceEpoch,requestId,fingerprint:'f'.repeat(64),
  capability:'shell.exec'};
 const scope={ownerId,deviceId,deviceEpoch,sessionEpoch,
  expectedGeneration:4,requiredPrivilege:'CORE' as const};
 const client=new HttpsExternalGrantCas({
  endpoint:'https://cas-fixture.invalid/v1/grant-cas/reserve',
  authorityId,credentialFor:async()=>('TEST_CREDENTIAL_NON_PRODUCTION_'.repeat(2)),
 });
 try{
  globalThis.fetch=async()=>{
   // Full positive fields; only the requested 256-bit challenge is absent.
   return new Response(JSON.stringify({
    authorityId,deviceId,epoch:deviceEpoch,requestId,ownerId,sessionEpoch,
    grantGeneration:4,fingerprint:input.fingerprint,capability:input.capability,
    created:true,sequence:1,
   }),{status:200});
  };
  await assert.rejects(client.reserveIfCurrent(input,scope),
   {code:'EXTERNAL_GRANT_PROOF_INVALID'});
 }finally{
  globalThis.fetch=originalFetch;
 }
});
