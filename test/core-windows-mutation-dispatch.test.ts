import test from 'node:test';
import assert from 'node:assert/strict';
import {PathPolicy} from '../src/agent/path-policy.js';
import {executeCapability} from '../src/agent/executors.js';
import {
  CORE_EXECUTOR_DISPATCH_ENABLED,
  assertCoreWindowsMutationAdmission,
  coreWindowsEffectFingerprint,
  executeCoreWindowsMutation,
} from '../src/agent/core-windows-mutation-dispatch.js';
import type {PrivilegedBrokerClient} from '../src/agent/privileged-broker-client.js';

const policy=new PathPolicy(['*']);
const machineRegistry={hive:'HKLM',path:'SOFTWARE\\Nexowire',
  name:'P0',type:'string',value:'blocked'};
const machineEnvironment={scope:'machine',name:'NEXOWIRE_P0',
  value:'blocked'};
const matchCode=(code:string)=>(error:unknown):boolean=>
  (error as {code?:string})?.code===code;

test('#03 CORE dispatch remains hard-disabled (not a fixture-enabled runtime)',()=>{
  assert.equal(CORE_EXECUTOR_DISPATCH_ENABLED,false);
});

test('native Windows mutation source rejects legacy bearer-only callers',()=>{
  for(const [capability,input] of [
    ['windows.service.control',{name:'test',action:'start'}],
    ['windows.registry.set',machineRegistry],
    ['windows.registry.delete',{hive:'HKLM',path:'SOFTWARE\\Nexowire'}],
    ['windows.task.control',{name:'Test',action:'start'}],
    ['windows.firewall.control',{name:'Test',action:'enable'}],
    ['windows.environment.set',machineEnvironment],
    ['windows.environment.delete',{scope:'machine',name:'NEXOWIRE_P0'}],
  ] as const){
    assert.throws(()=>assertCoreWindowsMutationAdmission(capability,input),
      matchCode('CORE_DISPATCH_EXTERNAL_ADMISSION_REQUIRED'),capability);
  }
  // Unprivileged user/process env requests are not mislabeled CORE.
  assert.doesNotThrow(()=>assertCoreWindowsMutationAdmission(
    'windows.environment.set',{scope:'process',name:'A',value:'B'}));
  assert.doesNotThrow(()=>assertCoreWindowsMutationAdmission(
    'windows.registry.set',{hive:'HKCU',path:'Software\\Test',name:'A'}));
});

test('actual Agent elevated dispatch refuses both direct and legacy Broker forwarding',async()=>{
  let callbackCalls=0;
  const privilegedBroker={
    execute:async()=>{callbackCalls++;return {data:'UNEXPECTED_OS_EFFECT'};},
  } as unknown as PrivilegedBrokerClient;
  for(const [capability,input] of [
    ['windows.registry.set',machineRegistry],
    ['windows.environment.set',machineEnvironment],
    ['windows.service.control',{name:'Test',action:'start'}],
  ] as const){
    await assert.rejects(executeCapability(capability,input,policy,{
      privilegeMode:'broker',accessMode:'full',privilegedBroker,
    }),matchCode('CORE_EXECUTOR_DISPATCH_NOT_INSTALLED'),capability);
    await assert.rejects(executeCapability(capability,input,policy,{
      privilegeMode:'direct',accessMode:'full',privilegedBroker,
    }),matchCode('CORE_DISPATCH_BROKER_REQUIRED'),capability);
  }
  assert.equal(callbackCalls,0,'No native or forwarded mutation callback may run');
});

test('invalid, expired, revoked, UNKNOWN or stale-HIGH applicant never reaches callback while disabled',async()=>{
  // The immutable disable bit is checked BEFORE calling fence.execute.
  // The independent #01 suite tests genuine signed CAS permit/commit,
  // revocation, expiry, lost-ACK and stale HIGH readback when the fence runs.
  let effects=0;
  const malicious={request:{
    requestId:'00000000-0000-4000-8000-000000000001',
    fingerprint:'f'.repeat(64),capability:'windows.registry.set',
    scope:{ownerId:'00000000-0000-4000-8000-000000000002',
      deviceId:'00000000-0000-4000-8000-000000000003',
      deviceEpoch:'00000000-0000-4000-8000-000000000004',
      sessionEpoch:'00000000-0000-4000-8000-000000000005',
      ownerEpoch:1,expectedGeneration:1,requiredPrivilege:'CORE'},
  },fence:{execute:async()=>{effects++;}}};
  for(const outcome of ['EXPIRED','REVOKED','UNKNOWN','LOST_ACK','STALE_HIGH']){
    await assert.rejects(executeCoreWindowsMutation(
      'windows.registry.set',{...machineRegistry,outcome},
      malicious as never,async()=>{effects++;return true}),
      matchCode('CORE_EXECUTOR_DISPATCH_NOT_INSTALLED'),outcome);
  }
  assert.equal(effects,0);
});

test('request fingerprint binds capability and every input field canonically',()=>{
  const first={b:2,a:{z:'ok',y:1}};
  assert.equal(coreWindowsEffectFingerprint('windows.registry.set',first),
    coreWindowsEffectFingerprint('windows.registry.set',
      {a:{y:1,z:'ok'},b:2}));
  assert.notEqual(coreWindowsEffectFingerprint('windows.registry.set',first),
    coreWindowsEffectFingerprint('windows.registry.delete',first));
  assert.notEqual(coreWindowsEffectFingerprint('windows.registry.set',first),
    coreWindowsEffectFingerprint('windows.registry.set',{b:3,a:{z:'ok',y:1}}));
  const cyclic:Record<string,unknown>={};cyclic.self=cyclic;
  assert.throws(()=>coreWindowsEffectFingerprint('windows.registry.set',cyclic));
});


test('#03 Broker/CORE shell and nested task routes cannot reach raw spawn without #07',async()=>{
  for(const capability of [
    'shell.exec','wsl.exec','process.start','process.write',
    'task.graph.run','runbook.run','workspace.checks',
    'workspace.snapshot','workspace.detect',
  ] as const){
    await assert.rejects(
      executeCapability(capability,{command:'do-not-execute'},policy,{
        privilegeMode:'broker',accessMode:'full',
      }),matchCode('OS_TASK_SANDBOX_UNAVAILABLE'),capability);
  }
});

test('#03 CORE candidate cannot spoof direct mode to reach spawn or job subprocess',async()=>{
  for(const capability of ['shell.exec','process.start','task.graph.run',
    'runbook.run','workspace.checks'] as const){
    await assert.rejects(
      executeCapability(capability,{command:'do-not-execute'},policy,{
        privilegeMode:'direct',coreWindowsDispatch:{} as never,
      }),matchCode('OS_TASK_SANDBOX_UNAVAILABLE'),capability);
  }
});

test('#03 each nested Windows/file/process effect has its own blocked boundary',async()=>{
  for(const capability of [
    'files.write','files.patch','files.delete','files.move','files.copy',
    'nexowire.update.apply','process.stop','process.prune',
    'windows.keyboard.type','windows.pointer.click',
    'windows.private_desktop.launch','windows.private_display.profile.set',
    'windows.private_clipboard.write',
  ] as const){
    await assert.rejects(executeCapability(capability,{},policy,{
      privilegeMode:'broker',accessMode:'full',
    }),matchCode('CORE_NATIVE_EFFECT_ADMISSION_REQUIRED'),capability);
  }
});

test('#03 #919 ticket alone never equals #01 signed nonce + monotonic CAS claim',async()=>{
  const {assertNoSyntheticBrokerAdmission}=
    await import('../src/agent/core-windows-mutation-dispatch.js');
  assert.throws(()=>assertNoSyntheticBrokerAdmission({
    state:'COMMITTED',ticket:'fixture-ticket',operationId:
      '00000000-0000-4000-8000-000000000011',
  }),matchCode('CORE_BROKER_NATIVE_EFFECT_PROVIDER_UNAVAILABLE'));
});

test('#03 missing native sandbox and CORE dispatch flag stay hard-disabled',async()=>{
  const {CORE_SANDBOX_REQUIRED_CAPABILITIES,
    CORE_OTHER_UNADMITTED_EFFECT_CAPABILITIES,
    assertCoreSandboxRouteUnavailable}=
    await import('../src/agent/core-windows-mutation-dispatch.js');
  assert.equal(CORE_EXECUTOR_DISPATCH_ENABLED,false);
  assert.ok(CORE_SANDBOX_REQUIRED_CAPABILITIES.has('task.graph.run'));
  assert.ok(CORE_OTHER_UNADMITTED_EFFECT_CAPABILITIES.has('files.write'));
  // The untagged, non-CORE legacy execution path remains separate.
  assert.doesNotThrow(()=>assertCoreSandboxRouteUnavailable('shell.exec',false));
});


test('#03 CORE HKCU and user environment writes never fall into standard path',async()=>{
  const scenarios:[string,unknown][]=[
    ['windows.registry.set',{hive:'HKCU',path:'Software\\Test',
      name:'Test',type:'string',value:'x'}],
    ['windows.registry.delete',{hive:'HKCU',path:'Software\\Test',name:'Test'}],
    ['windows.environment.set',{scope:'user',name:'TEST',value:'x'}],
    ['windows.environment.delete',{scope:'process',name:'TEST'}],
  ];
  for(const [capability,input] of scenarios){
    await assert.rejects(executeCapability(capability as never,input,policy,{
      privilegeMode:'broker',accessMode:'full',
    }),matchCode('CORE_NATIVE_EFFECT_ADMISSION_REQUIRED'),capability);
  }
});


test('#03 pre-CAS snapshot is detached, deep-frozen and exactly matches Broker wire hash',async()=>{
  const {createHash}=await import('node:crypto');
  const {prepareCoreWindowsMutation,assertCoreApprovedDispatchRequest}=
    await import('../src/agent/core-windows-mutation-dispatch.js');
  const capability='windows.registry.set';
  const mutable={hive:'HKLM',path:'SOFTWARE\\Nexowire',
    name:'P0',type:'string',value:'before',
    nested:{second:{flag:true},first:[{step:'original'}]}};
  const snapshot=prepareCoreWindowsMutation(capability,mutable);
  assert.notStrictEqual(snapshot.input,mutable);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.input));
  const captured=snapshot.input as typeof mutable;
  assert.ok(Object.isFrozen(captured.nested));
  assert.ok(Object.isFrozen(captured.nested.first));
  assert.ok(Object.isFrozen(captured.nested.first[0]));
  const expectedBody=JSON.stringify({capability,input:snapshot.input});
  assert.equal(snapshot.brokerBody,expectedBody);
  assert.equal(snapshot.fingerprint,
    createHash('sha256').update(expectedBody).digest('hex'));

  // The attacker changes original input after the snapshot, while a remote
  // CAS begin/commit, native HIGH readback or network response is pending.
  await Promise.resolve();
  mutable.value='changed-after-CAS';
  mutable.nested.first[0].step='rotated';
  mutable.nested.second.flag=false;
  mutable.nested.first.push({step:'extra'});
  assert.equal(captured.value,'before');
  assert.equal(captured.nested.first[0].step,'original');
  assert.equal(captured.nested.first.length,1);
  assert.equal(captured.nested.second.flag,true);
  assert.equal(JSON.stringify({capability,input:snapshot.input}),expectedBody);
  assert.notEqual(snapshot.fingerprint,
    createHash('sha256').update(
      JSON.stringify({capability,input:mutable})).digest('hex'));

  const scope=Object.freeze({
    ownerId:'00000000-0000-4000-8000-000000000001',
    deviceId:'00000000-0000-4000-8000-000000000002',
    deviceEpoch:'00000000-0000-4000-8000-000000000003',
    sessionEpoch:'00000000-0000-4000-8000-000000000004',
    ownerEpoch:4,expectedGeneration:7,requiredPrivilege:'CORE' as const,
  });
  const expected=Object.freeze({
    requestId:'00000000-0000-4000-8000-000000000005',
    capability,fingerprint:snapshot.fingerprint,scope,
  });
  const approved=Object.freeze({...expected,scope:Object.freeze({...scope})});
  assert.doesNotThrow(()=>assertCoreApprovedDispatchRequest(
    approved,expected,snapshot));
  // #947 must provide a frozen approved request and matching nested scope.
  assert.throws(()=>assertCoreApprovedDispatchRequest(
    undefined,expected,snapshot),
    matchCode('CORE_DISPATCH_APPROVED_REQUEST_MISMATCH'));
  assert.throws(()=>assertCoreApprovedDispatchRequest(
    {...approved},expected,snapshot),
    matchCode('CORE_DISPATCH_APPROVED_REQUEST_MISMATCH'));
  assert.throws(()=>assertCoreApprovedDispatchRequest(
    Object.freeze({...approved,scope:{...scope}}),expected,snapshot),
    matchCode('CORE_DISPATCH_APPROVED_REQUEST_MISMATCH'));
  assert.throws(()=>assertCoreApprovedDispatchRequest(
    Object.freeze({...approved,requestId:
      '00000000-0000-4000-8000-000000000006'}),expected,snapshot),
    matchCode('CORE_DISPATCH_APPROVED_REQUEST_MISMATCH'));
  assert.throws(()=>assertCoreApprovedDispatchRequest(
    Object.freeze({...approved,scope:Object.freeze({...scope,
      sessionEpoch:'00000000-0000-4000-8000-000000000007'})}),
    expected,snapshot),matchCode('CORE_DISPATCH_APPROVED_REQUEST_MISMATCH'));
  assert.throws(()=>assertCoreApprovedDispatchRequest(
    Object.freeze({...approved,fingerprint:'b'.repeat(64)}),
    expected,snapshot),matchCode('CORE_DISPATCH_APPROVED_REQUEST_MISMATCH'));
});

test('#03 hostile getters, sparse arrays, non-JSON values and cycles cannot be admitted',async()=>{
  const {prepareCoreWindowsMutation}=await import(
    '../src/agent/core-windows-mutation-dispatch.js');
  let access=0;
  const withGetter:Record<string,unknown>={hive:'HKLM'};
  Object.defineProperty(withGetter,'value',{enumerable:true,
    get(){access++;return 'MUTATED';}});
  assert.throws(()=>prepareCoreWindowsMutation('windows.registry.set',withGetter),
    matchCode('CORE_DISPATCH_INPUT_NOT_CANONICAL'));
  assert.equal(access,0,'do not invoke getters during input admission');
  const sparse=Array(2);sparse[0]='only-one';
  for(const bad of [sparse,{value:undefined},{value:Infinity},
    {value:BigInt(2)},{value:new Date()},()=>42]){
    assert.throws(()=>prepareCoreWindowsMutation(
      'windows.registry.set',bad),
      matchCode('CORE_DISPATCH_INPUT_NOT_CANONICAL'));
  }
  const loop:Record<string,unknown>={};loop.child=loop;
  assert.throws(()=>prepareCoreWindowsMutation('windows.registry.set',loop),
    matchCode('CORE_DISPATCH_INPUT_NOT_CANONICAL'));
});

test('#03 frozen snapshot cannot be modified through approved callback references',async()=>{
  const {prepareCoreWindowsMutation}=await import(
    '../src/agent/core-windows-mutation-dispatch.js');
  const raw={hive:'HKLM',path:'SOFTWARE\\Nexowire',
    nested:[{name:'original'}]};
  const accepted=prepareCoreWindowsMutation('windows.registry.set',raw);
  const sent=accepted.input as typeof raw;
  assert.throws(()=>{sent.nested[0].name='forged'},TypeError);
  assert.throws(()=>{sent.nested.push({name:'forged'})},TypeError);
  assert.equal(sent.nested[0].name,'original');
  assert.equal(JSON.stringify({capability:accepted.capability,input:sent}),
    accepted.brokerBody);
  assert.equal(CORE_EXECUTOR_DISPATCH_ENABLED,false);
});
