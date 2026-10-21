import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import path from 'node:path';
import {
 assessScopedBrokerTrust,
 type BrokerEvidenceInput,type BrokerSignatureInspector,
 type BrokerManifest,type OwnerEnrollment,
} from '../scripts/s3-hyperv-broker-trust.js';
import type {CapturedAclNode} from '../scripts/s3-windows-acl-preflight.js';
import type {S3RecoveryPins} from '../scripts/s3-crash-recovery-assessment.js';

const brokerSigner=generateKeyPairSync('ed25519');
const ownerSigner=generateKeyPairSync('ed25519');
const otherSigner=generateKeyPairSync('ed25519');
const CERT='d'.repeat(64);
const PUB='CN=Nexowire Fixture Broker Publisher';
const VM='fb72ad38-c6c1-4afa-9e03-1b19f4377392';
const OWNER='owner-fixture-01';
const DEVICE='device-fixture-01';
const now=1_800_000_000;
const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const mk=['schemaVersion','role','version','minAgentVersion','maxAgentVersion','minHubVersion',
 'maxHubVersion','publisher','brokerSha256','helperSha256','updaterSha256'];
const ek=['schemaVersion','ownerAccountId','deviceId','vmId','brokerVersion','epoch','expiresAtUnix'];
function canonical<T extends object>(o:T,keys:readonly string[]){
 const r=o as Record<string,unknown>;
 return Buffer.from(JSON.stringify(Object.fromEntries(keys.map(k=>[k,r[k]]))),'utf8');
}
function signed<T extends object>(o:T,keys:readonly string[],signer=brokerSigner){
 return sign(null,canonical(o,keys),signer.privateKey).toString('base64');
}
function makeAcl(paths:BrokerEvidenceInput['paths']):CapturedAclNode[]{
 const set=new Set<string>();
 for(const file of Object.values(paths)){
  let p=path.win32.normalize(file);
  while(true){
   set.add(p);
   const next=path.win32.dirname(p);
   if(next===p)break;
   p=next;
  }
 }
 return [...set].map(p=>({
  path:p,ownerSid:'S-1-5-32-544',isReparsePoint:false,
  entries:[
   {principalSid:'S-1-5-18',kind:'Allow',inherited:true,fileSystemRights:0x1f01ff},
   {principalSid:'S-1-5-32-544',kind:'Allow',inherited:true,fileSystemRights:0x1f01ff},
   {principalSid:'S-1-5-32-545',kind:'Allow',inherited:true,fileSystemRights:0x1200a9},
  ],
 }));
}
function fixture():{input:BrokerEvidenceInput,inspect:BrokerSignatureInspector}{
 const binaries={
  broker:Buffer.from('SIGNED_FIXTURE_ONLY_BROKER_1.0.5'),
  helper:Buffer.from('SIGNED_FIXTURE_ONLY_HYPERV_HELPER'),
  updater:Buffer.from('SIGNED_FIXTURE_ONLY_INSTALL_UPDATER'),
 };
 const manifest:BrokerManifest={
  schemaVersion:1,role:'nexowire-scoped-hyperv-broker',
  version:'1.0.5',minAgentVersion:'1.0.5',maxAgentVersion:'1.0.6',
  minHubVersion:'1.0.5',maxHubVersion:'1.0.6',publisher:PUB,
  brokerSha256:digest(binaries.broker),
  helperSha256:digest(binaries.helper),updaterSha256:digest(binaries.updater),
 };
 const enrollment:OwnerEnrollment={
  schemaVersion:1,ownerAccountId:OWNER,deviceId:DEVICE,vmId:VM,
  brokerVersion:manifest.version,epoch:4,expiresAtUnix:now+120,
 };
 const paths={
  broker:'C:\\ProgramData\\NexowireTrustedFixture\\broker\\broker.exe',
  helper:'C:\\ProgramData\\NexowireTrustedFixture\\helper\\hyperv-helper.exe',
  updater:'C:\\ProgramData\\NexowireTrustedFixture\\updater\\updater.exe',
 };
 const input:BrokerEvidenceInput={
  manifest,manifestSignature:signed(manifest,mk),
  enrollment,enrollmentSignature:signed(enrollment,ek,ownerSigner),
  pins:{
   trustedManifestPublicKeyPem:brokerSigner.publicKey.export({format:'pem',type:'spki'}).toString(),
   trustedEnrollmentPublicKeyPem:ownerSigner.publicKey.export({format:'pem',type:'spki'}).toString(),
   trustedPublisherSubject:PUB,trustedCertificateSha256:CERT,
   ownerAccountId:OWNER,deviceId:DEVICE,vmId:VM,installedAgentVersion:'1.0.5',
   installedHubVersion:'1.0.5',brokerVersion:'1.0.5',
   minIndependentEnrollmentEpoch:3,nowUnix:now,
  },
  binaries,paths,aclNodes:makeAcl(paths),
  running:{
   runningImageSha256:manifest.brokerSha256,
   creationIdentity:'trusted-fixture-native-image-identity',
   deviceId:DEVICE,brokerVersion:'1.0.5',
   nativeImageHandleVerified:true,authenticatedHealth:true,
  },
 };
 const inspect:BrokerSignatureInspector=async(_,__,sha)=>({
  fileSha256:sha,publisherSubject:PUB,certificateSha256:CERT,signatureValid:true,
 });
 return{input,inspect};
}
test('independent signed fixture evidence NEVER enables Hyper-V/UAC even with approved:true',async()=>{
 const {input,inspect}=fixture();
 for(const remoteApproved of [undefined,true,false]){
  const report=await assessScopedBrokerTrust({...input,remoteApproved},inspect);
  assert.deepEqual(report,{
   status:'source_verified_but_non_executable',localPhysicalConsent:'unverified',
   executionApproved:false,hypervStartStopEnabled:false,productionApproved:false,
  });
 }
});
test('forged Broker manifest, extra field, independent root substitution and wrong signer denied',async()=>{
 for(const mode of ['sig','extra','root','role','key','version'] as const){
  const {input,inspect}=fixture();
  if(mode==='sig')input.manifestSignature=signed({...input.manifest,brokerSha256:'f'.repeat(64)},mk);
  if(mode==='extra')(input.manifest as unknown as Record<string,unknown>).elevate=true;
  if(mode==='root')input.pins.trustedManifestPublicKeyPem=otherSigner.publicKey.export({format:'pem',type:'spki'}).toString();
  if(mode==='role')(input.manifest as unknown as Record<string,unknown>).role='arbitrary-shell-broker';
  if(mode==='key')input.pins.trustedManifestPublicKeyPem='untrusted';
  if(mode==='version')input.pins.installedAgentVersion='1.0.4';
  await assert.rejects(assessScopedBrokerTrust(input,inspect),/S3_HYPERV_/);
 }
});
test('owner-scoped enrollment needs independent owner signature, immutable VM GUID, epoch and freshness',async()=>{
 for(const mode of ['wrongOwner','foreignDevice','otherVM','wildcard','expired','stale','tooLong','sig','unknownKey'] as const){
  const {input,inspect}=fixture();
  if(mode==='wrongOwner')input.enrollment.ownerAccountId='foreign-owner';
  if(mode==='foreignDevice')input.enrollment.deviceId='foreign-device';
  if(mode==='otherVM')input.enrollment.vmId='12345678-1234-4234-8234-123456789abc';
  if(mode==='wildcard')input.enrollment.vmId='*';
  if(mode==='expired')input.enrollment.expiresAtUnix=now-1;
  if(mode==='stale')input.enrollment.epoch=2;
  if(mode==='tooLong')input.enrollment.expiresAtUnix=now+40000;
  if(mode==='sig')input.enrollmentSignature=signed({...input.enrollment,epoch:9},ek,ownerSigner);
  if(mode==='unknownKey')input.pins.trustedEnrollmentPublicKeyPem=otherSigner.publicKey.export({format:'pem',type:'spki'}).toString();
  await assert.rejects(assessScopedBrokerTrust(input,inspect),/S3_HYPERV_/);
 }
});
test('unsigned or wrong publisher/certificate on Broker/helper/updater denied independently',async()=>{
 for(const kind of ['broker','helper','updater'] as const){
  for(const altered of ['unsigned','publisher','certificate','hash'] as const){
   const {input,inspect}=fixture();
   const bad:BrokerSignatureInspector=async(k,p,h)=>{
    const original=await inspect(k,p,h);
    if(k!==kind)return original;
    if(altered==='unsigned')return {...original,signatureValid:false};
    if(altered==='publisher')return {...original,publisherSubject:'CN=Foreign Publisher'};
    if(altered==='certificate')return {...original,certificateSha256:'e'.repeat(64)};
    return {...original,fileSha256:'b'.repeat(64)};
   };
   await assert.rejects(assessScopedBrokerTrust(input,bad),/S3_HYPERV_BROKER_HELPER_UPDATER_PUBLISHER_MISMATCH/);
  }
 }
});
test('tampered bytes or version mismatch are blocked before any native helper inspection',async()=>{
 for(const kind of ['broker','helper','updater'] as const){
  const {input,inspect}=fixture();
  input.binaries[kind]=Buffer.concat([input.binaries[kind],Buffer.from('FORGED')]);
  let called=0;
  await assert.rejects(assessScopedBrokerTrust(input,async(...a)=>{
   called++;return inspect(...a);
  }),/S3_HYPERV_SIGNED_BINARY_HASH_MISMATCH/);
  // A later item could have been scanned, but no virtual machine ran.
  assert.ok(called<=2);
 }
 const {input,inspect}=fixture();
 input.pins.installedHubVersion='1.0.3';
 await assert.rejects(assessScopedBrokerTrust(input,inspect),
  /S3_HYPERV_BROKER_AGENT_HUB_VERSION_MISMATCH/);
});
test('updater and parent ACL coverage cannot be omitted or weakened by Deny ACE',async()=>{
 for(const mode of ['parent','updater','writable','reparse','owner','dangerousDeny'] as const){
  const {input,inspect}=fixture();
  if(mode==='parent')input.aclNodes=input.aclNodes.filter(n=>n.path!=='C:\\ProgramData');
  if(mode==='updater')input.aclNodes=input.aclNodes.filter(n=>n.path!==input.paths.updater);
  if(mode==='writable')input.aclNodes=[...input.aclNodes,{
   path:'C:\\ProgramData\\NexowireTrustedFixture\\broker\\other-import.js',
   ownerSid:'S-1-5-32-544',isReparsePoint:false,
   entries:[{principalSid:'S-1-5-11',kind:'Allow',inherited:true,fileSystemRights:0x1301bf}],
  }];
  if(mode==='reparse')input.aclNodes=input.aclNodes.map(n=>
   n.path===input.paths.broker?{...n,isReparsePoint:true}:n);
  if(mode==='owner')input.aclNodes=input.aclNodes.map(n=>
   n.path===input.paths.helper?{...n,ownerSid:'S-1-5-21-1-2-3-4'}:n);
  if(mode==='dangerousDeny')input.aclNodes=input.aclNodes.map(n=>
   n.path===input.paths.updater?{...n,entries:[
    ...n.entries,
    {principalSid:'S-1-5-11',kind:'Deny' as const,inherited:false,fileSystemRights:0x1f01ff},
    {principalSid:'S-1-5-11',kind:'Allow' as const,inherited:true,fileSystemRights:0x00000002},
   ]}:n);
  await assert.rejects(assessScopedBrokerTrust(input,inspect),/S3_/);
 }
});
test('running Broker image identity cannot be inferred from version, PID or health alone',async()=>{
 for(const field of ['runningImageSha256','nativeImageHandleVerified','authenticatedHealth','creationIdentity','deviceId','brokerVersion'] as const){
  const {input,inspect}=fixture();
  (input.running as unknown as Record<string,unknown>)[field]=field==='runningImageSha256'?
   'f'.repeat(64):field==='creationIdentity'?'pid-123':field==='deviceId'?'foreign-device':
   field==='brokerVersion'?'1.0.4':false;
  await assert.rejects(assessScopedBrokerTrust(input,inspect),
   /S3_HYPERV_RUNNING_BROKER_IDENTITY_INVALID/);
 }
});
test('startup crash, stale rollback and local journal replay prohibit Broker and VM mutation',async()=>{
 const {input,inspect}=fixture();
 const pins:S3RecoveryPins={
  transactionId:'vm-fixture-txn',ownerAccountId:OWNER,deviceId:DEVICE,
  oldAgentVersion:'1.0.5',targetAgentVersion:'1.0.6',
  hubVersion:'1.0.5',oldArtifactSha256:'a'.repeat(64),
  targetArtifactSha256:'b'.repeat(64),installerHelperSha256:'c'.repeat(64),
  minimumIndependentSequence:7,
 };
 const journal={
  schemaVersion:1,transactionId:pins.transactionId,ownerAccountId:OWNER,deviceId:DEVICE,
  oldAgentVersion:'1.0.5',targetAgentVersion:'1.0.6',hubVersion:'1.0.5',
  oldArtifactSha256:pins.oldArtifactSha256,targetArtifactSha256:pins.targetArtifactSha256,
  installerHelperSha256:pins.installerHelperSha256,sequence:6,phase:'rollback_start_started',
 };
 for(const phase of ['signed_stage_ready','target_start_started','rollback_start_started']){
  for(const seq of [6,7]){
   await assert.rejects(assessScopedBrokerTrust({
    ...input,remoteApproved:true,interruptedInstall:{
     journal:{...journal,phase,sequence:seq},pins,
    },
   },inspect),/S3_HYPERV_STARTUP_CRASH_MANUAL_VM_RECONCILIATION_REQUIRED/);
  }
 }
});
