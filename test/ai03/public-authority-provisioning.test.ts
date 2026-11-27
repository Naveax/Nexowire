import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import {reviewPublicProvisioning} from '../../scripts/review-public-authority-provisioning.js';

const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
function key(label:string,algorithm:'ed25519'|'ec'='ed25519'){
  const pair=algorithm==='ed25519'?generateKeyPairSync('ed25519'):
    generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const der=pair.publicKey.export({type:'spki',format:'der'});
  return {publicSpkiBase64:der.toString('base64'),spkiSha256:createHash('sha256').update(der).digest('hex'),
    registrationReceiptSha256:hash(label+' registration')};
}
function signer(label:string){return {...key(label),serviceIdentity:label,
  custodyReceiptSha256:hash(label+' custody')};}
function fixture(){
  const f={version:1,owner:{ownerAccountId:'owner-fixture-0001',ownerEpoch:5,deviceId:randomUUID(),
    installationId:randomUUID(),installationLineageId:randomUUID(),enrollmentId:randomUUID(),
    grantGeneration:7,revokeEpoch:2,windowsUserSid:'S-1-5-21-101-202-303-1001',
    mappingReceiptSha256:hash('mapping')},
    directory:{directoryId:randomUUID(),generation:9,directoryHead:hash('V3 head'),
      registrationSha256:hash('1367 record'),restoreEpoch:randomUUID(),continuityReceiptSha256:hash('continuity')},
    authority:{authorityId:randomUUID(),storeId:randomUUID(),scheduledAuthorityId:randomUUID(),
      scheduledStoreId:randomUUID(),approvalAuthorityId:randomUUID(),anchorReceiptSha256:hash('anchor')},
    enrollmentKey:key('enrollment'),authenticator:{...key('authenticator','ec'),
      rpId:'core.fixture.invalid',credentialId:'AA'},
    signers:{recoveryAck:signer('recoveryAck'),recoveryObserver:signer('recoveryObserver'),
      scheduledForward:signer('scheduledForward'),scheduledRelease:signer('scheduledRelease'),
      coreDispatch:signer('coreDispatch'),coreNativeObserver:signer('coreNativeObserver'),
      helperObserver:signer('helperObserver'),ownerDirectory:signer('ownerDirectory'),
      restoreWitness:signer('restoreWitness'),hostedVerifier:signer('hostedVerifier')},
    hostedVerifier:{origin:'https://fixture.invalid/',serverSpkiSha256:hash('server'),
      clientCertificateSha256:hash('client cert'),caCertificateSha256:hash('CA'),
      principalRegistrationReceiptSha256:hash('principal')},
    publisher:{NEXOWIRE_WINDOWS_JOB_PUBLISHER_THUMBPRINT:'a'.repeat(40),
      NEXOWIRE_WINDOWS_JOB_SIGNER_SHA256:hash('publisher cert'),
      NEXOWIRE_WINDOWS_JOB_PUBLISHER_SUBJECT:'CN=Fixture',
      NEXOWIRE_WINDOWS_JOB_ARTIFACT_SHA256:hash('artifact'),
      NEXOWIRE_WINDOWS_SIGNTOOL_PATH:'C:\\SDK\\bin\\signtool.exe',
      signedArtifactReceiptSha256:hash('reviewed artifact')}};
  // Synthetic independently sourced record shapes; no actual registration.
  const scope={ownerAccountId:f.owner.ownerAccountId,ownerEpoch:String(f.owner.ownerEpoch),
    deviceId:f.owner.deviceId,installationLineageId:f.owner.installationLineageId,
    directoryHead:f.directory.directoryHead,authorityId:f.authority.authorityId};
  return {...f,bindings:{
    recovery:{...scope,storeId:f.authority.storeId,ackSpkiSha256:f.signers.recoveryAck.spkiSha256,
      observerSpkiSha256:f.signers.recoveryObserver.spkiSha256},
    scheduled:{...scope,authorityId:f.authority.scheduledAuthorityId,storeId:f.authority.scheduledStoreId,
      forwardSpkiSha256:f.signers.scheduledForward.spkiSha256,releaseSpkiSha256:f.signers.scheduledRelease.spkiSha256},
    core:{...scope,installationId:f.owner.installationId,enrollmentId:f.owner.enrollmentId,
      issuerSpkiSha256:f.enrollmentKey.spkiSha256,dispatchSpkiSha256:f.signers.coreDispatch.spkiSha256,
      nativeObserverSpkiSha256:f.signers.coreNativeObserver.spkiSha256,
      helperObserverSpkiSha256:f.signers.helperObserver.spkiSha256,directoryGeneration:f.directory.generation,
      registrationSha256:f.directory.registrationSha256}}};
}
test('complete synthetic public records produce only a nonauthorizing review receipt',()=>{
  const f=fixture(),r=reviewPublicProvisioning(f);
  assert.equal(r.status,'PUBLIC_RECORDS_MATCH_UNVERIFIED');
  assert.equal(r.ownerEpochDecimal,'5');assert.equal(r.signingDomains,10);
  for(const k of ['providerVerified','consentVerified','coreAuthority','recoveryAuthorized',
    'activationAuthorized','releaseAuthorized'] as const)assert.equal(r[k],false);
  assert.equal(r.physicalAcceptance,'NOT_PROVEN');
  assert.equal(r.publicConfigurationSha256,reviewPublicProvisioning(structuredClone(f)).publicConfigurationSha256);
  assert.ok(!JSON.stringify(r).includes(f.enrollmentKey.publicSpkiBase64));
  assert.ok(!JSON.stringify(r).includes(f.owner.ownerAccountId));
  assert.ok(!JSON.stringify(r).includes(f.hostedVerifier.origin));
});
test('cross-domain SPKI reuse is rejected even with distinct service and receipt labels',()=>{
  const f=fixture(),k=f.signers.recoveryAck;
  f.signers.scheduledForward={...f.signers.scheduledForward,
    publicSpkiBase64:k.publicSpkiBase64,spkiSha256:k.spkiSha256};
  assert.throws(()=>reviewPublicProvisioning(f),/PUBLIC_PROVISIONING_SIGNER_REUSE/);
  const g=fixture();g.enrollmentKey={...g.enrollmentKey,
    publicSpkiBase64:g.signers.coreDispatch.publicSpkiBase64,spkiSha256:g.signers.coreDispatch.spkiSha256};
  assert.throws(()=>reviewPublicProvisioning(g),/PUBLIC_PROVISIONING_SIGNER_REUSE/);
});
test('invalid public DER, private DER, wrong algorithm and wrong pin are rejected',()=>{
  const f=fixture();
  f.signers.coreDispatch.spkiSha256=hash('wrong pin');
  assert.throws(()=>reviewPublicProvisioning(f),/PUBLIC_PROVISIONING_SPKI_INVALID/);
  const g=fixture(),privateDer=generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'der'});
  g.enrollmentKey={...g.enrollmentKey,publicSpkiBase64:privateDer.toString('base64'),
    spkiSha256:createHash('sha256').update(privateDer).digest('hex')};
  assert.throws(()=>reviewPublicProvisioning(g),/PUBLIC_PROVISIONING_SPKI_INVALID/);
  const h=fixture();h.authenticator={...h.authenticator,...key('wrong algorithm')};
  assert.throws(()=>reviewPublicProvisioning(h),/PUBLIC_PROVISIONING_SPKI_INVALID/);
});
test('missing scope, secret-shaped extra fields, invalid epoch and store/service collisions deny',()=>{
  const f=fixture();const {owner:_owner,...missing}=f;
  assert.throws(()=>reviewPublicProvisioning(missing),/PUBLIC_PROVISIONING_SCHEMA_INCOMPLETE_OR_INVALID/);
  assert.throws(()=>reviewPublicProvisioning({...f,privateKey:'synthetic-never-log'}),
    {message:'PUBLIC_PROVISIONING_SCHEMA_INCOMPLETE_OR_INVALID'});
  assert.throws(()=>reviewPublicProvisioning({...f,owner:{...f.owner,ownerEpoch:0}}),
    /PUBLIC_PROVISIONING_SCHEMA_INCOMPLETE_OR_INVALID/);
  assert.throws(()=>reviewPublicProvisioning({...f,authority:{...f.authority,scheduledStoreId:f.authority.storeId}}),
    /PUBLIC_PROVISIONING_STORE_IDENTITY_REUSE/);
  f.signers.hostedVerifier.serviceIdentity=f.signers.restoreWitness.serviceIdentity;
  assert.throws(()=>reviewPublicProvisioning(f),/PUBLIC_PROVISIONING_SERVICE_IDENTITY_REUSE/);
});
test('hosted origin and WebAuthn credential encoding are strictly checked',()=>{
  const f=fixture();
  for(const origin of ['http://fixture.invalid/','https://user:pass@fixture.invalid/',
    'https://fixture.invalid/path','https://fixture.invalid/?secret=x'])
    assert.throws(()=>reviewPublicProvisioning({...f,hostedVerifier:{...f.hostedVerifier,origin}}),
      /PUBLIC_PROVISIONING_HOSTED_ORIGIN_INVALID/);
  assert.throws(()=>reviewPublicProvisioning({...f,authenticator:{...f.authenticator,credentialId:'AB'}}),
    /PUBLIC_PROVISIONING_CREDENTIAL_INVALID/);
});

test('independently read records must agree on owner epoch, lineage, authority/store, enrollment and registered pins',()=>{
  const f=fixture();
  const mutate=(role:keyof typeof f.bindings,changes:object)=>({...f,bindings:{...f.bindings,[role]:{...f.bindings[role],...changes}}});
  for(const role of ['recovery','scheduled','core'] as const){
    for(const changes of [{ownerAccountId:'owner-fixture-0002'},{ownerEpoch:'4'},
      {deviceId:randomUUID()},{installationLineageId:randomUUID()},{directoryHead:hash('old head')}])
      assert.throws(()=>reviewPublicProvisioning(mutate(role,changes)),/PUBLIC_PROVISIONING_OWNER_SCOPE_MISMATCH/);
    assert.throws(()=>reviewPublicProvisioning(mutate(role,{authorityId:randomUUID()})),/PUBLIC_PROVISIONING_REGISTRATION_MISMATCH/);
  }
  for(const role of ['recovery','scheduled'] as const)
    assert.throws(()=>reviewPublicProvisioning(mutate(role,{storeId:randomUUID()})),/PUBLIC_PROVISIONING_REGISTRATION_MISMATCH/);
  for(const changes of [{installationId:randomUUID()},{enrollmentId:randomUUID()},
    {directoryGeneration:8},{registrationSha256:hash('different record')}])
    assert.throws(()=>reviewPublicProvisioning(mutate('core',changes)),/PUBLIC_PROVISIONING_REGISTRATION_MISMATCH/);
  for(const [role,field] of [['recovery','ackSpkiSha256'],['recovery','observerSpkiSha256'],
    ['scheduled','forwardSpkiSha256'],['scheduled','releaseSpkiSha256'],['core','issuerSpkiSha256'],
    ['core','dispatchSpkiSha256'],['core','nativeObserverSpkiSha256'],['core','helperObserverSpkiSha256']] as const)
    assert.throws(()=>reviewPublicProvisioning(mutate(role,{[field]:hash('wrong pin')})),/PUBLIC_PROVISIONING_REGISTERED_PIN_MISMATCH/);
});
