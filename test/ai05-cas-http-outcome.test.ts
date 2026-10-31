/**
 * AI-05: HTTPS CAS transport returns cannot make uncertain mutations replayable.
 * All network replies are synthetic: no real CAS, credentials or OS effects.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {HttpsExternalGrantCas} from '../src/agent/https-external-grant-cas.js';

const ids={
  authority:'00000000-0000-4000-8000-000000000201',
  owner:'00000000-0000-4000-8000-000000000202',
  device:'00000000-0000-4000-8000-000000000203',
  epoch:'00000000-0000-4000-8000-000000000204',
  session:'00000000-0000-4000-8000-000000000205',
  request:'00000000-0000-4000-8000-000000000206',
  newOwner:'00000000-0000-4000-8000-000000000207',
  newEpoch:'00000000-0000-4000-8000-000000000208',
  newSession:'00000000-0000-4000-8000-000000000209',
};
const client=()=>new HttpsExternalGrantCas({
  endpoint:'https://nexowire-cas.invalid/v1/grant-cas/reserve',
  authorityId:ids.authority,
  credentialFor:async()=> 'test-only-not-an-authority-credential',
});
const operation={
  deviceId:ids.device,epoch:ids.epoch,requestId:ids.request,
  fingerprint:'a'.repeat(64),capability:'windows.registry.set',
};
const grant={
  ownerId:ids.owner,deviceId:ids.device,
  deviceEpoch:ids.epoch,sessionEpoch:ids.session,
  expectedGeneration:4,requiredPrivilege:'CORE' as const,
};
const revoke={
  deviceId:ids.device,ownerId:ids.owner,
  deviceEpoch:ids.epoch,sessionEpoch:ids.session,
  expectedGeneration:4,signedOwnerApproval:'x'.repeat(64),
};
const repair={
  ...revoke,newOwnerId:ids.newOwner,
  newDeviceEpoch:ids.newEpoch,newSessionEpoch:ids.newSession,
};
const code=(value:string)=>(e:unknown):boolean=>
  (e as {code?:string})?.code===value;

test('AI-05 HTTP 408/425/429/5xx after CAS request always means UNKNOWN',async t=>{
  let responseStatus=503,callCount=0;
  const paths:string[]=[];
  t.mock.method(globalThis,'fetch',async (input:URL|Request|string)=>{
    callCount++;
    paths.push(String(input));
    return new Response('upstream uncertain',{status:responseStatus});
  });
  const cas=client();
  for(const status of [408,425,429,500,503,504]){
    responseStatus=status;
    const before=callCount;
    await assert.rejects(cas.reserveIfCurrent(operation,grant),
      code('EXTERNAL_GRANT_TRANSPORT_UNKNOWN'));
    await assert.rejects(cas.revokeIfCurrent(revoke),
      code('EXTERNAL_REVOKE_OUTCOME_UNKNOWN'));
    await assert.rejects(cas.rePairIfCurrent(repair),
      code('EXTERNAL_REPAIR_OUTCOME_UNKNOWN'));
    assert.equal(callCount,before+3,'no hidden retry after uncertain HTTP');
  }
  assert.equal(paths.length,18);
  assert.ok(paths.every(p=>p.startsWith('https://nexowire-cas.invalid/')));
});

test('AI-05 verified terminal HTTP 403/409 remains refusal, not an execution permit',async t=>{
  let responseStatus=403,callCount=0;
  t.mock.method(globalThis,'fetch',async ()=>{
    callCount++;
    return new Response('explicit rejection',{status:responseStatus});
  });
  const cas=client();
  for(const status of [403,409]){
    responseStatus=status;
    await assert.rejects(cas.reserveIfCurrent(operation,grant),
      code('EXTERNAL_GRANT_AUTHORITY_REFUSED'));
    await assert.rejects(cas.revokeIfCurrent(revoke),
      code('EXTERNAL_REVOKE_AUTHORITY_REFUSED'));
    await assert.rejects(cas.rePairIfCurrent(repair),
      code('EXTERNAL_REPAIR_AUTHORITY_REFUSED'));
  }
  assert.equal(callCount,6);
});
