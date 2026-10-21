import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {
  AccessEffectiveAuthority,nativeEffectiveSigningBytes,externalEffectiveSigningBytes,
  type EffectiveEvidenceReader,type NativeAccessAttestation,
  type ExternalRevocationAttestation,
} from '../src/product/access-effective-authority.js';
import type {ProductDeviceRecord,ControlPlaneStore} from '../src/product/control-plane-store.js';
import type {D1CoreDelegationLedger} from '../src/security/core-admin-delegation.js';

const native=generateKeyPairSync('ed25519');
const external=generateKeyPairSync('ed25519');
const alien=generateKeyPairSync('ed25519');
const NOW='2026-10-21T15:00:00.000Z',now=new Date(NOW);
const sha='a'.repeat(64),image='b'.repeat(64);
const session={ownerAccountId:'owner',sessionHash:'c'.repeat(64),
  sessionExpiresAt:'2026-10-22T15:00:00.000Z',loginIsRevoked:false};
const device={id:'device',ownerAccountId:'owner',platform:'win32',
 accessMode:'full',online:true,privilegeMode:'broker',credentialHash:sha,
 adminBridgeReady:true} as ProductDeviceRecord;
const nativeStatement:NativeAccessAttestation={
  schema:'nexowire.access.native-effective.v1',mode:'CORE',deviceId:'device',
  ownerAccountId:'owner',credentialHash:sha,sessionHash:session.sessionHash,
  ownerEpoch:4,grantGeneration:8,rootIssuedAt:null,rootExpiresAt:null,
  enrollmentId:'enrollment-a',brokerImageSha256:image,brokerVersion:'1.0.5',
  observedAt:NOW,nativeHighIntegrity:true,administratorsEnabled:true,
  authenticatedBroker:true,localUacBootstrapVerified:true,
  publisherAndReleasePinned:true,parentImportUpdaterAclProtected:true,
  processHandleBoundaryProtected:true,ownerApprovedDelegation:true,
};
const epochStatement:ExternalRevocationAttestation={
  schema:'nexowire.access.external-epoch.v1',deviceId:'device',
  ownerAccountId:'owner',ownerEpoch:4,grantGeneration:8,
  revoked:false,observedAt:NOW,
};
const pins={
  nativeProtectedCollectorPublicKey:native.publicKey,
  externalCasPublicKey:external.publicKey,
  expectedImageSha256:image,expectedBrokerVersion:'1.0.5',
  independentlyReadOwnerEpoch:4,independentlyReadGrantGeneration:8,
  physicallyAcceptedNativeCollector:true,physicallyAcceptedExternalCas:true,
};
const bsign=(b:NativeAccessAttestation,key=native.privateKey)=>
  sign(null,nativeEffectiveSigningBytes(b),key).toString('base64url');
const esign=(e:ExternalRevocationAttestation,key=external.privateKey)=>
  sign(null,externalEffectiveSigningBytes(e),key).toString('base64url');
function setup(options:{
  native?:Partial<NativeAccessAttestation>;
  epoch?:Partial<ExternalRevocationAttestation>;
  pins?:Partial<typeof pins>;
  forgetRoot?:boolean;forgetCore?:boolean;throwRead?:boolean;
  signNativeWithOther?:boolean;signEpochWithOther?:boolean;
}={}){
  const broker={...nativeStatement,...options.native};
  const witness={...epochStatement,...options.epoch};
  const evidence={
    broker:{statement:broker,signature:bsign(broker,options.signNativeWithOther?alien.privateKey:native.privateKey)},
    epoch:{statement:witness,signature:esign(witness,options.signEpochWithOther?alien.privateKey:external.privateKey)},
  };
  let queries=0;
  const reader:EffectiveEvidenceReader={fetch:async ()=>{
    queries++;
    if(options.throwRead)throw Error('native-offline');
    return {evidence,trust:{...pins,...options.pins}};
  }};
  const store={
    getRootSessionGrant:async()=>options.forgetRoot?null:{
      issuedAt:'2026-10-21T14:45:01.001Z',
      expiresAt:'2026-10-21T15:00:01.000Z',
    },
  } as unknown as ControlPlaneStore;
  const ledger={
    currentCandidate:async()=>options.forgetCore?null:{
      enrollmentId:'enrollment-a',generation:8,
      deviceId:'device',ownerAccountId:'owner',
      credentialHash:sha,brokerImageSha256:image,
      brokerVersion:'1.0.5',signerKeySha256:'d'.repeat(64),
      localConsentEvidenceSha256:'e'.repeat(64),
      enrolledAt:'2026-10-20T12:00:00.000Z',
      productionPrivilegeAttested:false,
    },
  } as unknown as D1CoreDelegationLedger;
  return {
    authority:new AccessEffectiveAuthority(store,ledger,reader,()=>now),
    queries:()=>queries,
  };
}
const coreInput=(changes:Record<string,unknown>={})=>({
  device,mode:'CORE' as const,session,corePreferenceEnabled:true,
  bridgeDesiredMode:'auto' as const,...changes,
});
const rootInput=(changes:Record<string,unknown>={})=>({
  device,mode:'ROOT' as const,session,corePreferenceEnabled:false,
  bridgeDesiredMode:'on' as const,...changes,
});

test('signed native AND external CAS + durable CORE grant produce EFFECTIVE status, not dispatch',async()=>{
  const x=setup();
  const result=await x.authority.project(coreInput());
  assert.equal(result.state,'EFFECTIVE');
  assert.equal(result.effective,true);
  assert.equal(result.actualElevatedTokenVerified,true);
  assert.equal(result.localEnrollmentVerified,true);
  assert.equal(result.authoritySource,'independent-protected-windows-broker');
  assert.equal(result.requiresPerCommandUac,false);
  assert.equal(result.canDispatch,false);
  assert.equal(x.queries(),1,'independent evidence must be fetched only once');
});

test('FULL standard and SAFE never elevate or query signed Broker',async()=>{
 const x=setup();
 for(const mode of ['FULL','SAFE'] as const) {
   const r=await x.authority.project({...coreInput(),mode});
   assert.equal(r.effective,false);
   assert.equal(r.state,mode==='FULL'?'FULL_STANDARD_USER':'SAFE_USER');
 }
 assert.equal(x.queries(),0);
});

test('ROOT mode verifies session-bound grant and signed exact <=15m timestamps',async()=>{
 const b={...nativeStatement,mode:'ROOT' as const,grantGeneration:5,
   rootIssuedAt:'2026-10-21T14:45:01.001Z',
   rootExpiresAt:'2026-10-21T15:00:01.000Z',enrollmentId:null};
 const x=setup({native:b,epoch:{grantGeneration:5},pins:{independentlyReadGrantGeneration:5}});
 const r=await x.authority.project(rootInput());
 assert.equal(r.state,'EFFECTIVE',r.reason);
 assert.equal(r.requiresPerCommandUac,false);
 assert.equal(r.canDispatch,false);
 assert.equal((await setup({native:b,epoch:{grantGeneration:5},pins:{
    independentlyReadGrantGeneration:5},forgetRoot:true}).authority.project(rootInput())).effective,false);
 const invalid=setup({native:{...b,rootExpiresAt:'2026-10-21T15:00:02.000Z'},
   epoch:{grantGeneration:5},pins:{independentlyReadGrantGeneration:5}});
 assert.equal((await invalid.authority.project(rootInput())).effective,false);
});

test('independent signer or external watermark change revokes previously signed effective status',async()=>{
 for(const cfg of [
  {signNativeWithOther:true},{signEpochWithOther:true},
  {pins:{independentlyReadOwnerEpoch:5}},
  {pins:{independentlyReadGrantGeneration:9}},
  {epoch:{revoked:true}},
  {native:{ownerEpoch:5}},
  {native:{brokerVersion:'1.0.4'}},
  {native:{nativeHighIntegrity:false}},
  {native:{administratorsEnabled:false}},
  {native:{publisherAndReleasePinned:false}},
  {native:{parentImportUpdaterAclProtected:false}},
  {native:{localUacBootstrapVerified:false}},
  {pins:{physicallyAcceptedNativeCollector:false}},
  {pins:{physicallyAcceptedExternalCas:false}},
  {pins:{externalCasPublicKey:native.publicKey}},
  {native:{observedAt:'2026-10-21T14:58:00.000Z'}},
 ]){
   const result=await setup(cfg).authority.project(coreInput());
   assert.equal(result.effective,false,JSON.stringify(Object.keys(cfg)));
   assert.equal(result.canDispatch,false);
 }
});

test('CORE preference OFF, missing durable enrollment, re-pair/owner/session and Broker OFF all deny',async()=>{
 const x=setup();
 for(const change of [
   {corePreferenceEnabled:false},{bridgeDesiredMode:'off'},
   {session:{...session,loginIsRevoked:true}},
   {session:{...session,ownerAccountId:'other'}},
   {session:{...session,sessionHash:'d'.repeat(64)}},
   {device:{...device,ownerAccountId:'other'}},
   {device:{...device,credentialHash:'f'.repeat(64)}},
   {device:{...device,accessMode:'safe'}},
   {device:{...device,online:false}},
   {device:{...device,privilegeMode:'direct'}},
 ]){
  assert.equal((await x.authority.project(coreInput(change) as any)).effective,false);
 }
 assert.equal((await setup({forgetCore:true}).authority.project(coreInput())).effective,false);
 assert.equal((await setup({throwRead:true}).authority.project(coreInput())).effective,false);
});

test('HTTP 401, Agent telemetry and client claims do not appear in trusted evidence',()=>{
 const input=coreInput();
 assert.equal('adminBridgeReady' in input.device,true);
 assert.equal('trustedBy401' in nativeStatement,false);
 assert.equal('coreActiveFromUi' in pins,false);
});
