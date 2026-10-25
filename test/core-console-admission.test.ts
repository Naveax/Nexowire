import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {CoreConsoleAdmission,type CoreConsoleEvidence,
  type CoreConsoleNativeProvider} from '../src/agent/core-console-admission.js';
import {canonicalCoreConsoleEnrollment} from '../src/agent/core-console-enrollment-policy.js';
import {executeCapability} from '../src/agent/executors.js';
import {PathPolicy} from '../src/agent/path-policy.js';
import {executeWindowsConsoleControlCapability,revokePhysicalConsoleGrant}
  from '../src/agent/windows-console-grant.js';

// Synthetic protected-provider fixture. These tests exercise real Agent routing
// and cryptographic policy, NOT an installed Windows provider or physical input.
const {publicKey,privateKey}=generateKeyPairSync('ed25519');
const der=publicKey.export({format:'der',type:'spki'});
const binding={ownerAccountId:'owner-account-0001',deviceId:'device-test-0001',
  installationId:'installation-0001'};
const now=1_800_000_000_000;
const enrollment={version:1 as const,scope:'physical-console' as const,...binding,
  enrollmentId:'enrollment-test-0001',ownerEpoch:8,grantGeneration:4,revokeEpoch:2,
  approvedLocallyAtMs:1_700_000_000_000,
  issuerSpkiSha256:createHash('sha256').update(der).digest('hex')};
function evidence(): CoreConsoleEvidence {
  return {certificate:{enrollment,signatureBase64:
    sign(null,canonicalCoreConsoleEnrollment(enrollment),privateKey).toString('base64')},
    pinnedLocalSpkiDer:der,current:{...binding,ownerEpoch:8,grantGeneration:4,
      revokeEpoch:2,coreEnabled:true,accessMode:'full',deviceOnline:true,bridgeVerified:true},
    desktop:'default',observedAtMs:now,nativeAdmission:'verified'};
}
function fixture(patch: Partial<CoreConsoleNativeProvider> = {}) {
  let calls=0;
  let state=evidence();
  const provider:CoreConsoleNativeProvider={
    inspect:async()=>state,
    execute:async request=>{
      ++calls;
      return {requestId:request.requestId,fingerprint:request.fingerprint,
        outcome:'succeeded',data:{data:{syntheticNativeEffect:true}}};
    },
    revoke:async()=>{},...patch,
  };
  return {controller:new CoreConsoleAdmission(binding,provider,()=>now),provider,
    calls:()=>calls,set:(next:CoreConsoleEvidence)=>{state=next;}};
}
function code(expected:string) {
  return (error:unknown)=>typeof error==='object' && error!==null &&
    'code' in error && error.code===expected;
}

test('production default cannot manufacture native authority from FULL or request fields',async()=>{
  revokePhysicalConsoleGrant();
  const controller=new CoreConsoleAdmission();
  assert.equal((await controller.status('full')).active,false);
  await assert.rejects(executeCapability('windows.pointer.click',{
    approved:true,coreEnabled:true,nativeAdmission:'verified',
  },new PathPolicy(['*']),{accessMode:'full',requestId:randomUUID(),coreConsole:controller}),
  code('CORE_CONSOLE_PROVIDER_UNAVAILABLE'));
  const result=await executeWindowsConsoleControlCapability(
    'windows.console_control.status',{},'full',controller);
  const status=result.data as {active:boolean;core:{active:boolean;state:string}};
  assert.equal(status.active,false);
  assert.equal(status.core.active,false);
  assert.equal(status.core.state,'CORE_CONSOLE_PROVIDER_UNAVAILABLE');
});

test('real executeCapability routes valid CORE input to the provider, not legacy GUI dispatch',async()=>{
  revokePhysicalConsoleGrant();
  const f=fixture();
  const result=await executeCapability('windows.pointer.click',{hwnd:'1',x:0,y:0},
    new PathPolicy(['*']),{accessMode:'full',requestId:randomUUID(),coreConsole:f.controller});
  assert.deepEqual(result,{data:{syntheticNativeEffect:true}});
  assert.equal(f.calls(),1);
  const status=await f.controller.status('full');
  assert.equal(status.active,true);
  assert.equal(status.expiresAt,null);
  assert.equal(status.duration,'indefinite-revocable');
  const response=await executeWindowsConsoleControlCapability(
    'windows.console_control.status',{},'full',f.controller);
  const combined=response.data as {active:boolean;mode:string;remainingMs:number|null};
  assert.equal(combined.active,true);
  assert.equal(combined.mode,'core');
  assert.equal(combined.remainingMs,null);
});

test('outdated elevated Broker does not mislabel an enabled CORE preference as needing another consent',async()=>{
  const f=fixture();
  const base=evidence();
  f.set({...base,certificate:null,nativeAdmission:'unavailable',brokerVersionVerified:false});
  const blocked=await f.controller.status('full');
  assert.equal(blocked.preferenceEnabled,true);
  assert.equal(blocked.active,false);
  assert.equal(blocked.localEnrolled,false);
  assert.equal(blocked.state,'CORE_BROKER_VERIFICATION_REQUIRED');
  f.set({...base,certificate:null,nativeAdmission:'unavailable',brokerVersionVerified:true});
  assert.equal((await f.controller.status('full')).state,'LOCAL_ENROLLMENT_REQUIRED');
  f.set({...base,certificate:null,nativeAdmission:'unavailable',brokerVersionVerified:false,
    current:{...base.current!,coreEnabled:false}});
  assert.equal((await f.controller.status('full')).state,'CORE_NOT_EFFECTIVE');
});

test('indefinite CORE takes precedence even when a 60-minute local grant is also active',
  {skip:process.platform!=='win32'},async()=>{
    const controller=fixture().controller;
    const {requestPhysicalConsoleGrant} = await import('../src/agent/windows-console-grant.js');
    revokePhysicalConsoleGrant();
    try {
      const temporary=await requestPhysicalConsoleGrant({duration_minutes:60},
        {decisionProvider:async()=>true,timeoutMs:1000});
      assert.equal(temporary.approved,true);
      assert.equal(temporary.status.active,true);
      const result=await executeWindowsConsoleControlCapability(
        'windows.console_control.status',{},'full',controller);
      const data=result.data as {active:boolean;mode:string;remainingMs:number|null;
        core:{active:boolean;expiresAt:null}};
      assert.equal(data.active,true);
      assert.equal(data.core.active,true);
      assert.equal(data.mode,'core');
      assert.equal(data.remainingMs,null);
      assert.equal(data.core.expiresAt,null);
    } finally { revokePhysicalConsoleGrant(); }
  });

test('SAFE never borrows CORE and non-console capabilities cannot use this provider',async()=>{
  const f=fixture();
  await assert.rejects(f.controller.execute('windows.pointer.click',{},randomUUID(),'safe'),
    code('SAFE_MODE'));
  await assert.rejects(f.controller.execute('shell.exec',{},randomUUID(),'full'),
    code('CORE_CONSOLE_SCOPE_DENIED'));
  assert.equal(f.calls(),0);
});

test('CORE OFF, owner/device/install/epoch/revoke/key/desktop/bridge loss deny before native dispatch',async()=>{
  const original=evidence();
  const patches: Partial<CoreConsoleEvidence>[]=[
    {current:{...original.current!,coreEnabled:false}},
    {current:{...original.current!,ownerAccountId:'another-owner-0001'}},
    {current:{...original.current!,deviceId:'another-device-0001'}},
    {current:{...original.current!,installationId:'another-install-0001'}},
    ...['ownerEpoch','grantGeneration','revokeEpoch'].map(field=>
      ({current:{...original.current!,[field]:99}})),
    {current:{...original.current!,bridgeVerified:false}},
    {current:{...original.current!,deviceOnline:false}},
    {current:null},{pinnedLocalSpkiDer:null},{certificate:null},
    {nativeAdmission:'unavailable'},
    ...(['secure','locked','private','unknown'] as const).map(desktop=>({desktop})),
    {observedAtMs:now-2001},{observedAtMs:now+1},{observedAtMs:Number.NaN},
    {certificate:{...original.certificate!,signatureBase64:'A'.repeat(88)}},
    {certificate:{...original.certificate!,enrollment:{...enrollment,enrollmentId:'tampered-0001'}}},
  ];
  for(const patch of patches){
    const f=fixture(); f.set({...evidence(),...patch});
    assert.equal((await f.controller.status('full')).active,false,JSON.stringify(patch));
    await assert.rejects(f.controller.execute('windows.pointer.click',{},randomUUID(),'full'));
    assert.equal(f.calls(),0,JSON.stringify(patch));
  }
});

test('no positive authority cache: CORE OFF immediately denies the next dispatch',async()=>{
  const f=fixture();
  await f.controller.execute('windows.pointer.click',{},randomUUID(),'full');
  f.set({...evidence(),current:{...evidence().current!,coreEnabled:false}});
  await assert.rejects(f.controller.execute('windows.pointer.click',{},randomUUID(),'full'),
    code('CORE_NOT_EFFECTIVE'));
  assert.equal(f.calls(),1);
});

test('parallel duplicate IDs, replay, lost ACK and invalid native receipts never replay input',async()=>{
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let dispatched=0;
  const f=fixture({execute:async()=>{++dispatched;await gate;throw new Error('ACK lost');}});
  const id=randomUUID();
  const first=f.controller.execute('windows.pointer.click',{},id,'full');
  await assert.rejects(f.controller.execute('windows.pointer.click',{},id,'full'),
    code('CORE_CONSOLE_REPLAY_DENIED'));
  release();
  await assert.rejects(first,code('CORE_CONSOLE_MUTATION_STATE_UNKNOWN'));
  await assert.rejects(f.controller.execute('windows.pointer.click',{},id,'full'),
    code('CORE_CONSOLE_REPLAY_DENIED'));
  assert.equal(dispatched,1);
  const bad=fixture({execute:async request=>({requestId:randomUUID(),
    fingerprint:request.fingerprint,outcome:'succeeded'})});
  await assert.rejects(bad.controller.execute('windows.pointer.click',{},randomUUID(),'full'),
    code('CORE_CONSOLE_MUTATION_STATE_UNKNOWN'));
});

test('STOP interrupts pending authority, latches locally, and cannot be undone by a new remote ID',async()=>{
  let release!:(value:CoreConsoleEvidence)=>void;
  const gate=new Promise<CoreConsoleEvidence>(resolve=>{release=resolve;});
  const f=fixture({inspect:async()=>gate});
  const first=f.controller.execute('windows.pointer.click',{},randomUUID(),'full');
  await f.controller.revoke();
  release(evidence());
  await assert.rejects(first,code('REVOKED_LOCALLY'));
  assert.equal((await f.controller.status('full')).state,'REVOKED_LOCALLY');
  await assert.rejects(f.controller.execute('windows.pointer.click',{},randomUUID(),'full'),
    code('REVOKED_LOCALLY'));
  assert.equal(f.calls(),0);
});

test('unconfirmed persistent revocation never reports a successful revoke ACK',async()=>{
  const f=fixture({revoke:async()=>{throw new Error('durable tombstone unavailable');}});
  await assert.rejects(executeWindowsConsoleControlCapability(
    'windows.console_control.revoke',{},'full',f.controller));
  assert.equal((await f.controller.status('full')).state,'REVOKED_LOCALLY');
});

test('disconnect aborts pending CORE authority without dispatch or an automatic retry',async()=>{
  const f=fixture({inspect:async()=>new Promise(()=>{})});
  const connection=new AbortController();
  const id=randomUUID();
  const pending=f.controller.execute('windows.pointer.click',{},id,'full',connection.signal);
  connection.abort();
  await assert.rejects(pending,code('CORE_CONSOLE_REQUEST_CANCELLED'));
  assert.equal(f.calls(),0);
  await assert.rejects(f.controller.execute('windows.pointer.click',{},id,'full'),
    code('CORE_CONSOLE_REPLAY_DENIED'));
});

test('controller recreation revalidates provider evidence rather than persisting ACTIVE in JSON',async()=>{
  const f=fixture();
  assert.equal((await f.controller.status('full')).active,true);
  f.set({...evidence(),current:{...evidence().current!,revokeEpoch:3}});
  const restarted=new CoreConsoleAdmission(binding,f.provider,()=>now);
  assert.equal((await restarted.status('full')).active,false);
  assert.equal((await new CoreConsoleAdmission().status('full')).active,false);
});

test('policy rejects truthy non-booleans and noncanonical signature encodings from providers',async()=>{
  const original=evidence();
  for(const field of ['coreEnabled','deviceOnline','bridgeVerified']){
    const f=fixture();
    f.set({...original,current:{...original.current!,[field]:'true'} as unknown as
      NonNullable<CoreConsoleEvidence['current']>});
    assert.equal((await f.controller.status('full')).active,false);
  }
  const f=fixture();
  f.set({...original,certificate:{...original.certificate!,
    signatureBase64:original.certificate!.signatureBase64+'\n'}});
  assert.equal((await f.controller.status('full')).active,false);
});
