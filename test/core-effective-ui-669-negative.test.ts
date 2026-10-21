import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {
  AccessEffectiveAuthority,nativeEffectiveSigningBytes,externalEffectiveSigningBytes,
  type NativeAccessAttestation,type ExternalRevocationAttestation,
  type EffectiveEvidenceReader,type TrustedEffectiveAnchor,
} from '../src/product/access-effective-authority.js';
import type {ControlPlaneStore,ProductDeviceRecord} from '../src/product/control-plane-store.js';
import type {D1CoreDelegationLedger} from '../src/security/core-admin-delegation.js';

/** #23 independent source QA against #669; never a real Windows grant. */
const NOW=new Date('2026-10-21T15:00:00.000Z');
const legacyImage='a'.repeat(64), currentImage='b'.repeat(64);
const credential='c'.repeat(64),loginHash='d'.repeat(64);
const nativeSigner=generateKeyPairSync('ed25519');
const externalSigner=generateKeyPairSync('ed25519');
const foreignSigner=generateKeyPairSync('ed25519');
const session={ownerAccountId:'owner-a',sessionHash:loginHash,
  sessionExpiresAt:'2026-10-21T16:00:00.000Z',loginIsRevoked:false};
const device={id:'device-a',ownerAccountId:'owner-a',platform:'win32',
  credentialHash:credential,accessMode:'full',online:true,privilegeMode:'broker',
  adminBridgeReady:true} as ProductDeviceRecord;
const nativeReport:NativeAccessAttestation={
  schema:'nexowire.access.native-effective.v1',mode:'CORE',
  deviceId:device.id,ownerAccountId:device.ownerAccountId,
  credentialHash:credential,sessionHash:loginHash,
  ownerEpoch:4,grantGeneration:8,rootIssuedAt:null,rootExpiresAt:null,
  enrollmentId:'enrollment-current',brokerImageSha256:currentImage,
  brokerVersion:'1.0.5',observedAt:NOW.toISOString(),
  nativeHighIntegrity:true,administratorsEnabled:true,authenticatedBroker:true,
  localUacBootstrapVerified:true,publisherAndReleasePinned:true,
  parentImportUpdaterAclProtected:true,processHandleBoundaryProtected:true,
  ownerApprovedDelegation:true,
};
const externalReport:ExternalRevocationAttestation={
  schema:'nexowire.access.external-epoch.v1',deviceId:device.id,
  ownerAccountId:device.ownerAccountId,ownerEpoch:4,grantGeneration:8,
  revoked:false,observedAt:NOW.toISOString(),
};
const anchors:TrustedEffectiveAnchor={
  nativeProtectedCollectorPublicKey:nativeSigner.publicKey,
  externalCasPublicKey:externalSigner.publicKey,
  expectedImageSha256:currentImage,expectedBrokerVersion:'1.0.5',
  independentlyReadOwnerEpoch:4,independentlyReadGrantGeneration:8,
  physicallyAcceptedNativeCollector:true,physicallyAcceptedExternalCas:true,
};
interface Options{
  native?:Partial<NativeAccessAttestation>;
  epoch?:Partial<ExternalRevocationAttestation>;
  trust?:Partial<TrustedEffectiveAnchor>;
  device?:ProductDeviceRecord;
  missingEvidence?:boolean;
  missingTrust?:boolean;
  ledgerImage?:string;
  ledgerGeneration?:number;
  nativeForeignKey?:boolean;
  externalForeignKey?:boolean;
  preferenceEnabled?:boolean;
}
function fixture(o:Options={}){
  const n={...nativeReport,...o.native},e={...externalReport,...o.epoch};
  const evidence={
    broker:{statement:n,signature:sign(null,nativeEffectiveSigningBytes(n),
      o.nativeForeignKey?foreignSigner.privateKey:nativeSigner.privateKey).toString('base64url')},
    epoch:{statement:e,signature:sign(null,externalEffectiveSigningBytes(e),
      o.externalForeignKey?foreignSigner.privateKey:externalSigner.privateKey).toString('base64url')},
  };
  let queries=0;
  const reader:EffectiveEvidenceReader={fetch:async()=>{
    queries++;
    return {evidence:o.missingEvidence?null:evidence,trust:o.missingTrust?null:{...anchors,...o.trust}};
  }};
  const store={getRootSessionGrant:async()=>null} as unknown as ControlPlaneStore;
  const ledgerImage=o.ledgerImage??currentImage;
  const ledger={currentCandidate:async(q:{brokerImageSha256:string;brokerVersion:string})=>
    q.brokerImageSha256===ledgerImage && q.brokerVersion==='1.0.5'
    ?{enrollmentId:'enrollment-current',generation:o.ledgerGeneration??8,
      brokerImageSha256:ledgerImage,brokerVersion:'1.0.5'}:null,
  } as unknown as D1CoreDelegationLedger;
  return {
    authority:new AccessEffectiveAuthority(store,ledger,reader,()=>NOW),
    input:{device:o.device??device,mode:'CORE' as const,session,
      corePreferenceEnabled:o.preferenceEnabled??true,bridgeDesiredMode:'on' as const},
    queries:()=>queries,
  };
}
async function denied(o:Options,reason?:string){
  const x=fixture(o),out=await x.authority.project(x.input);
  assert.equal(out.state,'PAUSED_UNVERIFIED',out.reason);
  assert.equal(out.effective,false);
  assert.equal(out.actualElevatedTokenVerified,false);
  assert.equal(out.verifiedNativeHighToken,false);
  assert.equal(out.authoritySource,'none');
  assert.equal(out.canDispatch,false);
  if(reason)assert.equal(out.reason,reason);
}
test('#669 signed current HIGH token + external CAS is a status candidate, not dispatch',async()=>{
  const x=fixture(),out=await x.authority.project(x.input);
  assert.equal(out.state,'EFFECTIVE');
  assert.equal(out.effective,true);
  assert.equal(out.verifiedNativeHighToken,true);
  assert.equal(out.canDispatch,false);
  assert.equal(x.queries(),1);
});
test('recovered Broker same version new installed SHA rejects stale signed image',async()=>{
  await denied({native:{brokerImageSha256:legacyImage}},'SIGNED_BROKER_OR_EPOCH_INVALID');
  await denied({trust:{expectedImageSha256:legacyImage}},'CORE_ENROLLMENT_REVOKED_OR_ABSENT');
  await denied({ledgerImage:legacyImage},'CORE_ENROLLMENT_REVOKED_OR_ABSENT');
  await denied({native:{brokerVersion:'1.0.4'}},'SIGNED_BROKER_OR_EPOCH_INVALID');
});
test('restored Broker without current high token or protected image chain denies',async()=>{
  for(const bad of [
    {nativeHighIntegrity:false},{administratorsEnabled:false},
    {publisherAndReleasePinned:false},{parentImportUpdaterAclProtected:false},
    {processHandleBoundaryProtected:false},{authenticatedBroker:false},
  ])await denied({native:bad},'SIGNED_BROKER_OR_EPOCH_INVALID');
});
test('unauthenticated HTTP401 and Agent ready never substitute for signed Broker health',async()=>{
  const spoof={...device,adminBridgeReady:true,brokerHttpStatus:401,
    brokerListener:true,requestedCore:true,claimedCoreEffective:true} as unknown as ProductDeviceRecord;
  await denied({device:spoof,missingEvidence:true},'INDEPENDENT_PROOF_MISSING');
  await denied({device:spoof,native:{authenticatedBroker:false}},'SIGNED_BROKER_OR_EPOCH_INVALID');
  await denied({device:spoof,trust:{physicallyAcceptedNativeCollector:false}},'INDEPENDENT_PROOF_MISSING');
});
test('stale consent.exe visible does not prove local UAC bootstrap',async()=>{
  const spoof={...device,consentExeSeen:true,consentTimestamp:NOW.toISOString(),
    http401:true,coreBadge:'CORE YÖNETİCİ ETKİN'} as unknown as ProductDeviceRecord;
  await denied({device:spoof,missingEvidence:true},'INDEPENDENT_PROOF_MISSING');
  await denied({device:spoof,native:{localUacBootstrapVerified:false}},'SIGNED_BROKER_OR_EPOCH_INVALID');
  await denied({device:spoof,native:{ownerApprovedDelegation:false}},'SIGNED_BROKER_OR_EPOCH_INVALID');
});
test('rollback of owner epoch or grant generation against external high-watermark denies',async()=>{
  await denied({trust:{independentlyReadOwnerEpoch:5}},'SIGNED_BROKER_OR_EPOCH_INVALID');
  await denied({trust:{independentlyReadGrantGeneration:9}},'SIGNED_BROKER_OR_EPOCH_INVALID');
  await denied({native:{ownerEpoch:5}},'SIGNED_BROKER_OR_EPOCH_INVALID');
  await denied({epoch:{ownerEpoch:5}},'SIGNED_BROKER_OR_EPOCH_INVALID');
  await denied({native:{grantGeneration:9},epoch:{grantGeneration:9},
    trust:{independentlyReadGrantGeneration:9}},'CORE_REVOKED_OR_GENERATION_CHANGED');
});
test('forged signature, shared trust root or explicit revoke cannot be EFFECTIVE',async()=>{
  await denied({nativeForeignKey:true},'SIGNED_BROKER_OR_EPOCH_INVALID');
  await denied({externalForeignKey:true},'SIGNED_BROKER_OR_EPOCH_INVALID');
  await denied({trust:{externalCasPublicKey:nativeSigner.publicKey}},'SIGNED_BROKER_OR_EPOCH_INVALID');
  await denied({epoch:{revoked:true}},'SIGNED_BROKER_OR_EPOCH_INVALID');
});
test('decorative UI badge is never read to authorize CORE EFFECTIVE',async()=>{
  const forged=new Proxy(device,{get(target,property,receiver){
    if(property==='persistentMaintenance'||property==='coreBadge'||
       property==='coreEffective'||property==='consentExeSeen'){
      throw new Error('UNTRUSTED_BADGE_READ');
    }
    return Reflect.get(target,property,receiver);
  }});
  await denied({device:forged,missingEvidence:true},'INDEPENDENT_PROOF_MISSING');
  await denied({device:forged,native:{nativeHighIntegrity:false}},'SIGNED_BROKER_OR_EPOCH_INVALID');
});
test('requested CORE, missing proof, disabled preference or offline SAFE never green',async()=>{
  await denied({missingEvidence:true},'INDEPENDENT_PROOF_MISSING');
  await denied({preferenceEnabled:false},'CORE_ENROLLMENT_REVOKED_OR_ABSENT');
  await denied({device:{...device,online:false}},'DEVICE_OR_BRIDGE_NOT_READY');
  await denied({device:{...device,accessMode:'safe'}},'DEVICE_OR_BRIDGE_NOT_READY');
});
