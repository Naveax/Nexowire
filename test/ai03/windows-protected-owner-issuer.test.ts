import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validateWindowsOwnerLauncherPins,windowsOwnerLauncherArguments,createWindowsProtectedOwnerAssertionLauncher,
  parseNativeOwnerObservation,matchNativeOwnerObservation}
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
