import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validateWindowsOwnerLauncherPins,windowsOwnerLauncherArguments,createWindowsProtectedOwnerAssertionLauncher,
  parseNativeOwnerObservation,matchNativeOwnerObservation,readStableProvisionedWindowsOwner}
  from '../../src/security/windows-protected-owner-issuer.js';

const pins={launcherPath:'C:\\ProgramData\\Nexowire\\CoreOwner\\windows-core-owner-launcher.exe',
  launcherSha256:'a'.repeat(64),launcherSignerSha256:'b'.repeat(64),
  helperSha256:'c'.repeat(64),helperSignerSha256:'d'.repeat(64)};
const owner={issuerSpkiSha256:'e'.repeat(64),rpId:'core.fixture.invalid',credentialId:'AA',
  binding:{version:1 as const,ownerAccountId:'owner-fixture-0001',deviceId:'device-fixture-0001',
    installationId:randomUUID(),enrollmentId:randomUUID(),ownerEpoch:1,grantGeneration:1,revokeEpoch:0,
    windowsUserSid:'S-1-5-21-101-202-303-1001',windowsSessionId:2,windowsLogonLuid:'000000000000a101',
    windowsLogonSessionEpoch:randomUUID()}};
const input={helper:'windows-core-webauthn-approval.exe' as const,owner,
  args:['--assert-bound',owner.rpId,'f'.repeat(64),'00',owner.binding.windowsUserSid,'2',owner.binding.windowsLogonLuid]};
test('native owner launcher accepts only fixed protected artifact and bound ceremony parameters',()=>{
  assert.ok(Object.isFrozen(validateWindowsOwnerLauncherPins(pins)));
  const a=windowsOwnerLauncherArguments(input,pins);
  assert.deepEqual(a,['--ceremony',...input.args.slice(1),pins.helperSha256,pins.helperSignerSha256]);
  assert.ok(Object.isFrozen(a));
  for(const launcherPath of ['C:\\Users\\owner\\windows-core-owner-launcher.exe',
    'C:\\ProgramData\\Nexowire\\..\\windows-core-owner-launcher.exe',
    'C:\\ProgramData\\Nexowire\\windows-core-owner-launcher.exe:alternate',
    'C:\\ProgramData\\Nexowire\\cmd.exe']){
    assert.throws(()=>validateWindowsOwnerLauncherPins({...pins,launcherPath}),/PROTECTED_PINS_REQUIRED/);
  }
  assert.throws(()=>validateWindowsOwnerLauncherPins({...pins,helperSignerSha256:'invalid'}),/PROTECTED_PINS_REQUIRED/);
  for(const index of [0,1,2,3,4,5,6]){
    const args=[...input.args];args[index]='unexpected';
    assert.throws(()=>windowsOwnerLauncherArguments({...input,args},pins),/CEREMONY_SCOPE_INVALID/);
  }
});
test('non-Windows cannot manufacture a protected owner launcher',async()=>{
  if(process.platform!=='win32')await assert.rejects(createWindowsProtectedOwnerAssertionLauncher(pins),/WINDOWS_REQUIRED/);
});

test('independent WTS observation is nonce-bound and cannot claim human approval or authority',()=>{
  const nonce='f'.repeat(64),raw={version:1,kind:'core_owner_wts_observation_v1',nonce,
    windowsUserSid:owner.binding.windowsUserSid,windowsSessionId:owner.binding.windowsSessionId,
    windowsLogonLuid:owner.binding.windowsLogonLuid,humanApproval:false,coreAuthority:false};
  const p=parseNativeOwnerObservation(raw,nonce);
  assert.ok(Object.isFrozen(p));assert.equal(matchNativeOwnerObservation(p,owner.binding),true);
  assert.equal(matchNativeOwnerObservation(p,{...owner.binding,windowsSessionId:3}),false);
  assert.equal(matchNativeOwnerObservation(p,{...owner.binding,windowsLogonLuid:'000000000000b101'}),false);
  for(const bad of [{...raw,humanApproval:true},{...raw,coreAuthority:true},{...raw,windowsSessionId:0},
    {...raw,nonce:'e'.repeat(64)},{...raw,windowsLogonLuid:'0'.repeat(16)}])
    assert.throws(()=>parseNativeOwnerObservation(bad,nonce));
});

test('provisioned owner readback brackets the actual observation with two independent directory reads',async()=>{
  const nonce='f'.repeat(64),observation=parseNativeOwnerObservation({
    version:1,kind:'core_owner_wts_observation_v1',nonce,
    windowsUserSid:owner.binding.windowsUserSid,windowsSessionId:owner.binding.windowsSessionId,
    windowsLogonLuid:owner.binding.windowsLogonLuid,humanApproval:false,coreAuthority:false,
  },nonce);
  const calls:string[]=[];
  const result=await readStableProvisionedWindowsOwner(async()=>{
    calls.push('directory');return structuredClone(owner);
  },async()=>{calls.push('WTS');return observation;},new AbortController().signal);
  assert.deepEqual(calls,['directory','WTS','directory']);
  assert.deepEqual(result,owner);
  assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.binding));
  for(const changed of [
    {...owner,issuerSpkiSha256:'0'.repeat(64)},
    {...owner,rpId:'changed.fixture.invalid'},
    {...owner,credentialId:'AQ'},
    ...[
      {ownerAccountId:'owner-fixture-0002'},{deviceId:'device-fixture-0002'},
      {installationId:randomUUID()},{enrollmentId:randomUUID()},
      {ownerEpoch:2},{grantGeneration:2},{revokeEpoch:1},
      {windowsUserSid:'S-1-5-21-101-202-303-1002'},
      {windowsSessionId:3},{windowsLogonLuid:'000000000000b101'},
      {windowsLogonSessionEpoch:randomUUID()}
    ].map(binding=>({...owner,binding:{...owner.binding,...binding}}))
  ]){
    let reads=0;
    await assert.rejects(readStableProvisionedWindowsOwner(async()=>++reads===1?owner:changed,
      async()=>observation,new AbortController().signal),/CORE_OWNER_LAUNCHER_OWNER_READBACK_MISMATCH/);
    assert.equal(reads,2);
  }
  await assert.rejects(readStableProvisionedWindowsOwner(async()=>owner,
    async()=>({...observation,windowsSessionId:3}),new AbortController().signal),
    /CORE_OWNER_LAUNCHER_OWNER_READBACK_MISMATCH/);
  await assert.rejects(readStableProvisionedWindowsOwner(async()=>({...owner,credentialId:'AB'}),
    async()=>observation,new AbortController().signal),
    /CORE_OWNER_LAUNCHER_OWNER_READBACK_MISMATCH/);
});
test('owner directory readback never publishes a binding after cancellation or directory failure',async()=>{
  const controller=new AbortController(),nonce='f'.repeat(64);
  const observation=parseNativeOwnerObservation({
    version:1,kind:'core_owner_wts_observation_v1',nonce,
    windowsUserSid:owner.binding.windowsUserSid,windowsSessionId:owner.binding.windowsSessionId,
    windowsLogonLuid:owner.binding.windowsLogonLuid,humanApproval:false,coreAuthority:false,
  },nonce);
  let reads=0;
  await assert.rejects(readStableProvisionedWindowsOwner(async()=>{
    reads++;return owner;
  },async()=>{controller.abort();return observation;},controller.signal),{name:'AbortError'});
  assert.equal(reads,1);
  reads=0;
  await assert.rejects(readStableProvisionedWindowsOwner(async()=>{
    if(++reads===2)throw Error('directory unavailable');
    return owner;
  },async()=>observation,new AbortController().signal),/directory unavailable/);
  assert.equal(reads,2);
});
