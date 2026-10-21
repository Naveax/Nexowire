import assert from 'node:assert/strict';
import {generateKeyPairSync, sign} from 'node:crypto';
import test from 'node:test';
import {
  projectCoreEffectiveUiStatus,coreUiBrokerSigningBytes,coreUiWitnessSigningBytes,
  type CoreUiFacts,type CoreUiTrustPins,type SignedUiEvidence,
  type BrokerNativeStatement,type ExternalEpochWitness,
} from '../src/diagnostics/core-effective-ui-status.js';

const N = new Date('2026-10-21T15:00:00.000Z');
const native = generateKeyPairSync('ed25519');
const witnessAuthority = generateKeyPairSync('ed25519');
const OTHER = generateKeyPairSync('ed25519');
const SHA = 'a'.repeat(64);
const pins: CoreUiTrustPins = {now:N,brokerNativeKey:native.publicKey,
  externalWitnessKey:witnessAuthority.publicKey,expectedBrokerImageSha256:SHA,
  expectedBrokerVersion:'1.0.5',expectedOwnerEpoch:4,expectedGrantGeneration:8,
  expectedConnectionEpoch:17};
const facts: CoreUiFacts = {deviceId:'d1',ownerAccountId:'o1',currentOwnerSessionId:'s1',
  requestedMode:'CORE',accessMode:'full',online:true,currentConnectionEpoch:17,bridgeRequested:'on',
  corePreferenceEnabled:true,rootLease:null,reportedCoreActive:true,
  agentReportedBrokerReady:true,consentExeSeen:true,brokerHttpStatus:401};
const broker: BrokerNativeStatement = {
  schema:'nexowire.ui.broker-native.v2',deviceId:'d1',ownerAccountId:'o1',
  ownerSessionId:'s1',ownerEpoch:4,grantGeneration:8,connectionEpoch:17,grantMode:'CORE',
  rootLeaseIssuedAt:null,rootLeaseExpiresAt:null,
  observedAt:N.toISOString(),brokerImageSha256:SHA,brokerVersion:'1.0.5',
  nativeHighToken:true,administratorsEnabled:true,authenticatedBroker:true,
  pinnedPublisherSignature:true,protectedParentAcl:true,
  protectedImportTreeAcl:true,protectedTaskIdentity:true,locallyAttestedEnrollment:true,
};
const witness: ExternalEpochWitness = {schema:'nexowire.ui.external-epoch.v2',
  deviceId:'d1',ownerAccountId:'o1',ownerEpoch:4,grantGeneration:8,connectionEpoch:17,revoked:false,
  observedAt:N.toISOString()};
function signed(b = broker, w = witness): SignedUiEvidence {
  return {broker:{statement:b,signature:sign(null,coreUiBrokerSigningBytes(b),native.privateKey).toString('base64')},
    externalWitness:{statement:w,signature:sign(null,coreUiWitnessSigningBytes(w),witnessAuthority.privateKey).toString('base64')}};
}
function evalUi(f:CoreUiFacts = facts,p:CoreUiTrustPins=pins,s:SignedUiEvidence|null=signed()){
  return projectCoreEffectiveUiStatus(f,p,s);
}

test('SAFE and FULL never imply administrator access, even with signed CORE evidence',()=>{
  for (const mode of ['SAFE','FULL'] as const) {
    const out=evalUi({...facts,requestedMode:mode});
    assert.equal(out.effectiveElevatedBroker,false);
    assert.equal(out.state,mode==='SAFE'?'SAFE_USER':'FULL_STANDARD_USER');
    assert.match(out.label,/standart kullanıcı/);
    assert.equal(out.grantsExecution,false);
  }
});
test('CORE selection, 401, consent.exe and Broker telemetry are no Windows privilege proof',()=>{
  const out=evalUi(facts,pins,null);
  assert.equal(out.state,'PAUSED_UNVERIFIED');
  assert.equal(out.effectiveElevatedBroker,false);
  assert.equal(out.uacApprovalProvenByUi,false);
  assert.equal(out.evidence,'not-proven');
});
test('signed native Broker AND independent signed external epoch support UI evidence candidate only',()=>{
  const out=evalUi();
  assert.equal(out.state,'CORE_SIGNED_BROKER');
  assert.equal(out.effectiveElevatedBroker,true);
  assert.equal(out.evidence,'signed-native-and-external-epoch-candidate');
  assert.equal(out.grantsExecution,false);
  assert.equal(out.uacApprovalProvenByUi,false);
});
test('CORE preference OFF, lost session, offline and SAFE downgrade all fail closed',()=>{
  const cases:CoreUiFacts[]=[
    {...facts,corePreferenceEnabled:false},
    {...facts,currentOwnerSessionId:null},
    {...facts,online:false},
    {...facts,accessMode:'safe'},
    {...facts,bridgeRequested:'off'},
  ];
  for (const f of cases) assert.equal(evalUi(f).effectiveElevatedBroker,false);
  assert.equal(evalUi(cases[0]!).state,'CORE_OFF');
});
test('ROOT current owner session with bounded 15m lease, and expiry at exact millisecond',()=>{
  const issuedAt=new Date(N.getTime()-899_999).toISOString();
  const expiresAt=new Date(N.getTime()+1).toISOString();
  const root={...facts,requestedMode:'ROOT' as const,rootLease:{ownerAccountId:'o1',sessionId:'s1',issuedAt,expiresAt}};
  const rootEvidence=signed({...broker,grantMode:'ROOT',rootLeaseIssuedAt:issuedAt,rootLeaseExpiresAt:expiresAt});
  assert.equal(evalUi(root,pins,rootEvidence).state,'ROOT_SIGNED_BROKER');
  assert.equal(evalUi(root).effectiveElevatedBroker,false, 'CORE proof cannot elevate ROOT');
  assert.equal(evalUi(root,{...pins,now:new Date(N.getTime()+1)}).state,'ROOT_EXPIRED');
  const overlong={...root,rootLease:{...root.rootLease,issuedAt:new Date(N.getTime()-900_000).toISOString()}};
  assert.equal(evalUi(overlong).state,'ROOT_EXPIRED');
  const wrongSession={...root,rootLease:{...root.rootLease,sessionId:'other'}};
  assert.equal(evalUi(wrongSession).effectiveElevatedBroker,false);
});
test('ROOT lease is signed and mode-bound: forged lease and ROOT-to-CORE replay denied',()=>{
  const issuedAt=new Date(N.getTime()-1000).toISOString();
  const expiresAt=new Date(N.getTime()+899000).toISOString();
  const root={...facts,requestedMode:'ROOT' as const,
    rootLease:{ownerAccountId:'o1',sessionId:'s1',issuedAt,expiresAt}};
  const proof=signed({...broker,grantMode:'ROOT',rootLeaseIssuedAt:issuedAt,rootLeaseExpiresAt:expiresAt});
  assert.equal(evalUi(root,pins,proof).state,'ROOT_SIGNED_BROKER');
  assert.equal(evalUi({...root,rootLease:{...root.rootLease,expiresAt:new Date(N.getTime()+900_000).toISOString()}},pins,proof).effectiveElevatedBroker,false);
  assert.equal(evalUi(facts,pins,proof).effectiveElevatedBroker,false);
});
test('CORE persistence does not depend on 15m ROOT expiration, but needs fresh receipts on reconnect',()=>{
  const later=new Date(N.getTime()+24*60*60*1000);
  const b={...broker,observedAt:later.toISOString()},w={...witness,observedAt:later.toISOString()};
  assert.equal(evalUi(facts,{...pins,now:later},signed(b,w)).state,'CORE_SIGNED_BROKER');
  assert.equal(evalUi(facts,{...pins,now:later}).effectiveElevatedBroker,false);
});
test('revocation, stale owner epoch/generation, owner transfer cannot remain effective',()=>{
  const revoked=evalUi(facts,pins,signed(broker,{...witness,revoked:true}));
  assert.equal(revoked.state,'PAUSED_UNVERIFIED');
  assert.ok(revoked.reasons.includes('CORE_REVOKED_OR_STALE_EPOCH'));
  assert.equal(evalUi(facts,pins,signed(broker,{...witness,ownerEpoch:5})).effectiveElevatedBroker,false);
  assert.equal(evalUi(facts,pins,signed(broker,{...witness,grantGeneration:9})).effectiveElevatedBroker,false);
  assert.equal(evalUi(facts,{...pins,expectedOwnerEpoch:5},signed()).effectiveElevatedBroker,false);
  assert.equal(evalUi(facts,{...pins,expectedGrantGeneration:9},signed()).effectiveElevatedBroker,false);
  assert.equal(evalUi({...facts,ownerAccountId:'o2'}).effectiveElevatedBroker,false);
  assert.equal(evalUi({...facts,currentOwnerSessionId:'s2'}).effectiveElevatedBroker,false);
});
test('forged receipt, signer, native medium token, deny-only group, ACL, version, parent/import/task are denied',()=>{
  const tampered=signed();
  const forged={...tampered,broker:{...tampered.broker,statement:{...broker,nativeHighToken:false}}};
  assert.equal(evalUi(facts,pins,forged).effectiveElevatedBroker,false);
  const badSigner={...tampered,broker:{...tampered.broker,
    signature:sign(null,coreUiBrokerSigningBytes(broker),OTHER.privateKey).toString('base64')}};
  assert.equal(evalUi(facts,pins,badSigner).effectiveElevatedBroker,false);
  for(const patch of [
    {nativeHighToken:false},{administratorsEnabled:false},{authenticatedBroker:false},
    {pinnedPublisherSignature:false},{protectedParentAcl:false},
    {protectedImportTreeAcl:false},{protectedTaskIdentity:false},
    {locallyAttestedEnrollment:false},{brokerVersion:'0.9.9'},
    {brokerImageSha256:'b'.repeat(64)},
  ])assert.equal(evalUi(facts,pins,signed({...broker,...patch})).effectiveElevatedBroker,false,
    JSON.stringify(patch));
});
test('no independent signer: sharing native and CAS key fails closed',()=>{
  assert.equal(evalUi(facts,{...pins,externalWitnessKey:native.publicKey}).effectiveElevatedBroker,false);
});
test('missing external witness or stale/future native receipt prevents elevation UI',()=>{
  const proof=signed();
  assert.equal(evalUi(facts,pins,{...proof,externalWitness:{...proof.externalWitness,signature:'not-a-signature'}}).effectiveElevatedBroker,false);
  const stale={...broker,observedAt:new Date(N.getTime()-30_001).toISOString()};
  assert.equal(evalUi(facts,pins,signed(stale)).effectiveElevatedBroker,false);
  const future={...witness,observedAt:new Date(N.getTime()+2_001).toISOString()};
  assert.equal(evalUi(facts,pins,signed(broker,future)).effectiveElevatedBroker,false);
});
test('no UI report is an authorization permit or UAC approval',()=>{
  for(const state of [evalUi(),evalUi(facts,pins,null),evalUi({...facts,requestedMode:'FULL'})]){
    assert.equal(state.grantsExecution,false);
    assert.equal(state.uacApprovalProvenByUi,false);
  }
});

test('reinstall with same reported Broker version but different executable SHA rejects old signed receipt',()=>{
  const installedSha='b'.repeat(64);
  const reinstall={...pins,expectedBrokerImageSha256:installedSha};
  const stale=signed();
  assert.equal(evalUi(facts,reinstall,stale).state,'PAUSED_UNVERIFIED');
  // A forged UI badge cannot rescue the pre-reinstall executable receipt.
  assert.equal(evalUi({...facts,reportedCoreBadge:'CORE EFFECTIVE',claimedCoreEffective:true},reinstall,stale).effectiveElevatedBroker,false);
  // Only new source-consistent evidence could pass a new expected image pin.
  const after=signed({...broker,brokerImageSha256:installedSha});
  assert.equal(evalUi(facts,reinstall,after).state,'CORE_SIGNED_BROKER');
  assert.equal(evalUi(facts,{...reinstall,expectedBrokerVersion:'1.0.6'},after).effectiveElevatedBroker,false);
});

test('owner epoch rollback: old valid signatures cannot defeat independently advanced high-watermark',()=>{
  const old=signed();
  const advanced=signed({...broker,ownerEpoch:5,grantGeneration:9},
    {...witness,ownerEpoch:5,grantGeneration:9});
  const authoritative={...pins,expectedOwnerEpoch:5,expectedGrantGeneration:9};
  assert.equal(evalUi(facts,authoritative,advanced).state,'CORE_SIGNED_BROKER');
  assert.equal(evalUi(facts,authoritative,old).effectiveElevatedBroker,false);
  assert.equal(evalUi(facts,{...authoritative,expectedOwnerEpoch:4},advanced).effectiveElevatedBroker,false);
  assert.equal(evalUi(facts,authoritative,signed({...broker,ownerEpoch:5,grantGeneration:9},witness)).effectiveElevatedBroker,false);
});

test('offline -> reconnect: old signed pair rejected inside freshness window by new connection epoch',()=>{
  const connected=signed();
  assert.equal(evalUi(facts,pins,connected).state,'CORE_SIGNED_BROKER');
  assert.equal(evalUi({...facts,online:false},pins,connected).effectiveElevatedBroker,false);
  const rebound={...facts,online:true,currentConnectionEpoch:18};
  const newPins={...pins,expectedConnectionEpoch:18};
  // Only 1ms elapsed, so old evidence still passes ordinary timestamp freshness.
  assert.equal(evalUi(rebound,{...newPins,now:new Date(N.getTime()+1)},connected).effectiveElevatedBroker,false);
  const renewed=signed({...broker,connectionEpoch:18,observedAt:new Date(N.getTime()+1).toISOString()},
    {...witness,connectionEpoch:18,observedAt:new Date(N.getTime()+1).toISOString()});
  assert.equal(evalUi(rebound,{...newPins,now:new Date(N.getTime()+1)},renewed).state,'CORE_SIGNED_BROKER');
  assert.equal(evalUi(facts,pins,renewed).effectiveElevatedBroker,false);
  assert.equal(evalUi(rebound,pins,renewed).effectiveElevatedBroker,false);
});

test('external witness and native Broker must independently agree on the authenticated connection incarnation',()=>{
  assert.equal(evalUi(facts,pins,signed({...broker,connectionEpoch:18})).effectiveElevatedBroker,false);
  assert.equal(evalUi(facts,pins,signed(broker,{...witness,connectionEpoch:18})).effectiveElevatedBroker,false);
  assert.equal(evalUi({...facts,currentConnectionEpoch:0}).effectiveElevatedBroker,false);
  assert.equal(evalUi(facts,{...pins,expectedConnectionEpoch:0}).effectiveElevatedBroker,false);
});

test('consent.exe plus HTTP401 and all-green badges cannot manufacture effective CORE',()=>{
  const forged={...facts,reportedCoreActive:true,agentReportedBrokerReady:true,
    consentExeSeen:true,brokerHttpStatus:401,reportedCoreBadge:'CORE YÖNETİCİ ETKİN',claimedCoreEffective:true};
  const out=evalUi(forged,pins,null);
  assert.equal(out.state,'PAUSED_UNVERIFIED');
  assert.equal(out.evidence,'not-proven');
  assert.equal(out.effectiveElevatedBroker,false);
  assert.equal(out.uacApprovalProvenByUi,false);
  assert.equal(out.grantsExecution,false);
  const wrongSigned=signed({...broker,nativeHighToken:false});
  assert.equal(evalUi(forged,pins,wrongSigned).effectiveElevatedBroker,false);
});

test('cosmetic badge state is not read by the projection, even if its getter is malicious',()=>{
  const hostile=new Proxy({...facts},{get(target,key,receiver){
    if(key==='reportedCoreBadge' || key==='claimedCoreEffective' || key==='reportedCoreActive'){
      throw new Error('BADGE_MUST_NOT_BE_READ');
    }
    return Reflect.get(target,key,receiver);
  }});
  assert.equal(evalUi(hostile,pins,null).state,'PAUSED_UNVERIFIED');
  assert.equal(evalUi(hostile,pins,signed()).state,'CORE_SIGNED_BROKER');
  for(const badge of ['CORE EFFECTIVE','CORE YÖNETİCİ ETKİN','', 'ROOT','FULL']){
    const fake={...facts,reportedCoreBadge:badge,claimedCoreEffective:badge.length>0};
    assert.equal(evalUi(fake,pins,null).effectiveElevatedBroker,false);
  }
});
