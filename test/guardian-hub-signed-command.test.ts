import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {
  hubCommandPublicKeyId,signGuardianHubCommand,
  verifyAndReserveGuardianHubCommand,
  type GuardianHubCommandBody,
  type GuardianHubCommandContext,
} from '../src/protocol/guardian-hub-signed-command.js';

const hub=generateKeyPairSync('ed25519');
const otherHub=generateKeyPairSync('ed25519');
const revision='owner-audit-43';
const guardianKeyId='b'.repeat(64);
const requestId='11111111-1111-4111-8111-111111111111';
const pair='a'.repeat(64);

const body=():GuardianHubCommandBody=>({
  type:'guardian.hub-bridge-command',version:1,
  intent:{
    type:'admin-bridge.mode-intent',version:1,
    requestId,deviceId:'device-1',ownerAccountId:'owner-1',
    credentialBinding:pair,desiredMode:'on',
    issuedAt:'2026-10-10T15:00:00.000Z',
    expiresAt:'2026-10-10T15:02:00.000Z',
  },
  ownerPreferenceRevision:revision,
  guardianKeyId,
  hubSignerKeyId:hubCommandPublicKeyId(hub.publicKey),
});

const ctx=():GuardianHubCommandContext=>({
  deviceId:'device-1',ownerAccountId:'owner-1',
  credentialBinding:pair,currentOwnerPreferenceRevision:revision,
  currentGuardianKeyId:guardianKeyId,
  enrolledHubPublicKey:hub.publicKey,
  now:new Date('2026-10-10T15:01:00.000Z'),
  nowAfterReservation:()=>new Date('2026-10-10T15:01:00.000Z'),
  readTrustAfterReservation:async()=>({
    deviceId:'device-1',ownerAccountId:'owner-1',credentialBinding:pair,
    currentOwnerPreferenceRevision:revision,currentGuardianKeyId:guardianKeyId,
    enrolledHubPublicKey:hub.publicKey,
  }),
  atomicallyReserveRequest:async()=>true,
});

test('pinned Ed25519 Hub command is authenticated, never local task authorization',async()=>{
  const envelope=signGuardianHubCommand(body(),hub.privateKey);
  const verified=await verifyAndReserveGuardianHubCommand(envelope,ctx());
  assert.equal(verified.authenticated,true);
  assert.equal(verified.executionAuthorized,false);
  assert.equal(verified.intent.requestId,requestId);
  assert.equal(verified.preferenceRevision,revision);
  assert.equal(Object.isFrozen(verified),true);
});

test('changed owner, pairing, device, revision or Guardian identity fails before reserve',async()=>{
  const envelope=signGuardianHubCommand(body(),hub.privateKey);
  for(const changed of [
    {...ctx(),ownerAccountId:'other-owner'},
    {...ctx(),deviceId:'other-device'},
    {...ctx(),credentialBinding:'c'.repeat(64)},
    {...ctx(),currentOwnerPreferenceRevision:'new-revision'},
    {...ctx(),currentGuardianKeyId:'c'.repeat(64)},
  ]) {
    let called=false;
    await assert.rejects(verifyAndReserveGuardianHubCommand(envelope,{
      ...changed,atomicallyReserveRequest:async()=>{called=true;return true},
    }));
    assert.equal(called,false);
  }
});

test('wrong Hub signer and tampered signature or mode cannot reserve',async()=>{
  const envelope=signGuardianHubCommand(body(),hub.privateKey);
  const invalid=[
    {...envelope,intent:{...envelope.intent,desiredMode:'off' as const}},
    {...envelope,signature:(envelope.signature.startsWith('A')?'B':'A')+envelope.signature.slice(1)},
    {...envelope,ownerPreferenceRevision:'altered'},
    {...envelope,hubSignerKeyId:'c'.repeat(64)},
    {...envelope,arbitraryShellCommand:'powershell'},
  ];
  for(const item of invalid) {
    let called=false;
    await assert.rejects(verifyAndReserveGuardianHubCommand(item,{
      ...ctx(),atomicallyReserveRequest:async()=>{called=true;return true},
    }));
    assert.equal(called,false);
  }
  const ctxOther={...ctx(),enrolledHubPublicKey:otherHub.publicKey};
  await assert.rejects(
    verifyAndReserveGuardianHubCommand(envelope,ctxOther),
    /GUARDIAN_HUB_COMMAND_SIGNER_UNTRUSTED/,
  );
});

test('expired, future or revoked commands never pass reserve',async()=>{
  const envelope=signGuardianHubCommand(body(),hub.privateKey);
  for(const time of [
    '2026-10-10T15:02:00.000Z','2026-10-10T14:59:54.000Z',
  ]) {
    await assert.rejects(verifyAndReserveGuardianHubCommand(envelope,{
      ...ctx(),now:new Date(time),
    }),/BRIDGE_INTENT_EXPIRED_OR_INVALID/);
  }
  await assert.rejects(
    verifyAndReserveGuardianHubCommand(envelope,{
      ...ctx(),atomicallyReserveRequest:async()=>false,
    }),/GUARDIAN_HUB_COMMAND_REPLAY_OR_REVOKED/,
  );
});

test('Hub command expiry during local reservation consumes it but rejects the outcome',async()=>{
  const envelope=signGuardianHubCommand(body(),hub.privateKey);
  for(const expiredAt of [
    '2026-10-10T15:02:00.000Z',
    '2026-10-10T15:02:01.000Z',
  ]) {
    let reservations=0;
    await assert.rejects(verifyAndReserveGuardianHubCommand(envelope,{
      ...ctx(),
      atomicallyReserveRequest:async()=>{reservations++;return true},
      nowAfterReservation:()=>new Date(expiredAt),
    }),/BRIDGE_INTENT_EXPIRED_OR_INVALID/);
    assert.equal(reservations,1);
  }
});

test('backwards post-reservation clock fails closed after durable request consumption',async()=>{
  const envelope=signGuardianHubCommand(body(),hub.privateKey);
  let reservations=0;
  await assert.rejects(verifyAndReserveGuardianHubCommand(envelope,{
    ...ctx(),
    atomicallyReserveRequest:async()=>{reservations++;return true},
    nowAfterReservation:()=>new Date('2026-10-10T15:00:59.999Z'),
  }),/GUARDIAN_HUB_COMMAND_POST_RESERVATION_CLOCK_UNTRUSTED/);
  assert.equal(reservations,1);
});

test('mutating the initial Date during reservation cannot move the time baseline',async()=>{
  const envelope=signGuardianHubCommand(body(),hub.privateKey);
  const context=ctx();
  let reservations=0;
  await assert.rejects(verifyAndReserveGuardianHubCommand(envelope,{
    ...context,
    atomicallyReserveRequest:async()=>{
      reservations++;
      context.now.setTime(Date.parse('2026-10-10T15:00:00.000Z'));
      return true;
    },
    nowAfterReservation:()=>new Date('2026-10-10T15:00:30.000Z'),
  }),/GUARDIAN_HUB_COMMAND_POST_RESERVATION_CLOCK_UNTRUSTED/);
  assert.equal(reservations,1);
});

test('truthy nonboolean reservation results are never treated as committed',async()=>{
  const envelope=signGuardianHubCommand(body(),hub.privateKey);
  for(const invalid of [1,'true',{},[],null,undefined]){
    let sampled=false;
    await assert.rejects(verifyAndReserveGuardianHubCommand(envelope,{
      ...ctx(),
      atomicallyReserveRequest:async()=>invalid as boolean,
      nowAfterReservation:()=>{sampled=true;return new Date('2026-10-10T15:01:00Z')},
    }),/GUARDIAN_HUB_COMMAND_REPLAY_OR_REVOKED/);
    assert.equal(sampled,false);
  }
});

test('invalid post-reservation clock is rejected after reservation',async()=>{
  const envelope=signGuardianHubCommand(body(),hub.privateKey);
  let reservations=0;
  await assert.rejects(verifyAndReserveGuardianHubCommand(envelope,{
    ...ctx(),atomicallyReserveRequest:async()=>{reservations++;return true},
    nowAfterReservation:()=>new Date('Invalid Date'),
  }),/GUARDIAN_HUB_COMMAND_POST_RESERVATION_CLOCK_UNTRUSTED/);
  assert.equal(reservations,1);
});

test('fresh trust snapshot revocation after durable reservation fails closed',async()=>{
  const envelope=signGuardianHubCommand(body(),hub.privateKey);
  const initial=ctx();
  const trusted=await initial.readTrustAfterReservation();
  const rotated=generateKeyPairSync('ed25519');
  const changes=[
    {currentOwnerPreferenceRevision:'owner-audit-44'},
    {currentGuardianKeyId:'c'.repeat(64)},
    {enrolledHubPublicKey:rotated.publicKey},
    {deviceId:'device-2'},
    {ownerAccountId:'owner-2'},
    {credentialBinding:'c'.repeat(64)},
  ];
  for(const delta of changes){
    let consumed=0;
    let trustReads=0;
    await assert.rejects(verifyAndReserveGuardianHubCommand(envelope,{
      ...ctx(),
      atomicallyReserveRequest:async()=>{consumed++;return true},
      readTrustAfterReservation:async()=>{trustReads++;return {...trusted,...delta}},
    }),/GUARDIAN_HUB_COMMAND_POST_RESERVATION_TRUST_REVOKED|BRIDGE_INTENT_IDENTITY_MISMATCH/);
    assert.equal(consumed,1);
    assert.equal(trustReads,1);
  }
});

test('post-reservation trust reader errors are never treated as acceptance',async()=>{
  const envelope=signGuardianHubCommand(body(),hub.privateKey);
  let consumed=0;
  await assert.rejects(verifyAndReserveGuardianHubCommand(envelope,{
    ...ctx(),
    atomicallyReserveRequest:async()=>{consumed++;return true},
    readTrustAfterReservation:async()=>{throw new Error('TRUST_COLLECTOR_UNAVAILABLE')},
  }),/TRUST_COLLECTOR_UNAVAILABLE/);
  assert.equal(consumed,1);
});

test('long-running post-reservation trust read cannot use earlier unexpired time',async()=>{
  const envelope=signGuardianHubCommand(body(),hub.privateKey);
  let consumed=0,clockReads=0;
  await assert.rejects(verifyAndReserveGuardianHubCommand(envelope,{
    ...ctx(),
    atomicallyReserveRequest:async()=>{consumed++;return true},
    nowAfterReservation:()=>new Date(++clockReads===1?
      '2026-10-10T15:01:00.000Z':'2026-10-10T15:02:00.000Z'),
  }),/BRIDGE_INTENT_EXPIRED_OR_INVALID/);
  assert.equal(consumed,1);
  assert.equal(clockReads,2);
});

test('fresh post-reservation clock cannot go backwards while trust reader runs',async()=>{
  const envelope=signGuardianHubCommand(body(),hub.privateKey);
  let consumed=0,clockReads=0;
  await assert.rejects(verifyAndReserveGuardianHubCommand(envelope,{
    ...ctx(),
    atomicallyReserveRequest:async()=>{consumed++;return true},
    nowAfterReservation:()=>new Date(++clockReads===1?
      '2026-10-10T15:01:00.000Z':'2026-10-10T15:00:59.000Z'),
  }),/GUARDIAN_HUB_COMMAND_POST_RESERVATION_CLOCK_UNTRUSTED/);
  assert.equal(consumed,1);
  assert.equal(clockReads,2);
});

test('atomic repeated claims accept only one locally, durable storage required in production',async()=>{
  const envelope=signGuardianHubCommand(body(),hub.privateKey);
  const used=new Set<string>();
  const context={...ctx(),atomicallyReserveRequest:async(id:string)=>{
    if(used.has(id)) return false;
    used.add(id);
    return true;
  }};
  const results=await Promise.allSettled(
    Array.from({length:8},()=>verifyAndReserveGuardianHubCommand(envelope,context)),
  );
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected').length,7);
});

test('request fields retain strict bounded schema, and signing key type is checked',async()=>{
  assert.throws(()=>hubCommandPublicKeyId(hub.privateKey),
    /GUARDIAN_HUB_COMMAND_PUBLIC_KEY_UNTRUSTED/);
  assert.throws(()=>signGuardianHubCommand(body(),hub.publicKey),
    /GUARDIAN_HUB_COMMAND_PRIVATE_KEY_UNTRUSTED/);
  const malformed=signGuardianHubCommand({
    ...body(),ownerPreferenceRevision:revision,
  },hub.privateKey);
  await assert.rejects(verifyAndReserveGuardianHubCommand({
    ...malformed,intent:{...malformed.intent,requestId:'invalid-uuid'},
  },ctx()));
});
