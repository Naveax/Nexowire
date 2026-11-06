import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import type WebSocket from 'ws';
import {AgentBroker} from '../../src/core/agent-broker.js';
import type {AgentHello} from '../../src/protocol/agent.js';
import {executeTrustedNativeMutation, type TrustedNativeMutationProvider}
  from '../../src/agent/native-atomic-effect-admission.js';
import type {AtomicMutationAuthority, MutationReservation}
  from '../../src/core/atomic-mutation-authority.js';

const device='device-ai05', owner='owner-ai05', authorityId='authority-ai05';
const requestId=randomUUID();
const capability='files.write';
const frame=JSON.stringify({type:'request',requestId,capability,
  input:{path:'C:\\disposable\\no-effect'},accessMode:'full'});
const fingerprint=createHash('sha256').update(frame).digest('hex');

function fixture() {
  const consumed=new Set<string>();
  let effectCount=0, revoked=false, tamper=false, lookups=0;
  const permit:MutationReservation={
    deviceId:device,ownerId:owner,authorityId,authorizationEpoch:5,
    leaseExpiresAtMs:Date.now()+30_000,requestId,capability,fingerprint,
    reservationId:randomUUID(),created:true,
  };
  const authority:AtomicMutationAuthority={
    async reserveFresh(){throw new Error('native authority cannot reserve');},
    async dispatchIfCurrent(){throw new Error('native authority cannot dispatch');},
    async admitNativeEffectOnce(p,effect) {
      if (revoked || consumed.has(p.reservationId)) throw new Error('DENIED');
      consumed.add(p.reservationId);
      await effect();
    },
  };
  const provider:TrustedNativeMutationProvider={
    authority,
    async resolveTrustedReservation(){lookups++;return tamper?{...permit,fingerprint:'0'.repeat(64)}:permit;},
  };
  return {provider, get effects(){return effectCount;}, get lookups(){return lookups;},
    revoke(){revoked=true;}, tamper(){tamper=true;},
    effect:async()=>{effectCount++;return 'synthetic-result';},
  };
}
const intent={deviceId:device,requestId,capability,exactFrame:frame};
const errorCode=(error:unknown)=>(error as {code?:string})?.code;

test('AI-05 native effect requires an independent authority, never a bare Hub frame',async()=>{
  let calls=0;
  await assert.rejects(
    executeTrustedNativeMutation({...intent},async()=>{calls++;}),
    error=>errorCode(error)==='NATIVE_MUTATION_AUTHORITY_UNAVAILABLE');
  assert.equal(calls,0);
});
test('AI-05 native effect accepts exactly one matching independent reservation',async()=>{
  const f=fixture();
  assert.equal(await executeTrustedNativeMutation({...intent,provider:f.provider},f.effect),
    'synthetic-result');
  await assert.rejects(
    executeTrustedNativeMutation({...intent,provider:f.provider},f.effect),
    error=>errorCode(error)==='NATIVE_MUTATION_EFFECT_NOT_ADMITTED');
  assert.equal(f.effects,1);
  assert.equal(f.lookups,2);
});
test('AI-05 native rejects wrong scope, wire digest, and revoked authority without OS effects',async()=>{
  const wrong=fixture();
  await assert.rejects(
    executeTrustedNativeMutation({...intent,deviceId:'wrong-device',provider:wrong.provider},wrong.effect),
    error=>errorCode(error)==='NATIVE_MUTATION_RESERVATION_INVALID');
  wrong.tamper();
  await assert.rejects(
    executeTrustedNativeMutation({...intent,provider:wrong.provider},wrong.effect),
    error=>errorCode(error)==='NATIVE_MUTATION_RESERVATION_INVALID');
  const revoked=fixture();revoked.revoke();
  await assert.rejects(
    executeTrustedNativeMutation({...intent,provider:revoked.provider},revoked.effect),
    error=>errorCode(error)==='NATIVE_MUTATION_EFFECT_NOT_ADMITTED');
  assert.equal(wrong.effects,0);assert.equal(revoked.effects,0);
});
test('AI-05 stalled trusted resolver times out referenced and denies zero effects',async()=>{
  const f=fixture();
  const stuck:TrustedNativeMutationProvider={
    ...f.provider,
    async resolveTrustedReservation(){return await new Promise<MutationReservation>(()=>{});},
  };
  await assert.rejects(
    executeTrustedNativeMutation({...intent,provider:stuck,timeoutMs:250},f.effect),
    error=>errorCode(error)==='NATIVE_MUTATION_AUTHORITY_UNAVAILABLE');
  assert.equal(f.effects,0);
});
test('AI-05 Broker atomic opt-in refuses to register socket without trusted coordinator',()=>{
  const broker=new AgentBroker({requireAtomicMutationAuthority:true});
  let closes=0,closeCode=0;
  const socket={close(code:number){closes++;closeCode=code;}} as unknown as WebSocket;
  broker.register(socket,{} as AgentHello,async()=>true);
  assert.equal(closes,1);
  assert.equal(closeCode,1008);
  assert.equal(broker.isMandatoryAtomicMutationAuthorityEnabled(),true);
});
