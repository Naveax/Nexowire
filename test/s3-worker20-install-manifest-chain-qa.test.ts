/** Worker #20, independent source-only manifest/import/rollback/migration QA. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {assessSourceOnlyInstallManifestChain,encodeSourceManifest,
 encodeSourceBundle,encodeSourceWitness,
 type SourceChainInput,type SourceFileCapture,type SourceInstallManifest,
 type SourceRelease,type SourceSnapshot,type ReinstallWitness}
 from '../scripts/s3-worker20-install-manifest-chain-qa.js';
import type {CapturedAclNode} from '../scripts/s3-windows-acl-preflight.js';

const sha=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');
const targetKey=generateKeyPairSync('ed25519');
const rollbackKey=generateKeyPairSync('ed25519');
const witnessKey=generateKeyPairSync('ed25519');
const hostileKey=generateKeyPairSync('ed25519');
const pem=(key:typeof targetKey)=>key.publicKey.export({format:'pem',type:'spki'}).toString();
const publisher='CN=PINNED-NEXOWIRE-SOURCE-FIXTURE';
const cert=sha('synthetic-der-cert-w20-chain');
const owner='fixture-owner-w20';
const device='fixture-device-w20';
const root='C:\\ProtectedFixture\\Nexowire';
const targetRoot=root+'\\target';
const rollbackRoot=root+'\\rollback';
const OS_ID='S-1-5-18';
const ADM_ID='S-1-5-32-544';
const users='S-1-5-32-545';
function aclFor(...files:string[]):CapturedAclNode[]{
 const all=new Set<string>();
 for(let file of files){
  while(true){all.add(file);const parent=path.win32.dirname(file);
   if(parent===file)break;file=parent;}
 }
 return [...all].map(file=>({
  path:file,ownerSid:ADM_ID,isReparsePoint:false,
  entries:[{principalSid:OS_ID,kind:'Allow' as const,fileSystemRights:0x1f01ff,inherited:true},
   {principalSid:ADM_ID,kind:'Allow' as const,fileSystemRights:0x1f01ff,inherited:true},
   {principalSid:users,kind:'Allow' as const,fileSystemRights:0x1200a9,inherited:true}],
 }));
}
function file(filename:string,kind:SourceFileCapture['kind']):SourceFileCapture{
 const f:SourceFileCapture={path:filename,kind,
  bytes:Buffer.from('FAKE_W20:'+filename),linkCount:1,isReparsePoint:false};
 if(kind==='pe')f.signature={valid:true,subject:publisher,certificateSha256:cert};
 return f;
}
function snapshot(files:SourceFileCapture[]):SourceSnapshot{
 return {
  enumerationComplete:true,unknownDynamicImports:false,
  files:files.map(f=>({...f,bytes:Buffer.from(f.bytes),
   signature:f.signature?{...f.signature}:undefined})),
  aclNodes:aclFor(...files.map(f=>f.path)),
 };
}
function mkRelease(
 role:SourceInstallManifest['role'],version:string,location:string,
 names:readonly [string,SourceFileCapture['kind'],readonly string[]][],
 key:typeof targetKey,
):SourceRelease{
 const files=names.map(([name,kind])=>file(location+'\\'+name,kind));
 const manifest:SourceInstallManifest={
  schemaVersion:1,role,version,ownerAccountId:owner,deviceId:device,
  hubMinVersion:'1.0.5',hubMaxVersion:'1.0.6',
  entrypoint:files[0]!.path,bundleSha256:sha(encodeSourceBundle(files)),
  files:files.map((f,i)=>({
   path:f.path,kind:f.kind,sha256:sha(f.bytes),
   imports:names[i]![2].map(name=>location+'\\'+name),
  })),
 };
 const before=snapshot(files),after=snapshot(files);
 return {manifest,signature:sign(null,encodeSourceManifest(manifest),key.privateKey)
  .toString('base64'),bundleBytes:encodeSourceBundle(files),before,after};
}
function fixture():SourceChainInput{
 const target=mkRelease('target-broker','1.0.6',targetRoot,[
  ['bin\\broker.exe','pe',['bin\\support.dll','lib\\bootstrap.js']],
  ['bin\\support.dll','pe',['config\\rules.json']],
  ['lib\\bootstrap.js','script',['config\\rules.json']],
  ['config\\rules.json','data',[]],
 ],targetKey);
 const rollback=mkRelease('rollback-agent','1.0.5',rollbackRoot,[
  ['agent\\cli.js','script',['agent\\health.js','config\\agent.json']],
  ['agent\\health.js','script',['config\\agent.json']],
  ['config\\agent.json','data',[]],
 ],rollbackKey);
 const witness:ReinstallWitness={
  schemaVersion:1,role:'owner-offline-reinstall',
  ownerAccountId:owner,deviceId:device,
  priorAgentVersion:'1.0.5',targetAgentVersion:'1.0.6',hubVersion:'1.0.5',
  priorOwnerEpoch:41,newOwnerEpoch:43,witnessSequence:100,
  oldEnrollmentId:'old-install-w20',newEnrollmentId:'new-install-w20',
  oldDpapiBlobSha256:sha('old-protected-dpapi-blob'),
  newDpapiBlobSha256:sha('new-protected-dpapi-blob'),
  oldKeyRevocationObserved:true,pendingUnknownMutation:false,
  originalAgentPreservedUntilHandoff:true,
  targetManifestSha256:sha(encodeSourceManifest(target.manifest)),
  rollbackManifestSha256:sha(encodeSourceManifest(rollback.manifest)),
  requiresFreshOwnerLocalConsent:true,
 };
 return {
  target,rollback,witness,
  witnessSignature:sign(null,encodeSourceWitness(witness),witnessKey.privateKey)
   .toString('base64'),
  pins:{
   ownerAccountId:owner,deviceId:device,
   hubVersion:'1.0.5',oldAgentVersion:'1.0.5',targetAgentVersion:'1.0.6',
   targetRoot,rollbackRoot,
   targetManifestSha256:witness.targetManifestSha256,
   rollbackManifestSha256:witness.rollbackManifestSha256,
   targetBundleSha256:target.manifest.bundleSha256,
   rollbackBundleSha256:rollback.manifest.bundleSha256,
   targetManifestPublicKeyPem:pem(targetKey),
   rollbackManifestPublicKeyPem:pem(rollbackKey),
   independentWitnessPublicKeyPem:pem(witnessKey),
   publisherSubject:publisher,signerCertificateSha256:cert,
   lastEnrollmentId:witness.oldEnrollmentId,
   lastDpapiBlobSha256:witness.oldDpapiBlobSha256,
   minimumNewOwnerEpoch:43,minimumWitnessSequence:100,
  },
  nativeClaims:{provider:'fully-forged-source-mock',systemSid:'S-1-5-18',
   highToken:true,dpapiUnsealed:true,uacApproved:true},
 };
}
function resignWitness(e:SourceChainInput):void{
 e.witnessSignature=sign(null,encodeSourceWitness(e.witness),witnessKey.privateKey)
  .toString('base64');
}
function resignManifest(e:SourceChainInput,side:'target'|'rollback'):void{
 const release=e[side],key=side==='target'?targetKey:rollbackKey;
 const digest=sha(encodeSourceManifest(release.manifest));
 release.signature=sign(null,encodeSourceManifest(release.manifest),key.privateKey)
  .toString('base64');
 if(side==='target'){e.pins.targetManifestSha256=digest;e.witness.targetManifestSha256=digest;}
 else{e.pins.rollbackManifestSha256=digest;e.witness.rollbackManifestSha256=digest;}
 resignWitness(e);
}
const denied=(mutate:(x:SourceChainInput)=>void,code:RegExp)=>{
 const e=fixture();mutate(e);
 assert.throws(()=>assessSourceOnlyInstallManifestChain(e),code);
};
test('w20 chain: complete signed source fixtures still deny install, SYSTEM and CORE',()=>{
 const e=fixture();
 const proof=assessSourceOnlyInstallManifestChain(e);
 assert.equal(proof.status,'synthetic_signed_manifest_chain_checked');
 assert.equal(proof.importGraphCoverage,'declared_fixture_only');
 for(const field of ['nativeOsProofAccepted','systemHighTokenAccepted',
  'dpapiUnsealAccepted','localUacAccepted','mayInstall',
  'mayEnableCore','mayMigrateAgent','productionAccepted'] as const){
  assert.equal(proof[field],false);
 }
 e.nativeClaims={provider:'trusted-win32-token',systemSid:'S-1-5-18',
  highToken:true,dpapiUnsealed:true,uacApproved:true};
 assert.equal(assessSourceOnlyInstallManifestChain(e).systemHighTokenAccepted,false);
});
test('w20 chain: signer substitutions and signed manifest corruption fail closed',()=>{
 denied(e=>{e.target.signature=sign(null,encodeSourceManifest(e.target.manifest),
  hostileKey.privateKey).toString('base64');},/W20_CHAIN_SIGNATURE_INVALID/);
 denied(e=>{e.rollback.signature=sign(null,encodeSourceManifest(e.rollback.manifest),
  hostileKey.privateKey).toString('base64');},/W20_CHAIN_SIGNATURE_INVALID/);
 denied(e=>{e.pins.targetManifestPublicKeyPem=pem(hostileKey)},
  /W20_CHAIN_SIGNATURE_INVALID/);
 denied(e=>{e.rollback.manifest.ownerAccountId='other-owner'},
  /W20_CHAIN_MANIFEST_POLICY_MISMATCH/);
 denied(e=>{e.pins.rollbackManifestSha256=sha('other-manifest')},
  /W20_CHAIN_MANIFEST_POLICY_MISMATCH/);
});
test('w20 chain: every declared PE in transitive import closure requires exact signer and SHA',()=>{
 for(const side of ['target'] as const){
  for(const index of [0,1]){
   denied(e=>{e[side].before.files[index]!.signature!.certificateSha256=sha('other-cert')},
    /W20_CHAIN_PE_PUBLISHER_OR_CERT_UNTRUSTED/);
   denied(e=>{e[side].after.files[index]!.signature!.subject='CN=Other Publisher'},
    /W20_CHAIN_PE_PUBLISHER_OR_CERT_UNTRUSTED/);
   denied(e=>{e[side].after.files[index]!.bytes=Buffer.from('modified-native-image')},
    /W20_CHAIN_IMPORT_FILE_HASH_OR_TYPE_MISMATCH/);
  }
 }
});
test('w20 chain: missing, extra, duplicate and changed import closure cannot self-certify',()=>{
 denied(e=>{e.target.before.files.pop()},/W20_CHAIN_TREE_INCOMPLETE/);
 denied(e=>{e.target.after.files.push(file(targetRoot+'\\extra.dll','pe'))},
  /W20_CHAIN_TREE_INCOMPLETE/);
 denied(e=>{e.target.after.files[1]!.path=e.target.after.files[0]!.path},
  /W20_CHAIN_DUPLICATE_OR_EXTRA_FILE/);
 denied(e=>{e.target.before.unknownDynamicImports=true},/W20_CHAIN_TREE_INCOMPLETE/);
 denied(e=>{e.target.after.enumerationComplete=false},/W20_CHAIN_TREE_INCOMPLETE/);
 denied(e=>{e.target.manifest.files[0]!.imports.push(targetRoot+'\\missing.dll');
  resignManifest(e,'target')},/W20_CHAIN_UNRESOLVED_IMPORT/);
 denied(e=>{e.target.manifest.files[0]!.imports=[];resignManifest(e,'target')},
  /W20_CHAIN_UNREACHABLE_IMPORT_OR_EXTRA_PAYLOAD/);
});
test('w20 chain: ADS, parent escape, junctions, hardlinks and path aliases fail',()=>{
 denied(e=>{e.target.after.files[0]!.path+=':other'},/W20_CHAIN_PATH_INVALID/);
 denied(e=>{e.target.after.files[0]!.path='D:\\Other\\broker.exe'},
  /W20_CHAIN_PATH_OUTSIDE_PINNED_ROOT/);
 denied(e=>{e.target.before.files[0]!.isReparsePoint=true},
  /W20_CHAIN_UNSAFE_FILE_IDENTITY/);
 denied(e=>{e.rollback.after.files[0]!.linkCount=2},
  /W20_CHAIN_UNSAFE_FILE_IDENTITY/);
 denied(e=>{e.target.before.files[0]!.path=targetRoot+'\\bin\\..\\bin\\broker.exe'},
  /W20_CHAIN_PATH_INVALID/);
});
test('w20 chain: protected ancestors, updater-equivalent import and ACL deny/allow collision',()=>{
 denied(e=>{e.target.after.aclNodes=e.target.after.aclNodes.filter(x=>
  x.path!==root)},/W20_CHAIN_ACL_INCOMPLETE/);
 denied(e=>{e.rollback.before.aclNodes=e.rollback.before.aclNodes.map(n=>
  n.path===rollbackRoot?{...n,entries:[...n.entries,
   {principalSid:'S-1-5-11',kind:'Deny' as const,inherited:false,
    fileSystemRights:0x1301bf},
   {principalSid:'S-1-5-11',kind:'Allow' as const,inherited:true,
    fileSystemRights:0x1301bf}]}:n)},/W20_CHAIN_ACL_UNTRUSTED/);
 denied(e=>{e.target.after.aclNodes=e.target.after.aclNodes.map(n=>
  n.path===targetRoot+'\\bin\\support.dll'?{...n,isReparsePoint:true}:n)},
  /W20_CHAIN_ACL_UNTRUSTED/);
});
test('w20 chain: signed OLD Agent 1.0.5 whole-bundle bytes cannot be replaced or partial',()=>{
 denied(e=>{e.rollback.bundleBytes=Buffer.from('only-three-installed-file-hashes')},
  /W20_CHAIN_BUNDLE_HASH_INVALID/);
 denied(e=>{e.rollback.after.files[2]!.bytes=Buffer.from('changed-data')},
  /W20_CHAIN_IMPORT_FILE_HASH_OR_TYPE_MISMATCH/);
 denied(e=>{e.rollback.manifest.bundleSha256=sha('other-archive');resignManifest(e,'rollback')},
  /W20_CHAIN_RELEASE_OWNER_VERSION_OR_HUB_INCOMPATIBLE/);
});
test('w20 chain: old 1.0.5 and Hub backward/forward compatibility are mandatory',()=>{
 denied(e=>{e.rollback.manifest.version='1.0.4';resignManifest(e,'rollback')},
  /W20_CHAIN_RELEASE_OWNER_VERSION_OR_HUB_INCOMPATIBLE/);
 denied(e=>{e.rollback.manifest.hubMinVersion='1.0.6';resignManifest(e,'rollback')},
  /W20_CHAIN_RELEASE_OWNER_VERSION_OR_HUB_INCOMPATIBLE/);
 denied(e=>{e.target.manifest.hubMaxVersion='1.0.4';resignManifest(e,'target')},
  /W20_CHAIN_RELEASE_OWNER_VERSION_OR_HUB_INCOMPATIBLE/);
 denied(e=>{e.witness.priorAgentVersion='1.0.4';resignWitness(e)},
  /W20_CHAIN_STALE_OFFLINE_ENROLLMENT_OR_UNKNOWN/);
});
test('w20 chain: stale DPAPI owner key after offline reinstall never rolls epoch back',()=>{
 for(const x of [
  {newOwnerEpoch:41},{newOwnerEpoch:42},{witnessSequence:99},
  {newEnrollmentId:'old-install-w20'},
  {newDpapiBlobSha256:sha('old-protected-dpapi-blob')},
  {oldDpapiBlobSha256:sha('stale-key-from-other-owner')},
  {oldKeyRevocationObserved:false},
  {ownerAccountId:'foreign-owner'},{deviceId:'foreign-device'},
 ]){
  denied(e=>{Object.assign(e.witness,x);resignWitness(e)},
   /W20_CHAIN_STALE_OFFLINE_ENROLLMENT_OR_UNKNOWN/);
 }
});
test('w20 chain: offline crash UNKNOWN, unsafe Agent handoff, fake UAC still blocked',()=>{
 for(const change of [
  {pendingUnknownMutation:true},{originalAgentPreservedUntilHandoff:false},
  {requiresFreshOwnerLocalConsent:false},
 ]){
  denied(e=>{Object.assign(e.witness,change);resignWitness(e)},
   /W20_CHAIN_STALE_OFFLINE_ENROLLMENT_OR_UNKNOWN/);
 }
 const e=fixture();
 assert.equal(assessSourceOnlyInstallManifestChain(e).localUacAccepted,false);
 assert.equal(assessSourceOnlyInstallManifestChain(e).mayMigrateAgent,false);
});
test('w20 chain: independent witness signing key cannot be supplied by attacker bundle',()=>{
 denied(e=>{e.witnessSignature=sign(null,encodeSourceWitness(e.witness),
  hostileKey.privateKey).toString('base64')},/W20_CHAIN_SIGNATURE_INVALID/);
 denied(e=>{e.pins.independentWitnessPublicKeyPem=pem(hostileKey)},
  /W20_CHAIN_SIGNATURE_INVALID/);
 denied(e=>{e.witness.targetManifestSha256=sha('old-target');
  resignWitness(e)},/W20_CHAIN_STALE_OFFLINE_ENROLLMENT_OR_UNKNOWN/);
});
test('w20 chain: repeatable readback preserves source-only result with strict boundary',()=>{
 const e=fixture();
 const before=assessSourceOnlyInstallManifestChain(e);
 const after=assessSourceOnlyInstallManifestChain(e);
 assert.deepEqual(after,before);
 assert.equal(before.signedRollbackBundle,'synthetic_manifest_and_bundle_hash_only');
 assert.equal(before.oldAgentMigration,'source_compatibility_only');
});
