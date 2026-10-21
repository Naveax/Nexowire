/**
 * Independent #20 source fixture model. NOT connected to any installer, UAC,
 * DPAPI API, Task Scheduler, privileged Broker, real filesystem or service.
 * Native claims, even "SYSTEM/high token", NEVER become Windows attestation.
 */
import {createHash,createPublicKey,verify} from 'node:crypto';
import path from 'node:path';
import {evaluateCapturedAclNodes,type CapturedAclNode} from './s3-windows-acl-preflight.js';

const SHA=/^[a-f0-9]{64}$/;
const ID=/^[A-Za-z0-9_.:@-]{1,128}$/;
const VERSION=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_FILES=128;
const MAX_BUNDLE_BYTES=4*1024*1024;
function refuse(reason:string):never {throw new Error('W20_CHAIN_'+reason);}
const hash=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
function exact(value:object,expected:string[]):void {
 if(!value||Array.isArray(value)||
    Object.keys(value).sort().join(',')!==[...expected].sort().join(','))refuse('SCHEMA_INVALID');
}
function safeVersion(s:string):number[] {
 if(typeof s!=='string'||!VERSION.test(s))refuse('VERSION_INVALID');
 const values=s.split('.').map(Number);
 if(values.some(v=>!Number.isSafeInteger(v)))refuse('VERSION_INVALID');
 return values;
}
function compareVersion(a:string,b:string):number {
 const l=safeVersion(a),r=safeVersion(b);
 for(let i=0;i<3;i++){if(l[i]!==r[i])return l[i]!<r[i]!?-1:1;}
 return 0;
}
function normalizedWindowsFile(input:string,root:string):string {
 if(typeof input!=='string'||input.length>4096||
    !/^[a-zA-Z]:\\/.test(input)||input.slice(2).includes(':')||
    /[\u0000-\u001f]/.test(input)||input.split(/[\\/]/).includes('..')||
    input.includes('/')||path.win32.normalize(input)!==input)refuse('PATH_INVALID');
 const relative=path.win32.relative(root,input);
 if(!relative||relative==='..'||relative.startsWith('..\\')||
    path.win32.isAbsolute(relative))refuse('PATH_OUTSIDE_PINNED_ROOT');
 return input.toLowerCase();
}
function canonKey(p:string):string {return path.win32.normalize(p).toLowerCase();}
function signed(bytes:Buffer,signature:string,keyPem:string):void {
 let key;
 try{key=createPublicKey(keyPem);}catch{refuse('TRUST_ANCHOR_INVALID');}
 if(key.asymmetricKeyType!=='ed25519')refuse('TRUST_ANCHOR_INVALID');
 if(typeof signature!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(signature))
  refuse('SIGNATURE_INVALID');
 const sig=Buffer.from(signature,'base64');
 if(sig.length!==64||sig.toString('base64')!==signature||
    !verify(null,bytes,key,sig))refuse('SIGNATURE_INVALID');
}
export type SourceFileKind='pe'|'script'|'data';
export interface SourceFilePin {
 path:string;kind:SourceFileKind;sha256:string;imports:string[];
}
export interface SourceInstallManifest {
 schemaVersion:1;role:'target-broker'|'rollback-agent';
 version:string;ownerAccountId:string;deviceId:string;
 hubMinVersion:string;hubMaxVersion:string;
 bundleSha256:string;entrypoint:string;files:SourceFilePin[];
}
export interface SourceFileCapture {
 path:string;kind:SourceFileKind;bytes:Buffer;
 linkCount:number;isReparsePoint:boolean;
 /** Claim from injected OS inspector, NOT trustworthy native proof. */
 signature?:{valid:boolean;subject:string;certificateSha256:string};
}
export interface SourceSnapshot {
 enumerationComplete:boolean;unknownDynamicImports:boolean;
 files:SourceFileCapture[];aclNodes:CapturedAclNode[];
}
export interface SourceRelease {
 manifest:SourceInstallManifest;signature:string;bundleBytes:Buffer;
 before:SourceSnapshot;after:SourceSnapshot;
}
export interface ReinstallWitness {
 schemaVersion:1;role:'owner-offline-reinstall';
 ownerAccountId:string;deviceId:string;
 priorAgentVersion:string;targetAgentVersion:string;hubVersion:string;
 priorOwnerEpoch:number;newOwnerEpoch:number;witnessSequence:number;
 oldEnrollmentId:string;newEnrollmentId:string;
 oldDpapiBlobSha256:string;newDpapiBlobSha256:string;
 oldKeyRevocationObserved:boolean;pendingUnknownMutation:boolean;
 originalAgentPreservedUntilHandoff:boolean;
 targetManifestSha256:string;rollbackManifestSha256:string;
 /** This is a signed source requirement, NOT an accepted UAC consent. */
 requiresFreshOwnerLocalConsent:true;
}
export interface SourceChainPins {
 ownerAccountId:string;deviceId:string;
 hubVersion:string;oldAgentVersion:'1.0.5';targetAgentVersion:string;
 targetRoot:string;rollbackRoot:string;
 targetManifestSha256:string;rollbackManifestSha256:string;
 targetBundleSha256:string;rollbackBundleSha256:string;
 targetManifestPublicKeyPem:string;rollbackManifestPublicKeyPem:string;
 independentWitnessPublicKeyPem:string;
 publisherSubject:string;signerCertificateSha256:string;
 lastEnrollmentId:string;lastDpapiBlobSha256:string;
 minimumNewOwnerEpoch:number;minimumWitnessSequence:number;
}
export interface SourceChainInput {
 pins:SourceChainPins;
 target:SourceRelease;rollback:SourceRelease;
 witness:ReinstallWitness;witnessSignature:string;
 /** Deliberately untrusted self-reports. They are never consumed for admission. */
 nativeClaims?:{
  provider:string;systemSid:string;highToken:boolean;
  dpapiUnsealed:boolean;uacApproved:boolean;
 };
}
export interface SourceChainResult {
 status:'synthetic_signed_manifest_chain_checked';
 importGraphCoverage:'declared_fixture_only';
 signedRollbackBundle:'synthetic_manifest_and_bundle_hash_only';
 oldAgentMigration:'source_compatibility_only';
 nativeOsProofAccepted:false;
 systemHighTokenAccepted:false;
 dpapiUnsealAccepted:false;
 localUacAccepted:false;
 mayInstall:false;mayEnableCore:false;mayMigrateAgent:false;
 productionAccepted:false;
}
const manifestKeys=['schemaVersion','role','version','ownerAccountId','deviceId',
 'hubMinVersion','hubMaxVersion','bundleSha256','entrypoint','files'];
const pinKeys=['path','kind','sha256','imports'];
const witnessKeys=['schemaVersion','role','ownerAccountId','deviceId',
 'priorAgentVersion','targetAgentVersion','hubVersion','priorOwnerEpoch',
 'newOwnerEpoch','witnessSequence','oldEnrollmentId','newEnrollmentId',
 'oldDpapiBlobSha256','newDpapiBlobSha256','oldKeyRevocationObserved',
 'pendingUnknownMutation','originalAgentPreservedUntilHandoff',
 'targetManifestSha256','rollbackManifestSha256','requiresFreshOwnerLocalConsent'];
/** Canonical source fixture encoding (NOT a Windows release file format). */
export function encodeSourceManifest(m:SourceInstallManifest):Buffer {
 exact(m,manifestKeys);
 if(!Array.isArray(m.files))refuse('SCHEMA_INVALID');
 for(const f of m.files)exact(f,pinKeys);
 return Buffer.from(JSON.stringify(Object.fromEntries(
  manifestKeys.map(k=>[k,k==='files'?m.files.map(f=>Object.fromEntries(
   pinKeys.map(x=>[x,f[x as keyof SourceFilePin]]))):(m as unknown as Record<string,unknown>)[k]])
 )),'utf8');
}
export function encodeSourceWitness(w:ReinstallWitness):Buffer {
 exact(w,witnessKeys);
 return Buffer.from(JSON.stringify(Object.fromEntries(
  witnessKeys.map(k=>[k,(w as unknown as Record<string,unknown>)[k]])
 )),'utf8');
}
/** Byte-for-byte synthetic container, not a ZIP/MSI/Win32 archive parser. */
export function encodeSourceBundle(files:readonly SourceFileCapture[]):Buffer {
 return Buffer.from(JSON.stringify(files.map(f=>({
  path:f.path,bytes:f.bytes.toString('base64'),
 }))),'utf8');
}
function inspectAclCoverage(files:SourceFilePin[],nodes:CapturedAclNode[],root:string):void {
 try{evaluateCapturedAclNodes(nodes);}catch{refuse('ACL_UNTRUSTED');}
 const known=new Set(nodes.map(n=>canonKey(n.path)));
 for(const f of files){
  let cursor=f.path;
  while(true){
   if(!known.has(canonKey(cursor)))refuse('ACL_INCOMPLETE');
   const parent=path.win32.dirname(cursor);
   if(parent===cursor)break;cursor=parent;
  }
 }
 if(!known.has(canonKey(root)))refuse('ACL_INCOMPLETE');
}
function inspectSnapshot(
 m:SourceInstallManifest,s:SourceSnapshot,pins:SourceChainPins,root:string,
 bundleBytes:Buffer,
):void {
 if(!s||s.enumerationComplete!==true||s.unknownDynamicImports!==false||
    !Array.isArray(s.files)||s.files.length!==m.files.length)refuse('TREE_INCOMPLETE');
 inspectAclCoverage(m.files,s.aclNodes,root);
 const actual=new Map<string,SourceFileCapture>();
 for(const file of s.files){
  if(!file||!Buffer.isBuffer(file.bytes)||file.bytes.length===0||
     !Number.isSafeInteger(file.linkCount)||file.linkCount!==1||
     file.isReparsePoint!==false)refuse('UNSAFE_FILE_IDENTITY');
  const key=normalizedWindowsFile(file.path,root);
  if(actual.has(key))refuse('DUPLICATE_OR_EXTRA_FILE');
  actual.set(key,file);
 }
 for(const pin of m.files){
  const f=actual.get(canonKey(pin.path));
  if(!f||f.kind!==pin.kind||hash(f.bytes)!==pin.sha256)
   refuse('IMPORT_FILE_HASH_OR_TYPE_MISMATCH');
  if(f.kind==='pe'&&(!f.signature||f.signature.valid!==true||
     f.signature.subject!==pins.publisherSubject||
     f.signature.certificateSha256!==pins.signerCertificateSha256))
   refuse('PE_PUBLISHER_OR_CERT_UNTRUSTED');
 }
 const bytes=encodeSourceBundle(s.files);
 if(bytes.length>MAX_BUNDLE_BYTES||!bytes.equals(bundleBytes)||
    hash(bytes)!==m.bundleSha256)refuse('BUNDLE_CONTENT_UNTRUSTED');
}
function inspectRelease(
 rel:SourceRelease,role:SourceInstallManifest['role'],
 pins:SourceChainPins,root:string,
 expectedManifestHash:string,expectedBundleHash:string,keyPem:string,
):void {
 if(!rel||!rel.manifest)refuse('MISSING_RELEASE');
 const m=rel.manifest;
 const manifestBytes=encodeSourceManifest(m);
 if(hash(manifestBytes)!==expectedManifestHash)refuse('MANIFEST_POLICY_MISMATCH');
 signed(manifestBytes,rel.signature,keyPem);
 if(m.schemaVersion!==1||m.role!==role||
    m.ownerAccountId!==pins.ownerAccountId||
    m.deviceId!==pins.deviceId||
    m.version!==(role==='rollback-agent'?pins.oldAgentVersion:pins.targetAgentVersion)||
    m.bundleSha256!==expectedBundleHash||
    compareVersion(pins.hubVersion,m.hubMinVersion)<0||
    compareVersion(pins.hubVersion,m.hubMaxVersion)>0)
   refuse('RELEASE_OWNER_VERSION_OR_HUB_INCOMPATIBLE');
 if(!Array.isArray(m.files)||m.files.length<2||m.files.length>MAX_FILES)
  refuse('TREE_INCOMPLETE');
 normalizedWindowsFile(m.entrypoint,root);
 const declared=new Map<string,SourceFilePin>();
 for(const f of m.files){
  if(!['pe','script','data'].includes(f.kind)||!SHA.test(f.sha256)||
     !Array.isArray(f.imports)||f.imports.length>MAX_FILES)refuse('FILE_PIN_INVALID');
  const k=normalizedWindowsFile(f.path,root);
  if(declared.has(k))refuse('DUPLICATE_OR_EXTRA_FILE');
  declared.set(k,f);
 }
 if(!declared.has(canonKey(m.entrypoint)))refuse('ENTRYPOINT_MISSING');
 const seen=new Set<string>();
 const visit=(k:string):void=>{
  if(seen.has(k))return;
  const f=declared.get(k);
  if(!f)refuse('UNRESOLVED_IMPORT');
  seen.add(k);
  for(const child of f.imports){
   const ref=normalizedWindowsFile(child,root);
   if(!declared.has(ref))refuse('UNRESOLVED_IMPORT');
   visit(ref);
  }
 };
 visit(canonKey(m.entrypoint));
 if(seen.size!==declared.size)refuse('UNREACHABLE_IMPORT_OR_EXTRA_PAYLOAD');
 if(!Buffer.isBuffer(rel.bundleBytes)||rel.bundleBytes.length<1||
    rel.bundleBytes.length>MAX_BUNDLE_BYTES||
    hash(rel.bundleBytes)!==m.bundleSha256)refuse('BUNDLE_HASH_INVALID');
 inspectSnapshot(m,rel.before,pins,root,rel.bundleBytes);
 inspectSnapshot(m,rel.after,pins,root,rel.bundleBytes);
}
function inspectWitness(
 w:ReinstallWitness,signature:string,p:SourceChainPins,
):void {
 const data=encodeSourceWitness(w);
 signed(data,signature,p.independentWitnessPublicKeyPem);
 if(w.schemaVersion!==1||w.role!=='owner-offline-reinstall'||
    w.ownerAccountId!==p.ownerAccountId||w.deviceId!==p.deviceId||
    w.priorAgentVersion!==p.oldAgentVersion||
    w.targetAgentVersion!==p.targetAgentVersion||
    w.hubVersion!==p.hubVersion||
    !Number.isSafeInteger(w.priorOwnerEpoch)||w.priorOwnerEpoch<0||
    !Number.isSafeInteger(w.newOwnerEpoch)||w.newOwnerEpoch<=w.priorOwnerEpoch||
    w.newOwnerEpoch<p.minimumNewOwnerEpoch||
    !Number.isSafeInteger(w.witnessSequence)||
    w.witnessSequence<p.minimumWitnessSequence||
    !ID.test(w.oldEnrollmentId)||!ID.test(w.newEnrollmentId)||
    w.oldEnrollmentId!==p.lastEnrollmentId||
    w.newEnrollmentId===w.oldEnrollmentId||
    !SHA.test(w.oldDpapiBlobSha256)||!SHA.test(w.newDpapiBlobSha256)||
    w.oldDpapiBlobSha256!==p.lastDpapiBlobSha256||
    w.newDpapiBlobSha256===w.oldDpapiBlobSha256||
    w.oldKeyRevocationObserved!==true||
    w.pendingUnknownMutation!==false||
    w.originalAgentPreservedUntilHandoff!==true||
    w.targetManifestSha256!==p.targetManifestSha256||
    w.rollbackManifestSha256!==p.rollbackManifestSha256||
    w.requiresFreshOwnerLocalConsent!==true)
  refuse('STALE_OFFLINE_ENROLLMENT_OR_UNKNOWN');
}
export function assessSourceOnlyInstallManifestChain(input:SourceChainInput):SourceChainResult {
 if(!input||!input.pins)refuse('MISSING_INDEPENDENT_PINS');
 const p=input.pins;
 if(!ID.test(p.ownerAccountId)||!ID.test(p.deviceId)||
    !ID.test(p.lastEnrollmentId)||
    ![p.targetManifestSha256,p.rollbackManifestSha256,p.targetBundleSha256,
      p.rollbackBundleSha256,p.signerCertificateSha256,p.lastDpapiBlobSha256]
      .every(v=>SHA.test(v))||
    typeof p.publisherSubject!=='string'||p.publisherSubject.length<3||
    !Number.isSafeInteger(p.minimumWitnessSequence)||p.minimumWitnessSequence<1||
    !Number.isSafeInteger(p.minimumNewOwnerEpoch)||p.minimumNewOwnerEpoch<1||
    !VERSION.test(p.oldAgentVersion)||!VERSION.test(p.targetAgentVersion)||
    compareVersion(p.targetAgentVersion,p.oldAgentVersion)<=0)
   refuse('INDEPENDENT_POLICY_INVALID');
 if(!/^[a-zA-Z]:\\/.test(p.targetRoot)||!/^[a-zA-Z]:\\/.test(p.rollbackRoot)||
    canonKey(p.targetRoot)===canonKey(p.rollbackRoot)||
    p.targetRoot.includes('..')||p.rollbackRoot.includes('..'))
   refuse('INDEPENDENT_POLICY_INVALID');
 inspectRelease(input.target,'target-broker',p,p.targetRoot,
  p.targetManifestSha256,p.targetBundleSha256,p.targetManifestPublicKeyPem);
 inspectRelease(input.rollback,'rollback-agent',p,p.rollbackRoot,
  p.rollbackManifestSha256,p.rollbackBundleSha256,p.rollbackManifestPublicKeyPem);
 inspectWitness(input.witness,input.witnessSignature,p);
 // Crucial: even genuine Ed25519 signatures over synthetic captured data do
 // NOT authenticate a Windows binary, DPAPI service identity, ACL or UAC.
 // Self-reported nativeClaims MUST NOT be inspected as OS proof.
 return {
  status:'synthetic_signed_manifest_chain_checked',
  importGraphCoverage:'declared_fixture_only',
  signedRollbackBundle:'synthetic_manifest_and_bundle_hash_only',
  oldAgentMigration:'source_compatibility_only',
  nativeOsProofAccepted:false,systemHighTokenAccepted:false,
  dpapiUnsealAccepted:false,localUacAccepted:false,
  mayInstall:false,mayEnableCore:false,mayMigrateAgent:false,
  productionAccepted:false,
 };
}
