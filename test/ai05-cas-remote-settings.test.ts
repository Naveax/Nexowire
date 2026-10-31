/**
 * AI-05: client-owned remote CAS request, authority and credentials are pinned.
 * These tests use mock fetch responses only, not a live CAS or OS grant.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {RemoteMutationCasClient,HttpsMonotonicTrustRoot}
  from '../src/agent/remote-mutation-cas.js';

const ids={
  authority:'00000000-0000-4000-8000-000000000301',
  foreignAuthority:'00000000-0000-4000-8000-000000000302',
  device:'00000000-0000-4000-8000-000000000303',
  foreignDevice:'00000000-0000-4000-8000-000000000304',
  epoch:'00000000-0000-4000-8000-000000000305',
  request:'00000000-0000-4000-8000-000000000306',
};
const originalToken='original-test-credential-secret';
const foreignToken='foreign-test-credential-secret';
const errorCode=(code:string)=>(error:unknown):boolean=>
  (error as {code?:string})?.code===code;
const request=()=>({
  deviceId:ids.device,epoch:ids.epoch,requestId:ids.request,
  fingerprint:'d'.repeat(64),capability:'windows.registry.set',
});
function validReceipt(){
  return {authorityId:ids.authority,deviceId:ids.device,epoch:ids.epoch,
    requestId:ids.request,created:true,sequence:51};
}

test('AI-05 remote CAS client pins original authority/device/token after constructor',async t=>{
  const borrowed={
    endpoint:'https://nexowire-witness.invalid/v1/reservations',
    token:originalToken,deviceId:ids.device,epoch:ids.epoch,
    authorityId:ids.authority,
  };
  const client=new RemoteMutationCasClient(borrowed);
  borrowed.authorityId=ids.foreignAuthority;
  borrowed.deviceId=ids.foreignDevice;
  borrowed.token=foreignToken;
  let calls=0;
  t.mock.method(globalThis,'fetch',async (target:URL|Request|string,init?:RequestInit)=>{
    calls++;
    assert.equal(String(target),'https://nexowire-witness.invalid/v1/reservations');
    assert.equal(new Headers(init?.headers).get('authorization'),
      'Bearer '+originalToken);
    assert.deepEqual(JSON.parse(String(init?.body)),request());
    return new Response(JSON.stringify(validReceipt()),{status:200});
  });
  const result=await client.reserve(ids.request,'d'.repeat(64),'windows.registry.set');
  assert.deepEqual(result,validReceipt());
  assert.equal(calls,1);
});

test('AI-05 monotonic witness pins credential resolver and authority before reserve',async t=>{
  let originalResolverCalls=0,foreignResolverCalls=0,wireCalls=0;
  const mutable={
    endpoint:'https://nexowire-witness.invalid/v1/reservations',
    authorityId:ids.authority,
    tokenForEnrolledDevice:(_deviceId:string,_epoch:string)=>{
      originalResolverCalls++;return originalToken;
    },
  };
  const witness=new HttpsMonotonicTrustRoot(mutable);
  mutable.authorityId=ids.foreignAuthority;
  mutable.tokenForEnrolledDevice=()=>{
    foreignResolverCalls++;return foreignToken;
  };
  t.mock.method(globalThis,'fetch',async (_:URL|Request|string,init?:RequestInit)=>{
    wireCalls++;
    assert.equal(new Headers(init?.headers).get('authorization'),
      'Bearer '+originalToken);
    return new Response(JSON.stringify(validReceipt()),{status:200});
  });
  assert.deepEqual(await witness.reserve(request()),validReceipt());
  assert.equal(originalResolverCalls,1);
  assert.equal(foreignResolverCalls,0);
  assert.equal(wireCalls,1);
});

test('AI-05 hostile remote request getter/proxy never reaches credential or CAS',async()=>{
  let accessorCalls=0,proxyTraps=0,credentialCalls=0;
  const witness=new HttpsMonotonicTrustRoot({
    endpoint:'https://nexowire-witness.invalid/v1/reservations',
    authorityId:ids.authority,
    tokenForEnrolledDevice:()=>{
      credentialCalls++;return originalToken;
    },
  });
  const hostile=Object.defineProperty(request(),'requestId',{
    enumerable:true,configurable:true,
    get(){accessorCalls++;return ids.request},
  });
  const proxy=new Proxy(request(),{
    getOwnPropertyDescriptor(target,key){
      proxyTraps++;return Reflect.getOwnPropertyDescriptor(target,key);
    },
  });
  const hidden=Object.defineProperty(request(),'fingerprint',{
    enumerable:false,value:'d'.repeat(64),
  });
  const extra={...request(),unexpected:'authority'};
  for(const input of [hostile,proxy,hidden,extra])
    await assert.rejects(witness.reserve(input),errorCode('CAS_REQUEST_INVALID'));
  assert.equal(accessorCalls,0);
  assert.equal(proxyTraps,0);
  assert.equal(credentialCalls,0);
});

test('AI-05 remote HTTPS endpoint and runtime witness configuration cannot be retargeted',async t=>{
  const client=new RemoteMutationCasClient({
    endpoint:'https://nexowire-witness.invalid/v1/reservations',
    token:originalToken,deviceId:ids.device,epoch:ids.epoch,
    authorityId:ids.authority,
  });
  assert.equal(Reflect.get(client,'url'),
    'https://nexowire-witness.invalid/v1/reservations');
  assert.equal(Reflect.set(client,'url',new URL(
    'https://foreign-witness.invalid/v1/reservations')),false);
  assert.equal(Reflect.set(client,'settings',{
    endpoint:'https://foreign-witness.invalid/v1/reservations',
    token:foreignToken,authorityId:ids.foreignAuthority,
    deviceId:ids.foreignDevice,epoch:ids.epoch,
  }),false);
  const witness=new HttpsMonotonicTrustRoot({
    endpoint:'https://nexowire-witness.invalid/v1/reservations',
    authorityId:ids.authority,
    tokenForEnrolledDevice:()=>originalToken,
  });
  assert.equal(Reflect.set(witness,'config',{
    endpoint:'https://foreign-witness.invalid/v1/reservations',
    authorityId:ids.foreignAuthority,
    tokenForEnrolledDevice:()=>foreignToken,
  }),false);
  let requests=0;
  t.mock.method(globalThis,'fetch',async (url:URL|Request|string,init?:RequestInit)=>{
    requests++;
    assert.equal(String(url),
      'https://nexowire-witness.invalid/v1/reservations');
    assert.equal(new Headers(init?.headers).get('authorization'),
      'Bearer '+originalToken);
    return new Response(JSON.stringify(validReceipt()),{status:200});
  });
  assert.deepEqual(await client.reserve(ids.request,'d'.repeat(64),
    'windows.registry.set'),validReceipt());
  assert.deepEqual(await witness.reserve(request()),validReceipt());
  assert.equal(requests,2);
});
