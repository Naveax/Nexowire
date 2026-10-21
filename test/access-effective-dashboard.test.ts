import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {MemoryControlPlaneStore} from '../src/product/memory-control-plane-store.js';
import {ControlPlaneService,type ControlPlaneIdentity} from '../src/product/control-plane-service.js';
import {
 AccessEffectiveAuthority,nativeEffectiveSigningBytes,externalEffectiveSigningBytes,
 type EffectiveEvidenceReader,type NativeAccessAttestation,type ExternalRevocationAttestation,
} from '../src/product/access-effective-authority.js';
import type {D1CoreDelegationLedger} from '../src/security/core-admin-delegation.js';
const clock=new Date('2026-10-21T15:00:00.000Z');
const signer=generateKeyPairSync('ed25519');
const cas=generateKeyPairSync('ed25519');
const image='b'.repeat(64);
const sid='11111111-1111-4111-8111-111111111111';
const sessionHash=createHash('sha256').update(sid).digest('hex');
const owner:ControlPlaneIdentity={
 accountId:'owner',role:'user',sessionId:sid,
 sessionExpiresAt:'2026-10-22T15:00:00.000Z',
};
test('Access owner dashboard uses separately signed native+CAS and real signed login, never raw Agent ready',async()=>{
 const store=new MemoryControlPlaneStore();
 const noProvider=new ControlPlaneService(store,{now:()=>clock});
 await noProvider.ensureAccount({id:'owner'});
 const challenge=await noProvider.beginPairing(owner,'effective-target');
 const {device:paired}=await noProvider.consumePairing({
  pairingId:challenge.pairingId,token:challenge.token,
  platform:'win32',deviceAnchorHash:'a'.repeat(64),
 });
 await noProvider.setDeviceAccessMode(owner,paired.id,'full');
 const d=await store.getDevice(paired.id);
 assert.ok(d);
 await store.putDevice({...d,online:true,privilegeMode:'broker',adminBridgeReady:true});
 await noProvider.setDeviceCorePreference(owner,paired.id,true);
 const before=(await noProvider.dashboard(owner)).devices[0]!;
 assert.equal(before.persistentMaintenance.enabled,true);
 assert.equal(before.persistentMaintenance.effective,false);
 assert.equal(before.persistentMaintenance.active,false);
 const nativeReport:NativeAccessAttestation={
  schema:'nexowire.access.native-effective.v1',mode:'CORE',
  deviceId:paired.id,ownerAccountId:'owner',
  credentialHash:d.credentialHash,sessionHash,
  ownerEpoch:4,grantGeneration:8,
  rootIssuedAt:null,rootExpiresAt:null,enrollmentId:'enrollment-a',
  brokerImageSha256:image,brokerVersion:'1.0.5',observedAt:clock.toISOString(),
  nativeHighIntegrity:true,administratorsEnabled:true,authenticatedBroker:true,
  localUacBootstrapVerified:true,publisherAndReleasePinned:true,
  parentImportUpdaterAclProtected:true,processHandleBoundaryProtected:true,
  ownerApprovedDelegation:true,
 };
 const witness:ExternalRevocationAttestation={
  schema:'nexowire.access.external-epoch.v1',
  deviceId:paired.id,ownerAccountId:'owner',ownerEpoch:4,grantGeneration:8,
  revoked:false,observedAt:clock.toISOString(),
 };
 let revoked=false;
 const reader:EffectiveEvidenceReader={fetch:async()=>({
  evidence:{
   broker:{statement:nativeReport,signature:sign(null,
     nativeEffectiveSigningBytes(nativeReport),signer.privateKey).toString('base64url')},
   epoch:{statement:{...witness,revoked},signature:sign(null,
     externalEffectiveSigningBytes({...witness,revoked}),cas.privateKey).toString('base64url')},
  },
  trust:{
   nativeProtectedCollectorPublicKey:signer.publicKey,externalCasPublicKey:cas.publicKey,
   expectedImageSha256:image,expectedBrokerVersion:'1.0.5',
   independentlyReadOwnerEpoch:4,independentlyReadGrantGeneration:8,
   physicallyAcceptedNativeCollector:true,physicallyAcceptedExternalCas:true,
  },
 })};
 const ledger={currentCandidate:async()=>({
  enrollmentId:'enrollment-a',generation:8,
  deviceId:paired.id,ownerAccountId:'owner',credentialHash:d.credentialHash,
  brokerImageSha256:image,brokerVersion:'1.0.5',
  signerKeySha256:'c'.repeat(64),localConsentEvidenceSha256:'d'.repeat(64),
  enrolledAt:'2026-10-20T15:00:00.000Z',productionPrivilegeAttested:false,
 })} as unknown as D1CoreDelegationLedger;
 const projected=new ControlPlaneService(store,{
  now:()=>clock,
  effectiveAuthority:new AccessEffectiveAuthority(store,ledger,reader,()=>clock),
 });
 const current=(await projected.dashboard(owner)).devices[0]!;
 assert.equal(current.persistentMaintenance.active,true);
 assert.equal(current.persistentMaintenance.effective,true);
 assert.equal(current.persistentMaintenance.authoritySource,'independent-protected-windows-broker');
 assert.equal(current.persistentMaintenance.actualElevatedTokenVerified,true);
 // A new external revocation witness supersedes the earlier signed proof.
 revoked=true;
 assert.equal((await projected.dashboard(owner)).devices[0]!.persistentMaintenance.effective,false);
 revoked=false;
 await projected.logoutControlPlaneSession(owner);
 assert.equal((await projected.dashboard(owner)).devices[0]!.persistentMaintenance.effective,false);
 // Preference OFF and SAFE never re-activate even if stale signed Native proof is present.
 await projected.setDeviceCorePreference(owner,paired.id,false);
 assert.equal((await projected.dashboard(owner)).devices[0]!.persistentMaintenance.effective,false);
 await projected.setDeviceAccessMode(owner,paired.id,'safe');
 assert.equal((await projected.dashboard(owner)).devices[0]!.persistentMaintenance.effective,false);
});

test('dashboard CORE effective cannot be supplied as request preference or Agent status',async()=>{
 const store=new MemoryControlPlaneStore();
 const service=new ControlPlaneService(store,{now:()=>clock});
 await service.ensureAccount({id:'owner'});
 const challenge=await service.beginPairing(owner,'normal-user-device');
 const {device}=await service.consumePairing({
  pairingId:challenge.pairingId,token:challenge.token,
  platform:'win32',deviceAnchorHash:'f'.repeat(64),
 });
 await service.setDeviceAccessMode(owner,device.id,'full');
 const d=await store.getDevice(device.id);
 assert.ok(d);
 await store.putDevice({...d,online:true,privilegeMode:'broker',adminBridgeReady:true});
 await service.setDeviceCorePreference(owner,device.id,true);
 // Old deployments without 0019 revocation migration must not acquire a
 // new dependency from the optional Effective Authority integration.
 store.isControlPlaneSessionRevoked=async()=>{throw Error('MIGRATION_NOT_DEPLOYED')};
 const status=(await service.dashboard(owner)).devices[0]!;
 assert.equal(status.persistentMaintenance.active,false);
 assert.equal(status.persistentMaintenance.actualElevatedTokenVerified,false);
 assert.equal(status.persistentMaintenance.authoritySource,'none');
});
