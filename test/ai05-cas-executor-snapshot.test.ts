/** AI-05 isolated adversarial executor snapshot tests.
 * These are SOURCE-ONLY; they never authorize CORE or execute real effects. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareCoreWindowsMutation,assertCoreApprovedDispatchRequest,
  snapshotCoreWindowsDispatchRequest,CORE_EXECUTOR_DISPATCH_ENABLED}
  from '../src/agent/core-windows-mutation-dispatch.js';

const mismatch=(code:string)=>(error:unknown):boolean=>
  (error as {code?:string})?.code===code;
const capability='windows.registry.set';

function evidence(){
  const prepared=prepareCoreWindowsMutation(capability,{
    hive:'HKLM',path:'SOFTWARE\\Nexowire',name:'AI05',value:'before',
  });
  const scope=Object.freeze({
    ownerId:'00000000-0000-4000-8000-000000000501',
    deviceId:'00000000-0000-4000-8000-000000000502',
    deviceEpoch:'00000000-0000-4000-8000-000000000503',
    sessionEpoch:'00000000-0000-4000-8000-000000000504',
    ownerEpoch:4,expectedGeneration:7,requiredPrivilege:'CORE' as const,
  });
  const expected=Object.freeze({
    requestId:'00000000-0000-4000-8000-000000000505',
    capability,fingerprint:prepared.fingerprint,scope,
  });
  return {prepared,scope,expected};
}

test('AI-05 nested Proxy before canonicalization has zero trap reads',()=>{
  let traps=0;
  const proxy=new Proxy({name:'unknown'},{
    ownKeys(target){traps++;return Reflect.ownKeys(target)},
    getOwnPropertyDescriptor(target,key){
      traps++;return Reflect.getOwnPropertyDescriptor(target,key);
    },
    getPrototypeOf(target){traps++;return Reflect.getPrototypeOf(target)},
  });
  assert.throws(()=>prepareCoreWindowsMutation(capability,{
    ordinary:'safe',nested:{child:[proxy]},
  }),mismatch('CORE_DISPATCH_INPUT_NOT_CANONICAL'));
  assert.equal(traps,0);
  assert.equal(CORE_EXECUTOR_DISPATCH_ENABLED,false);
});

test('AI-05 frozen accessor-bearing signed callback cannot execute a getter',()=>{
  const {prepared,scope,expected}=evidence();
  let accessed=0;
  const scopeWithAccessor={...scope};
  Object.defineProperty(scopeWithAccessor,'ownerId',{
    configurable:false,enumerable:true,
    get(){accessed++;return scope.ownerId},
  });
  const hostile=Object.freeze({...expected,
    scope:Object.freeze(scopeWithAccessor)});
  assert.throws(()=>assertCoreApprovedDispatchRequest(
    hostile,expected,prepared),
  mismatch('CORE_DISPATCH_APPROVED_REQUEST_MISMATCH'));
  const outer={...expected};
  Object.defineProperty(outer,'fingerprint',{
    configurable:false,enumerable:true,
    get(){accessed++;return prepared.fingerprint},
  });
  assert.throws(()=>assertCoreApprovedDispatchRequest(
    Object.freeze(outer),expected,prepared),
  mismatch('CORE_DISPATCH_APPROVED_REQUEST_MISMATCH'));
  assert.equal(accessed,0);
});

test('AI-05 Proxy-wrapped approved callback rejected without trap execution',()=>{
  const {prepared,scope,expected}=evidence();
  let traps=0;
  const proxy=<T extends object>(value:T):T=>new Proxy(value,{
    ownKeys(target){traps++;return Reflect.ownKeys(target)},
    getOwnPropertyDescriptor(target,key){
      traps++;return Reflect.getOwnPropertyDescriptor(target,key);
    },
    getPrototypeOf(target){traps++;return Reflect.getPrototypeOf(target)},
  });
  assert.throws(()=>assertCoreApprovedDispatchRequest(
    proxy(Object.freeze({...expected})),expected,prepared),
  mismatch('CORE_DISPATCH_APPROVED_REQUEST_MISMATCH'));
  assert.throws(()=>assertCoreApprovedDispatchRequest(
    Object.freeze({...expected,scope:proxy(scope)}),expected,prepared),
  mismatch('CORE_DISPATCH_APPROVED_REQUEST_MISMATCH'));
  assert.equal(traps,0);
});

test('AI-05 original immutable approved evidence continues to bind Broker wire bytes',()=>{
  const {prepared,scope,expected}=evidence();
  const approved=Object.freeze({...expected,scope:Object.freeze({...scope})});
  assert.doesNotThrow(()=>assertCoreApprovedDispatchRequest(
    approved,expected,prepared));
  assert.equal(prepared.brokerBody,JSON.stringify({
    capability,input:prepared.input,
  }));
  assert.equal(CORE_EXECUTOR_DISPATCH_ENABLED,false);
});

test('AI-05 original owner/session/UUID scope detached before any await',()=>{
  const {expected}=evidence();
  const mutable:{requestId:string;scope:{ownerId:string;sessionEpoch:string}}=
    {...expected,scope:{...expected.scope}};
  const frozen=snapshotCoreWindowsDispatchRequest(mutable);
  assert.deepEqual(frozen,expected);
  assert.ok(Object.isFrozen(frozen));
  assert.ok(Object.isFrozen(frozen.scope));
  mutable.requestId='00000000-0000-4000-8000-000000000599';
  mutable.scope.ownerId='00000000-0000-4000-8000-000000000598';
  mutable.scope.sessionEpoch='00000000-0000-4000-8000-000000000597';
  assert.deepEqual(frozen,expected);
  assert.equal(CORE_EXECUTOR_DISPATCH_ENABLED,false);
});

test('AI-05 source dispatch accessors fail closed without invoking getters',()=>{
  const {expected}=evidence();
  let reads=0;
  const root={...expected};
  Object.defineProperty(root,'requestId',{
    enumerable:true,configurable:true,get(){reads++;return expected.requestId},
  });
  assert.throws(()=>snapshotCoreWindowsDispatchRequest(root),
    mismatch('CORE_DISPATCH_REQUEST_BINDING_MISMATCH'));
  const scoped={...expected,scope:{...expected.scope}};
  Object.defineProperty(scoped.scope,'ownerId',{
    enumerable:true,configurable:true,
    get(){reads++;return expected.scope.ownerId},
  });
  assert.throws(()=>snapshotCoreWindowsDispatchRequest(scoped),
    mismatch('CORE_DISPATCH_REQUEST_BINDING_MISMATCH'));
  assert.equal(reads,0);
});

test('AI-05 source dispatch proxies and unknown fields fail closed without traps',()=>{
  const {expected}=evidence();
  let traps=0;
  const proxy=<T extends object>(value:T):T=>new Proxy(value,{
    ownKeys(target){traps++;return Reflect.ownKeys(target)},
    getOwnPropertyDescriptor(target,key){
      traps++;return Reflect.getOwnPropertyDescriptor(target,key);
    },
    getPrototypeOf(target){traps++;return Reflect.getPrototypeOf(target)},
  });
  const cases:unknown[]=[
    proxy({...expected}),
    {...expected,scope:proxy({...expected.scope})},
    {...expected,extra:'forged'},
    {...expected,scope:{...expected.scope,[Symbol('owner')]:5}},
  ];
  for(const candidate of cases)
    assert.throws(()=>snapshotCoreWindowsDispatchRequest(candidate),
      mismatch('CORE_DISPATCH_REQUEST_BINDING_MISMATCH'));
  assert.equal(traps,0);
});

test('AI-05 exported approval comparator never evaluates hostile expected identity',()=>{
  const {prepared,expected}=evidence();
  const approved=Object.freeze({...expected,
    scope:Object.freeze({...expected.scope})});
  let reads=0;
  const malicious={...expected};
  Object.defineProperty(malicious,'fingerprint',{
    enumerable:true,configurable:true,
    get(){reads++;return prepared.fingerprint},
  });
  assert.throws(()=>assertCoreApprovedDispatchRequest(
    approved,malicious,prepared),
  mismatch('CORE_DISPATCH_REQUEST_BINDING_MISMATCH'));
  assert.equal(reads,0);
  assert.equal(CORE_EXECUTOR_DISPATCH_ENABLED,false);
});
