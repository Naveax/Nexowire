/**
 * Worker #29 standalone source-only QA contract. No Windows/Agent/Broker/VM calls.
 * Test Ed25519 signatures are NOT real OS identity; no dispatch/retry permissions.
 */
import {createHash, verify, type KeyObject} from 'node:crypto';
export const hash = (v:string):string=>createHash('sha256').update(v).digest('hex');
const h64=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const pos=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>0;
const ms=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
const filetime=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{10,19}$/.test(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(v);
const pack=(v:unknown)=>Buffer.from(JSON.stringify(v),'utf8');
export const verifySig=(key:KeyObject,data:unknown,sig:unknown):boolean=>{
 if(typeof sig!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(sig))return false;
 try{return verify(null,pack(data),key,Buffer.from(sig,'base64'))}catch{return false}
};
export type Intent=Readonly<{requestId:string;ownerId:string;deviceId:string;sessionId:string;
 ownerEpoch:number;coreEpoch:number;intentHash:string;targetId:string;
 targetGeneration:number;expectedStateHash:string}>;
export type ProcessCreation=Readonly<{kind:'os-process-created-v1';requestId:string;
 ownerId:string;deviceId:string;sessionId:string;ownerEpoch:number;coreEpoch:number;
 intentHash:string;reservationNonce:string;pid:number;creationFiletime:string;
 machineBootId:string;launchNonce:string;createdAtMs:number;
 integrity:'high'|'system'|'medium';administratorsEnabled:boolean;
 imageHash:string;publisherHash:string;protectedAcl:boolean}>;
export type OsExit=Readonly<{kind:'os-exit-v1';requestId:string;reservationNonce:string;
 pid:number;creationFiletime:string;machineBootId:string;launchNonce:string;
 exitCode:number;exitedAtMs:number;stdoutHash:string;stderrHash:string;
 stdoutComplete:boolean;stderrComplete:boolean}>;
export type Postcondition=Readonly<{kind:'independent-postcondition-v1';requestId:string;
 ownerId:string;deviceId:string;sessionId:string;ownerEpoch:number;coreEpoch:number;
 intentHash:string;reservationNonce:string;targetId:string;targetGeneration:number;
 observedStateHash:string;pid:number;creationFiletime:string;machineBootId:string;
 launchNonce:string;observedAtMs:number;observerId:string}>;
export type Signed<T>=Readonly<{payload:T;signature:string}>;
export type CurrentAuthority=Readonly<{kind:'external-current-state-v1';requestId:string;
 deviceId:string;ownerId:string;ownerEpoch:number;coreEpoch:number;reservationNonce:string;
 intentHash:string;targetId:string;targetGeneration:number;expectedStateHash:string;
 state:'reserved'|'dispatched'|'unknown';dispatchCount:number;auditSeq:number;auditHeadHash:string}>;
export type AuditKind='reserve'|'dispatch'|'exit'|'postcondition'|'ack'|'unknown'|'revoke';
export type AuditEvent=Readonly<{seq:number;kind:AuditKind;requestId:string;
 ownerEpoch:number;coreEpoch:number;evidenceHash:string;previousHash:string;hash:string}>;
export type Seal=Readonly<{index:number;startSeq:number;endSeq:number;
 previousSealHash:string;firstPreviousHash:string;endHash:string;signature:string}>;
export type Segment=Readonly<{index:number;events:readonly AuditEvent[];seal:Seal}>;
export type CurrentRoot=Readonly<{kind:'external-log-head-v1';index:number;
 seq:number;headHash:string;sealHash:string}>;
export const GENESIS=hash('qa29-receipt-log-genesis');
export const SEAL_GENESIS=hash('qa29-receipt-seal-genesis');
export const eventDigest=(e:Omit<AuditEvent,'hash'>)=>hash(JSON.stringify(e));
export const sealBody=(s:Seal)=>({index:s.index,startSeq:s.startSeq,endSeq:s.endSeq,
 previousSealHash:s.previousSealHash,firstPreviousHash:s.firstPreviousHash,endHash:s.endHash});
const kinds:readonly AuditKind[]=['reserve','dispatch','exit','postcondition','ack','unknown','revoke'];
const exact=(v:unknown,ks:readonly string[]):boolean=>v!==null&&typeof v==='object'&&
 !Array.isArray(v)&&Object.keys(v).length===ks.length&&ks.every(k=>Object.hasOwn(v,k));
const EVENT=['seq','kind','requestId','ownerEpoch','coreEpoch','evidenceHash','previousHash','hash'];
const SEAL=['index','startSeq','endSeq','previousSealHash','firstPreviousHash','endHash','signature'];
/** Caller must retrieve CURRENT root independently, never accept a stored historical root. */
export function verifyRotation(segments:readonly Segment[],getCurrentRoot:()=>Signed<CurrentRoot>|undefined,key:KeyObject):boolean{
 try{
  const current=getCurrentRoot();
  if(!current||!verifySig(key,current.payload,current.signature)||
    !exact(current.payload,['kind','index','seq','headHash','sealHash'])||
    current.payload.kind!=='external-log-head-v1'||!pos(current.payload.seq)||
    !h64(current.payload.headHash)||!h64(current.payload.sealHash)||
    !Array.isArray(segments)||segments.length===0||segments.length>64)return false;
  let seq=0,previous=GENESIS,previousSeal=SEAL_GENESIS;
  for(let i=0;i<segments.length;i++){
   const seg=segments[i],seal=seg?.seal;
   if(!seg||!seal||seg.index!==i||!Array.isArray(seg.events)||
      !seg.events.length||seg.events.length>128||!exact(seal,SEAL)||
      seal.index!==i||seal.startSeq!==seq+1||seal.previousSealHash!==previousSeal||
      seal.firstPreviousHash!==previous||!h64(seal.endHash))return false;
   for(const ev of seg.events){
    if(!exact(ev,EVENT)||!pos(ev.seq)||ev.seq!==seq+1||!kinds.includes(ev.kind)||
       !uuid(ev.requestId)||!pos(ev.ownerEpoch)||!pos(ev.coreEpoch)||
       !h64(ev.evidenceHash)||ev.previousHash!==previous||!h64(ev.hash))return false;
    const {hash:claimed,...body}=ev;
    if(eventDigest(body)!==claimed)return false;
    previous=claimed;seq++;
   }
   if(seal.endSeq!==seq||seal.endHash!==previous||!verifySig(key,sealBody(seal),seal.signature))return false;
   previousSeal=hash(JSON.stringify(seal));
  }
  return current.payload.index===segments.length-1&&current.payload.seq===seq&&
   current.payload.headHash===previous&&current.payload.sealHash===previousSeal;
 }catch{return false}
}
export type Verification='COMPLETED_VERIFIED'|'FAILED_VERIFIED'|'MUTATION_UNKNOWN';
export type VerificationResult=Readonly<{status:Verification;reason:string;retrySafe:false}>;
const result=(status:Verification,reason:string):VerificationResult=>({status,reason,retrySafe:false});
export type ReceiptBundle=Readonly<{intent:Intent;process:Signed<ProcessCreation>|undefined;
 exit:Signed<OsExit>|undefined;readback:Signed<Postcondition>|undefined;
 segments:readonly Segment[]}>;
export type Authorities=Readonly<{osPublicKey:KeyObject;readbackPublicKey:KeyObject;
 externalPublicKey:KeyObject;getLatest:()=>Signed<CurrentAuthority>|undefined;
 getLogRoot:()=>Signed<CurrentRoot>|undefined;pinnedImageHash:string;
 pinnedPublisherHash:string;nowMs:number}>;
/** Pure QA acceptance oracle; NEVER grants authorization or retries a mutation. */
export function verifyElevatedReceipt(bundle:ReceiptBundle,trust:Authorities):VerificationResult{
 try{
  const b=bundle.intent,c=trust.getLatest();
  if(!c||!verifySig(trust.externalPublicKey,c.payload,c.signature)||
     !exact(c.payload,['kind','requestId','deviceId','ownerId','ownerEpoch','coreEpoch',
       'reservationNonce','intentHash','targetId','targetGeneration','expectedStateHash',
       'state','dispatchCount','auditSeq','auditHeadHash'])||
     c.payload.kind!=='external-current-state-v1'||c.payload.requestId!==b.requestId||
     c.payload.deviceId!==b.deviceId||c.payload.ownerId!==b.ownerId||
     c.payload.ownerEpoch!==b.ownerEpoch||c.payload.coreEpoch!==b.coreEpoch||
     c.payload.intentHash!==b.intentHash||c.payload.targetId!==b.targetId||
     c.payload.targetGeneration!==b.targetGeneration||
     c.payload.expectedStateHash!==b.expectedStateHash||
     c.payload.state!=='dispatched'||c.payload.dispatchCount!==1||
     !id(c.payload.reservationNonce)||!pos(c.payload.auditSeq)||!h64(c.payload.auditHeadHash))
    return result('MUTATION_UNKNOWN','CURRENT_EXTERNAL_AUTHORITY_MISSING_OR_STALE');
  if(!verifyRotation(bundle.segments,trust.getLogRoot,trust.externalPublicKey))
    return result('MUTATION_UNKNOWN','AUDIT_ROTATION_UNTRUSTED');
  const root=trust.getLogRoot();
  if(!root||!verifySig(trust.externalPublicKey,root.payload,root.signature)||
     c.payload.auditSeq!==root.payload.seq||c.payload.auditHeadHash!==root.payload.headHash)
    return result('MUTATION_UNKNOWN','AUDIT_EXTERNAL_HEAD_MISMATCH');
  const p=bundle.process,e=bundle.exit,w=bundle.readback;
  if(!p||!e||!w||!verifySig(trust.osPublicKey,p.payload,p.signature)||
     !verifySig(trust.osPublicKey,e.payload,e.signature)||
     !verifySig(trust.readbackPublicKey,w.payload,w.signature))
    return result('MUTATION_UNKNOWN','SIGNED_OS_AND_READBACK_REQUIRED');
  const proc=p.payload,exit=e.payload,read=w.payload;
  if(!exact(proc,['kind','requestId','ownerId','deviceId','sessionId','ownerEpoch','coreEpoch',
     'intentHash','reservationNonce','pid','creationFiletime','machineBootId','launchNonce',
     'createdAtMs','integrity','administratorsEnabled','imageHash','publisherHash','protectedAcl'])||
    proc.kind!=='os-process-created-v1'||proc.requestId!==b.requestId||
    proc.ownerId!==b.ownerId||proc.deviceId!==b.deviceId||proc.sessionId!==b.sessionId||
    proc.ownerEpoch!==b.ownerEpoch||proc.coreEpoch!==b.coreEpoch||proc.intentHash!==b.intentHash||
    proc.reservationNonce!==c.payload.reservationNonce||!pos(proc.pid)||
    !filetime(proc.creationFiletime)||!id(proc.machineBootId)||!id(proc.launchNonce)||
    !ms(proc.createdAtMs)||!['high','system'].includes(proc.integrity)||
    proc.administratorsEnabled!==true||proc.imageHash!==trust.pinnedImageHash||
    proc.publisherHash!==trust.pinnedPublisherHash||proc.protectedAcl!==true)
    return result('MUTATION_UNKNOWN','OS_HIGH_TOKEN_PROCESS_PROOF_INVALID');
  if(!exact(exit,['kind','requestId','reservationNonce','pid','creationFiletime',
      'machineBootId','launchNonce','exitCode','exitedAtMs','stdoutHash','stderrHash',
      'stdoutComplete','stderrComplete'])||
    exit.kind!=='os-exit-v1'||exit.requestId!==b.requestId||
    exit.reservationNonce!==c.payload.reservationNonce||exit.pid!==proc.pid||
    exit.creationFiletime!==proc.creationFiletime||exit.machineBootId!==proc.machineBootId||
    exit.launchNonce!==proc.launchNonce||!Number.isSafeInteger(exit.exitCode)||
    !ms(exit.exitedAtMs)||exit.exitedAtMs<proc.createdAtMs||
    !h64(exit.stdoutHash)||!h64(exit.stderrHash)||
    exit.stdoutComplete!==true||exit.stderrComplete!==true)
    return result('MUTATION_UNKNOWN','OS_EXIT_OR_STREAM_EVIDENCE_INVALID');
  if(!exact(read,['kind','requestId','ownerId','deviceId','sessionId','ownerEpoch',
     'coreEpoch','intentHash','reservationNonce','targetId','targetGeneration',
     'observedStateHash','pid','creationFiletime','machineBootId','launchNonce',
     'observedAtMs','observerId'])||
     read.kind!=='independent-postcondition-v1'||read.requestId!==b.requestId||
     read.ownerId!==b.ownerId||read.deviceId!==b.deviceId||read.sessionId!==b.sessionId||
     read.ownerEpoch!==b.ownerEpoch||read.coreEpoch!==b.coreEpoch||
     read.intentHash!==b.intentHash||read.reservationNonce!==c.payload.reservationNonce||
     read.targetId!==b.targetId||read.targetGeneration!==b.targetGeneration||
     read.pid!==proc.pid||read.creationFiletime!==proc.creationFiletime||
     read.machineBootId!==proc.machineBootId||read.launchNonce!==proc.launchNonce||
     !id(read.observerId)||!h64(read.observedStateHash)||!ms(read.observedAtMs)||
     read.observedAtMs<=exit.exitedAtMs||read.observedAtMs>trust.nowMs||
     trust.nowMs-read.observedAtMs>30000)
    return result('MUTATION_UNKNOWN','INDEPENDENT_POSTCONDITION_INVALID_OR_STALE');
  const entries=bundle.segments.flatMap(s=>s.events);
  if(entries.some(v=>v.requestId!==b.requestId||v.ownerEpoch!==b.ownerEpoch||
      v.coreEpoch!==b.coreEpoch||v.kind==='unknown'||v.kind==='revoke'))
    return result('MUTATION_UNKNOWN','AUDIT_REQUEST_OR_EPOCH_MISMATCH');
  const match=(kind:AuditKind,proof?:string)=>entries.filter(v=>v.kind===kind).length===1&&
   (proof===undefined||entries.some(v=>v.kind===kind&&v.evidenceHash===proof));
  if(!match('reserve')||!match('dispatch',hash(JSON.stringify(p)))||
     !match('exit',hash(JSON.stringify(e)))||
     !match('postcondition',hash(JSON.stringify(w))))
    return result('MUTATION_UNKNOWN','AUDIT_RECEIPTS_UNBOUND');
  if(exit.exitCode!==0||read.observedStateHash!==b.expectedStateHash)
    return result('FAILED_VERIFIED','SIGNED_EXIT_OR_STATE_MISMATCH');
  return result('COMPLETED_VERIFIED','OS_AND_POSTCONDITION_INDEPENDENTLY_VERIFIED');
 }catch{return result('MUTATION_UNKNOWN','EVIDENCE_MALFORMED')}
}
/** Strict projection: never persist caller supplied stdout, argv, passwords or tokens. */
export function redactAudit(input:unknown):Readonly<Record<string,string|number>>{
 if(!input||typeof input!=='object')return Object.freeze({kind:'rejected'});
 const x=input as Record<string,unknown>;
 if(!kinds.includes(x.kind as AuditKind)||!uuid(x.requestId)||
    !pos(x.ownerEpoch)||!pos(x.coreEpoch)||!h64(x.evidenceHash))
   return Object.freeze({kind:'rejected'});
 return Object.freeze({kind:x.kind as string,requestId:x.requestId as string,
  ownerEpoch:x.ownerEpoch as number,coreEpoch:x.coreEpoch as number,
  evidenceHash:x.evidenceHash as string});
}
