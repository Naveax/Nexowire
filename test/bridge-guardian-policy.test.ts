import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reserveVerifiedGuardianCommand,
  type BridgeGuardianTrustedFacts,
} from '../src/agent/bridge-guardian-policy.js';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const HASH = 'a'.repeat(64);
const REVISION = 'audit-event-10';

const intent = (mode:'auto'|'on'|'off'='on') => ({
  type:'admin-bridge.mode-intent',
  version:1,
  requestId:REQUEST_ID,
  deviceId:'device-1',
  ownerAccountId:'owner-1',
  credentialBinding:HASH,
  desiredMode:mode,
  issuedAt:'2026-10-10T14:59:40.000Z',
  expiresAt:'2026-10-10T15:01:20.000Z',
});

const facts = (mode:'auto'|'on'|'off'='on'):BridgeGuardianTrustedFacts => ({
  deviceId:'device-1',
  ownerAccountId:'owner-1',
  credentialBinding:HASH,
  platform:'win32',
  accessMode:'full',
  currentPreference:{desiredMode:mode,revision:REVISION},
  ownerApproval:{requestId:REQUEST_ID,preferenceRevision:REVISION},
  localGuardian:{
    installed:true,
    online:true,
    independentlyReachableWithBrokerOff:true,
    protectedSourceVerified:true,
    taskIdentityVerified:true,
    elevatedLocalTokenVerified:true,
    hubTransportAuthenticated:true,
    currentDeviceSessionVerified:true,
  },
  broker:{
    canonicalTaskIdentityVerified:true,
    launcherAclVerified:true,
  },
  now:new Date('2026-10-10T15:00:00.000Z'),
});

test('Guardian returns only a reserved policy decision, never an OS task operation', async()=>{
  let reservations=0;
  const result=await reserveVerifiedGuardianCommand(
    intent(),async()=>facts(),
    async(id,device,hash,rev)=>{
      assert.deepEqual([id,device,hash,rev],[REQUEST_ID,'device-1',HASH,REVISION]);
      reservations++;
      return true;
    },
  );
  assert.equal(reservations,1);
  assert.equal(result.state,'reserved-for-verified-local-processing');
  assert.equal(result.desiredMode,'on');
  assert.equal(Object.isFrozen(result),true);
  assert.equal('taskName' in result,false);
  assert.equal('powershell' in result,false);
});

test('Guardian refuses commands without an independently running protected supervisor',async()=>{
  const defaults=facts();
  for(const key of Object.keys(defaults.localGuardian) as
      (keyof BridgeGuardianTrustedFacts['localGuardian'])[]){
    let reservations=0;
    const state={...defaults,localGuardian:{...defaults.localGuardian,[key]:false}};
    await assert.rejects(
      reserveVerifiedGuardianCommand(intent(),async()=>state,async()=>{reservations++;return true;}),
      /BRIDGE_GUARDIAN_INDEPENDENCE_OR_TRUST_UNVERIFIED/,
      key,
    );
    assert.equal(reservations,0,key);
  }
});

test('Guardian always checks owner approval and *latest* preference audit revision',async()=>{
  const scenarios=[
    {...facts(),ownerApproval:null},
    {...facts(),ownerApproval:{requestId:'22222222-2222-4222-8222-222222222222',preferenceRevision:REVISION}},
    {...facts(),ownerApproval:{requestId:REQUEST_ID,preferenceRevision:'old-revision'}},
    {...facts(),currentPreference:{desiredMode:'off' as const,revision:REVISION}},
    {...facts(),currentPreference:{desiredMode:'on' as const,revision:'new-revision'}},
    {...facts(),currentPreference:{desiredMode:'on' as const,revision:'../path'}},
  ];
  for(const state of scenarios){
    await assert.rejects(
      reserveVerifiedGuardianCommand(intent(),async()=>state,async()=>true),
      /BRIDGE_GUARDIAN_OWNER_APPROVAL_INVALID/,
    );
  }
});

test('OFF remains possible when Broker itself is unhealthy, but ON/AUTO fail closed',async()=>{
  const brokenBroker={canonicalTaskIdentityVerified:false,launcherAclVerified:false};
  const off=await reserveVerifiedGuardianCommand(
    intent('off'),async()=>({...facts('off'),broker:brokenBroker}),async()=>true,
  );
  assert.equal(off.desiredMode,'off');
  for(const mode of ['auto','on'] as const){
    await assert.rejects(
      reserveVerifiedGuardianCommand(intent(mode),
        async()=>({...facts(mode),broker:brokenBroker}),async()=>true),
      /BRIDGE_GUARDIAN_BROKER_START_UNTRUSTED/,
    );
  }
});

test('SAFE, wrong platform, stale pairing or expired intent cannot reserve',async()=>{
  for(const state of [
    {...facts(),accessMode:'safe' as const},
    {...facts(),platform:'other' as const},
  ]){
    await assert.rejects(
      reserveVerifiedGuardianCommand(intent(),async()=>state,async()=>true),
      /BRIDGE_GUARDIAN_DEVICE_NOT_ELIGIBLE/,
    );
  }
  await assert.rejects(
    reserveVerifiedGuardianCommand(intent(),
      async()=>({...facts(),credentialBinding:'b'.repeat(64)}),async()=>true),
    /BRIDGE_INTENT_IDENTITY_MISMATCH/,
  );
  await assert.rejects(
    reserveVerifiedGuardianCommand(intent(),
      async()=>({...facts(),now:new Date('2026-10-10T15:01:20.000Z')}),async()=>true),
    /BRIDGE_INTENT_EXPIRED_OR_INVALID/,
  );
});

test('persisted replay/re-pair/revocation failures reject even after all local checks pass',async()=>{
  await assert.rejects(
    reserveVerifiedGuardianCommand(intent(),async()=>facts(),async()=>false),
    /BRIDGE_GUARDIAN_ALREADY_CONSUMED_OR_REVOKED/,
  );
  const consumed=new Set<string>();
  const atomic=async(id:string)=>{
    if(consumed.has(id))return false;
    consumed.add(id);
    return true;
  };
  const attempts=await Promise.allSettled(
    Array.from({length:8},()=>reserveVerifiedGuardianCommand(
      intent(),async()=>facts(),atomic,
    )),
  );
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(attempts.filter(r=>r.status==='rejected').length,7);
});

test('Guardian rechecks clock, owner consent, pairing and its own health after local reservation',async()=>{
  const snapshots:BridgeGuardianTrustedFacts[]=[
    {...facts(),now:new Date('2026-10-10T15:01:20.000Z')},
    {...facts(),ownerApproval:null},
    {...facts(),credentialBinding:'b'.repeat(64)},
    {...facts(),localGuardian:{...facts().localGuardian,
      hubTransportAuthenticated:false}},
    {...facts(),currentPreference:{desiredMode:'off',revision:REVISION}},
    {...facts(),currentPreference:{desiredMode:'on',revision:'audit-event-11'},
      ownerApproval:{requestId:REQUEST_ID,preferenceRevision:'audit-event-11'}},
    {...facts(),accessMode:'safe'},
    {...facts(),broker:{canonicalTaskIdentityVerified:false,
      launcherAclVerified:false}},
  ];
  for(const changed of snapshots){
    let reads=0,reservations=0;
    const trustedRead=async()=>++reads===1?facts():changed;
    await assert.rejects(reserveVerifiedGuardianCommand(
      intent(),trustedRead,async()=>{reservations++;return true},
    ));
    assert.equal(reads,2);
    assert.equal(reservations,1);
  }
});

test('unknown instructions or malformed schema never reach reservation callback',async()=>{
  let invoked=false;
  for(const malformed of [
    {...intent(),desiredMode:'uninstall'},
    {...intent(),arbitraryCommand:'shell.exec'},
    {...intent(),requestId:'not-uuid'},
    {...intent(),expiresAt:'2026-10-10T15:05:00.000Z'},
  ]){
    await assert.rejects(reserveVerifiedGuardianCommand(
      malformed,async()=>facts(),async()=>{invoked=true;return true;},
    ));
  }
  assert.equal(invoked,false);
});
