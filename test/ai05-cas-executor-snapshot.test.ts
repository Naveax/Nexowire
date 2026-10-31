/** AI-05 isolated adversarial executor snapshot tests.
 * These are SOURCE-ONLY; they never authorize CORE or execute real effects. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareCoreWindowsMutation,assertCoreApprovedDispatchRequest,
  CORE_EXECUTOR_DISPATCH_ENABLED}
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
