import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {executeTrustedNativeMutation,type TrustedNativeMutationProvider}
  from '../../src/agent/native-atomic-effect-admission.js';
import type {AtomicMutationAuthority,MutationReservation} from '../../src/core/atomic-mutation-authority.js';
import {runPrivilegedBroker} from '../../src/agent/privileged-broker.js';
import type {BrokerExternalEffectAdmission} from '../../src/agent/privileged-broker-effect-admission.js';

const deviceId='fixture-device',requestId=randomUUID(),capability='fixture.no-effect';
const exactFrame=JSON.stringify({type:'request',requestId,capability,input:{},accessMode:'full'});
const input={deviceId,requestId,capability,exactFrame};
const code=(e:unknown)=>(e as {code?:string})?.code;
function fixture(admit:AtomicMutationAuthority['admitNativeEffectOnce']){
  const permit:MutationReservation={authorityId:'fixture-authority',ownerId:'fixture-owner',
    deviceId,requestId,capability,fingerprint:createHash('sha256').update(exactFrame).digest('hex'),
    authorizationEpoch:1,leaseExpiresAtMs:Date.now()+2000,reservationId:randomUUID(),created:true};
  const authority:AtomicMutationAuthority={reserveFresh:async()=>{throw Error('no reserve')},
    dispatchIfCurrent:async()=>{throw Error('no enqueue')},admitNativeEffectOnce:admit};
  const provider:TrustedNativeMutationProvider={authority,resolveTrustedReservation:async()=>permit};
  return {permit,provider};
}
test('native callback requires a completed single effect; zero or detached callbacks deny',async()=>{
  let calls=0,late:(()=>Promise<void>)|undefined;
  const f=fixture(async(_p,effect)=>{late=effect});
  await assert.rejects(executeTrustedNativeMutation({...input,provider:f.provider},async()=>{calls++}),
    e=>code(e)==='NATIVE_MUTATION_EFFECT_NOT_CONFIRMED');
  assert.ok(late);
  await assert.rejects(late(),e=>code(e)==='NATIVE_MUTATION_CALLBACK_INVALID');
  assert.equal(calls,0);
  const twice=fixture(async(_p,effect)=>{await effect();await effect().catch(()=>{})});
  await assert.rejects(executeTrustedNativeMutation({...input,provider:twice.provider},async()=>{calls++}),
    e=>code(e)==='NATIVE_MUTATION_EFFECT_NOT_CONFIRMED');
  assert.equal(calls,1);
  const failed=fixture(async(_p,effect)=>{await effect().catch(()=>{})});
  await assert.rejects(executeTrustedNativeMutation({...input,provider:failed.provider},async()=>{throw Error('fixture failure')}),
    e=>code(e)==='NATIVE_MUTATION_EFFECT_NOT_CONFIRMED');
});
test('native effect reservation is detached, immutable and checked at actual callback',async()=>{
  let calls=0;
  const f=fixture(async(p,effect)=>{
    assert.ok(Object.isFrozen(p));assert.notEqual(p,f.permit);
    assert.equal(p.fingerprint,createHash('sha256').update(exactFrame).digest('hex'));
    (f.permit as {fingerprint:string}).fingerprint='0'.repeat(64);
    await effect();
  });
  assert.equal(await executeTrustedNativeMutation({...input,provider:f.provider},async()=>++calls),1);
  const bad=fixture(async()=>{assert.fail('accessor must not reach admission')});
  let accesses=0;
  Object.defineProperty(bad.permit,'fingerprint',{get(){accesses++;return '0'.repeat(64)}});
  await assert.rejects(executeTrustedNativeMutation({...input,provider:bad.provider},async()=>++calls),
    e=>code(e)==='NATIVE_MUTATION_RESERVATION_INVALID');
  assert.equal(accesses,0);assert.equal(calls,1);
});
test('protected startup refuses external/local-owner conflict before reading token or opening listener',async()=>{
  const unavailable:BrokerExternalEffectAdmission={readVerifiedBinding:async()=>null,
    begin:async()=>null,commit:async()=>null,verifyReceipt:async()=>false,readVerifiedBindingNow:()=>null};
  await assert.rejects(runPrivilegedBroker({},['--local-owner-effects'],unavailable),/BROKER_EFFECT_AUTHORITY_CONFLICT/);
  if(process.platform!=='win32')await assert.rejects(runPrivilegedBroker({},[],unavailable),/BROKER_HIGH_TOKEN_REQUIRED/);
});
