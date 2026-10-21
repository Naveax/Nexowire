/**
 * #617/#551 source-only Hyper-V Broker trust gate. Does NOT elevate,
 * execute a helper, modify ACL/UAC, authorize a VM command or run Start-VM.
 * #618 separately owns read-only user-facing privilege/status evidence.
 */
import {createHash,createPublicKey,verify} from 'node:crypto';
import path from 'node:path';
import {evaluateCapturedAclNodes,type CapturedAclNode} from './s3-windows-acl-preflight.js';
import {assessS3CrashRecovery,type S3RecoveryPins} from './s3-crash-recovery-assessment.js';
const H=/^[a-f0-9]{64}$/;
const G=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const I=/^[A-Za-z0-9_.:@-]{1,128}$/;
const V=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const mk=['schemaVersion','role','version','minAgentVersion','maxAgentVersion','minHubVersion','maxHubVersion','publisher','brokerSha256','helperSha256','updaterSha256'];
const ek=['schemaVersion','ownerAccountId','deviceId','vmId','brokerVersion','epoch','expiresAtUnix'];
export interface BrokerManifest {
 schemaVersion:1;role:'nexowire-scoped-hyperv-broker';
 version:string;minAgentVersion:string;maxAgentVersion:string;
 minHubVersion:string;maxHubVersion:string;publisher:string;
 brokerSha256:string;helperSha256:string;updaterSha256:string;
}
export interface OwnerEnrollment {
 schemaVersion:1;ownerAccountId:string;deviceId:string;vmId:string;
 brokerVersion:string;epoch:number;expiresAtUnix:number;
}
export interface BrokerPins {
 trustedManifestPublicKeyPem:string;trustedEnrollmentPublicKeyPem:string;
 trustedPublisherSubject:string;trustedCertificateSha256:string;
 ownerAccountId:string;deviceId:string;vmId:string;
 installedAgentVersion:string;installedHubVersion:string;brokerVersion:string;
 minIndependentEnrollmentEpoch:number;nowUnix:number;
}
export interface BrokerNativeEvidence {
 fileSha256:string;publisherSubject:string;certificateSha256:string;signatureValid:boolean;
}
export interface BrokerRunningIdentity {
 runningImageSha256:string;creationIdentity:string;deviceId:string;
 brokerVersion:string;nativeImageHandleVerified:boolean;authenticatedHealth:boolean;
}
export interface BrokerEvidenceInput {
 manifest:BrokerManifest;manifestSignature:string;
 enrollment:OwnerEnrollment;enrollmentSignature:string;
 pins:BrokerPins;
 binaries:{broker:Buffer;helper:Buffer;updater:Buffer};
 paths:{broker:string;helper:string;updater:string};
 aclNodes:readonly CapturedAclNode[];
 running:BrokerRunningIdentity;
 remoteApproved?:boolean;
 interruptedInstall?:{journal:unknown;pins:S3RecoveryPins};
}
export type BrokerSignatureInspector=(
 kind:'broker'|'helper'|'updater',path:string,sha256:string
)=>Promise<BrokerNativeEvidence>;
export interface BrokerGateVerdict {
 status:'source_verified_but_non_executable';
 localPhysicalConsent:'unverified';
 executionApproved:false;hypervStartStopEnabled:false;
 productionApproved:false;
}
function deny(s:string):never{throw new Error('S3_HYPERV_'+s)}
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function numberVersion(v:string):number[]{
 if(typeof v!=='string'||!V.test(v))deny('VERSION_INVALID');
 const n=v.split('.').map(Number);
 if(n.some(x=>!Number.isSafeInteger(x)))deny('VERSION_INVALID');
 return n;
}
function compare(a:string,b:string):number{
 const l=numberVersion(a),r=numberVersion(b);
 for(let i=0;i<3;i++)if(l[i]!==r[i])return l[i]!<r[i]!?-1:1;
 return 0;
}
function canon(data:object,keys:string[]):Buffer{
 if(!data||Array.isArray(data)||Object.keys(data).sort().join(',')!==[...keys].sort().join(',')){
   deny('FORGED_MANIFEST_FIELDS');
 }
 const x=data as Record<string,unknown>;
 return Buffer.from(JSON.stringify(Object.fromEntries(keys.map(k=>[k,x[k]]))),'utf8');
}
function checkSignature(bytes:Buffer,sig:string,pem:string):void{
 let key;
 try{key=createPublicKey(pem)}catch{deny('INDEPENDENT_TRUST_ROOT_INVALID')}
 if(key.asymmetricKeyType!=='ed25519')deny('INDEPENDENT_TRUST_ROOT_INVALID');
 if(typeof sig!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(sig)){
  deny('SIGNED_ENVELOPE_INVALID');
 }
 const b=Buffer.from(sig,'base64');
 if(b.length!==64||b.toString('base64')!==sig)deny('SIGNED_ENVELOPE_INVALID');
 if(!verify(null,bytes,key,b))deny('SIGNATURE_INVALID');
}
function checkPaths(
 p:BrokerEvidenceInput['paths'],nodes:readonly CapturedAclNode[]
):void{
 evaluateCapturedAclNodes(nodes);
 const all=new Set(nodes.map(x=>path.win32.normalize(x.path).toLowerCase()));
 for(const v of Object.values(p)){
  if(typeof v!=='string'||! /^[A-Za-z]:\\/.test(v)||v.slice(2).includes(':')||
    /[\u0000-\u001f]/.test(v)||v.length>4096||
    v.split(/[\\/]/).includes('..'))deny('UNTRUSTED_EXECUTABLE_PATH');
  let cursor=path.win32.normalize(v);
  while(true){
   if(!all.has(cursor.toLowerCase()))deny('UNPROTECTED_PARENT_OR_UPDATER');
   const parent=path.win32.dirname(cursor);
   if(parent===cursor)break;
   cursor=parent;
  }
 }
}
export async function assessScopedBrokerTrust(
 input:BrokerEvidenceInput, inspect:BrokerSignatureInspector
):Promise<BrokerGateVerdict>{
 const {pins:p,manifest:m,enrollment:e}=input;
 if(!p||!m||!e||typeof inspect!=='function'||!H.test(p.trustedCertificateSha256)){
  deny('INDEPENDENT_TRUST_ROOT_INVALID');
 }
 if(m.schemaVersion!==1||m.role!=='nexowire-scoped-hyperv-broker'||
    m.publisher!==p.trustedPublisherSubject||m.version!==p.brokerVersion||
    ![m.brokerSha256,m.helperSha256,m.updaterSha256].every(v=>H.test(v))){
  deny('BROKER_SIGNED_IDENTITY_INVALID');
 }
 if(compare(m.minAgentVersion,m.maxAgentVersion)>0||
    compare(m.minHubVersion,m.maxHubVersion)>0||
    compare(p.installedAgentVersion,m.minAgentVersion)<0||
    compare(p.installedAgentVersion,m.maxAgentVersion)>0||
    compare(p.installedHubVersion,m.minHubVersion)<0||
    compare(p.installedHubVersion,m.maxHubVersion)>0){
  deny('BROKER_AGENT_HUB_VERSION_MISMATCH');
 }
 checkSignature(canon(m,mk),input.manifestSignature,p.trustedManifestPublicKeyPem);
 if(e.schemaVersion!==1||!I.test(e.ownerAccountId)||!I.test(e.deviceId)||
    !I.test(p.ownerAccountId)||!I.test(p.deviceId)||
    !G.test(e.vmId)||!G.test(p.vmId)||
    e.ownerAccountId!==p.ownerAccountId||e.deviceId!==p.deviceId||
    e.vmId.toLowerCase()!==p.vmId.toLowerCase()||e.brokerVersion!==m.version||
    !Number.isSafeInteger(e.epoch)||!Number.isSafeInteger(p.minIndependentEnrollmentEpoch)||
    e.epoch<p.minIndependentEnrollmentEpoch||
    !Number.isSafeInteger(e.expiresAtUnix)||!Number.isSafeInteger(p.nowUnix)||
    e.expiresAtUnix<=p.nowUnix||e.expiresAtUnix>p.nowUnix+3600){
  deny('OWNER_VM_ENROLLMENT_INVALID');
 }
 checkSignature(canon(e,ek),input.enrollmentSignature,p.trustedEnrollmentPublicKeyPem);
 checkPaths(input.paths,input.aclNodes);
 for(const [k,expected] of [
   ['broker',m.brokerSha256],['helper',m.helperSha256],['updater',m.updaterSha256],
 ] as const){
  const bytes=input.binaries[k];
  if(!Buffer.isBuffer(bytes)||bytes.length===0||sha(bytes)!==expected){
   deny('SIGNED_BINARY_HASH_MISMATCH');
  }
  let result:BrokerNativeEvidence;
  try{result=await inspect(k,input.paths[k],expected)}
  catch{deny('AUTHENTICODE_VERIFIER_UNAVAILABLE')}
  if(!result?.signatureValid||result.fileSha256!==expected||
     result.certificateSha256!==p.trustedCertificateSha256||
     result.publisherSubject!==p.trustedPublisherSubject){
   deny('BROKER_HELPER_UPDATER_PUBLISHER_MISMATCH');
  }
 }
 const r=input.running;
 if(!r||r.nativeImageHandleVerified!==true||r.authenticatedHealth!==true||
    r.runningImageSha256!==m.brokerSha256||r.brokerVersion!==m.version||
    r.deviceId!==p.deviceId||typeof r.creationIdentity!=='string'||
    !/^[A-Za-z0-9_.:@-]{16,128}$/.test(r.creationIdentity)){
   deny('RUNNING_BROKER_IDENTITY_INVALID');
 }
 if(input.interruptedInstall){
   const outcome=assessS3CrashRecovery(input.interruptedInstall.journal,
     input.interruptedInstall.pins);
   // Local disk is rollbackable. Even correct-looking journal cannot
   // attest an independent CAS or authorize automatic VM/service action.
   if(outcome.resumeAllowed||outcome.rollbackAllowed)deny('CRASH_CONTRACT_UNSAFE');
   deny('STARTUP_CRASH_MANUAL_VM_RECONCILIATION_REQUIRED');
 }
 // A remote approved:true bit is never local physical Windows consent.
 return{
  status:'source_verified_but_non_executable',
  localPhysicalConsent:'unverified',
  executionApproved:false,hypervStartStopEnabled:false,
  productionApproved:false,
 };
}
