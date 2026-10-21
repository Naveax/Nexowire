import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCoreBrokerFilesystemPreflight,
  BrokerFilesystemPreflightError,
  type BrokerFilesystemIdentity,
  type BrokerFilesystemIntent,
  type BrokerFilesystemTrust,
} from '../src/agent/broker-filesystem-preflight.js';
import { isPrivilegedBrokerCapability, privilegeRequirement } from '../src/security/privilege.js';
import {syntheticProtectedBoundary} from './p05-native-boundary-fixtures.js';

const proof = (overrides: Partial<BrokerFilesystemIdentity> = {}): BrokerFilesystemIdentity => ({
  sid: 'S-1-5-21-100-200-300-500',
  ownerId: 'trusted-owner',
  deviceId: 'trusted-device',
  integrity: 'high',
  authenticated: true,
  ...overrides,
});
const intent: BrokerFilesystemIntent = {
  source: 'C:\\ProgramData\\Nexowire\\privileged-broker\\file-helper.exe',
  destination: 'C:\\Protected\\owner\\stage.tmp',
  scope:'write',
};
const trust = (overrides:Partial<BrokerFilesystemTrust>={}):BrokerFilesystemTrust=>({
  inspectNativeFilesystemBoundary:async()=>syntheticProtectedBoundary(),
  brokerToken:async()=>proof(),
  callerToken:async()=>proof(),
  destinationOwner:async()=>({ownerId:'trusted-owner',deviceId:'trusted-device'}),
  attestProtectedSource:async()=>true,
  authorizeDestination:async()=>true,
  ...overrides,
});
const denied=(code:string)=>(e:unknown)=>e instanceof BrokerFilesystemPreflightError && e.code===code;

test('production Broker keeps privileged file capabilities explicitly unsupported',()=>{
  for(const capability of [
    'files.read','files.write','files.copy','files.move','files.hash',
    'files.delete','files.patch','files.grant.request',
    'shell.exec','wsl.exec',
  ]){
    assert.equal(isPrivilegedBrokerCapability(capability),false,capability);
    assert.equal(privilegeRequirement(capability,{}),'standard',capability);
  }
});

test('source-only synthetic protected high-integrity owner/device witness permits policy preflight, never execution',async()=>{
  let calls=0;
  const result=await assertCoreBrokerFilesystemPreflight(intent,trust({
    attestProtectedSource:async()=>{calls++;return true;},
    authorizeDestination:async()=>{calls++;return true;},
  }));
  assert.deepEqual(result,{validated:true,ownerId:'trusted-owner',deviceId:'trusted-device'});
  assert.equal(calls,2);
});

test('medium/low/unknown caller cannot borrow HIGH Broker file privileges',async()=>{
  for(const integrity of ['medium','low','unknown'] as const){
    let called=false;
    await assert.rejects(()=>assertCoreBrokerFilesystemPreflight(intent,trust({
      callerToken:async()=>proof({integrity}),
      authorizeDestination:async()=>{called=true;return true;},
    })),denied('BROKER_FILE_MEDIUM_CALLER_DENIED'));
    assert.equal(called,false);
  }
  // Input-supplied trust hints have no effect: they are not read from the request.
  await assert.rejects(()=>assertCoreBrokerFilesystemPreflight({
    ...intent,ownerId:'trusted-owner',integrity:'high',trusted:true,
  } as BrokerFilesystemIntent,trust({
    callerToken:async()=>proof({integrity:'medium'}),
  })),denied('BROKER_FILE_MEDIUM_CALLER_DENIED'));
});

test('HIGH Broker without trusted protected code signature/ACL does not grant file access',async()=>{
  for(const broker of [
    proof({integrity:'medium'}),proof({integrity:'unknown'}),
    proof({sid:'not-a-windows-sid'}),proof({authenticated:false}),
  ]){
    await assert.rejects(()=>assertCoreBrokerFilesystemPreflight(intent,trust({
      brokerToken:async()=>broker,
    })),denied('BROKER_FILE_HIGH_TOKEN_NOT_VERIFIED'));
  }
  await assert.rejects(()=>assertCoreBrokerFilesystemPreflight(intent,trust({
    brokerToken:async()=>null,
  })),denied('BROKER_FILE_HIGH_TOKEN_NOT_VERIFIED'));
  await assert.rejects(()=>assertCoreBrokerFilesystemPreflight(intent,trust({
    attestProtectedSource:async()=>false,
  })),denied('BROKER_FILE_SOURCE_ATTESTATION_FAILED'));
});

test('cross-owner or cross-device file destinations are denied before any mutation',async()=>{
  for(const variant of [
    {callerToken:async()=>proof({ownerId:'other-owner'})},
    {callerToken:async()=>proof({deviceId:'other-device'})},
    {brokerToken:async()=>proof({ownerId:'other-owner'})},
    {destinationOwner:async()=>({ownerId:'other-owner',deviceId:'trusted-device'})},
    {destinationOwner:async()=>({ownerId:'trusted-owner',deviceId:'other-device'})},
    {destinationOwner:async()=>null},
  ]){
    let reached=false;
    await assert.rejects(()=>assertCoreBrokerFilesystemPreflight(intent,trust({
      ...variant,authorizeDestination:async()=>{reached=true;return true;},
    })),denied('BROKER_FILE_OWNER_DEVICE_MISMATCH'));
    assert.equal(reached,false);
  }
});

test('medium caller-selected source paths, unprotected runtime, UNC, ADS and path traversal are denied',async()=>{
  const unsafe=[
    'C:\\Users\\owner\\AppData\\Local\\Temp\\file-helper.exe',
    'C:\\ProgramData\\Nexowire\\privileged-broker-other\\helper.exe',
    'C:\\ProgramData\\Nexowire\\privileged-broker\\..\\owner\\helper.exe',
    'C:\\ProgramData\\Nexowire\\privileged-broker\\helper.exe:evil',
    '\\\\attacker\\share\\file-helper.exe',
    '\\\\?\\C:\\ProgramData\\Nexowire\\privileged-broker\\helper.exe',
    'helper.exe',
    'D:\\ProgramData\\Nexowire\\privileged-broker\\helper.exe',
  ];
  for(const source of unsafe){
    let attested=false;
    await assert.rejects(()=>assertCoreBrokerFilesystemPreflight({
      ...intent,source,
    },trust({attestProtectedSource:async()=>{attested=true;return true;}})),
    denied('BROKER_FILE_SOURCE_NOT_PROTECTED'),source);
    assert.equal(attested,false,source);
  }
});

test('local owner can deny, revoke or remap destination while approval is pending',async()=>{
  let allowed=true;
  const scenario=trust({
    attestProtectedSource:async()=>{
      allowed=false; // simulate revocation while awaiting source attestation
      return true;
    },
    authorizeDestination:async()=>allowed,
  });
  await assert.rejects(()=>assertCoreBrokerFilesystemPreflight(
    intent,scenario,
  ),denied('BROKER_FILE_DESTINATION_GRANT_DENIED'));
  await assert.rejects(()=>assertCoreBrokerFilesystemPreflight(
    intent,trust({authorizeDestination:async()=>false}),
  ),denied('BROKER_FILE_DESTINATION_GRANT_DENIED'));
});

test('invalid intent or unverified witness fails closed with zero execution side effects',async()=>{
  let accepted=false;
  for(const input of [
    {...intent,scope:'usb_format'},null,{...intent,source:42},
  ]){
    await assert.rejects(()=>assertCoreBrokerFilesystemPreflight(
      input as BrokerFilesystemIntent,
      trust({authorizeDestination:async()=>{accepted=true;return true;}}),
    ),denied('BROKER_FILE_INVALID_INTENT'));
    assert.equal(accepted,false);
  }
  await assert.rejects(()=>assertCoreBrokerFilesystemPreflight(intent,trust({
    attestProtectedSource:async()=>{throw new Error('ACL source unavailable');},
  })),/ACL source unavailable/);
});
