import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign, type KeyObject} from 'node:crypto';
import {
 hash,eventDigest,sealBody,verifyElevatedReceipt,verifyRotation,redactAudit,
 GENESIS,SEAL_GENESIS,type Intent,type Signed,type ProcessCreation,type OsExit,
 type Postcondition,type CurrentAuthority,type CurrentRoot,type Segment,type Seal,
 type AuditKind,type ReceiptBundle,type Authorities,
} from './qa29-native-receipt-verifier.js';
const keypair=()=>generateKeyPairSync('ed25519');
const signature=(key:KeyObject,v:unknown)=>sign(null,Buffer.from(JSON.stringify(v)),key).toString('base64');
const signed=<T>(key:KeyObject,payload:T):Signed<T>=>({payload,signature:signature(key,payload)});
const b:Intent={
 requestId:'123e4567-e89b-42d3-a456-426614174029',ownerId:'owner29',deviceId:'device29',
 sessionId:'session29',ownerEpoch:11,coreEpoch:7,intentHash:hash('opaque-command-intent'),
 targetId:'target29',targetGeneration:44,expectedStateHash:hash('expected-real-state'),
};
const imageHash=hash('synthetic-protected-image'),publisherHash=hash('synthetic-pinned-publisher');
const now=9_000_000;
const os:ProcessCreation={
 kind:'os-process-created-v1',requestId:b.requestId,ownerId:b.ownerId,deviceId:b.deviceId,
 sessionId:b.sessionId,ownerEpoch:b.ownerEpoch,coreEpoch:b.coreEpoch,intentHash:b.intentHash,
 reservationNonce:'opaque-reservation-01',pid:808,creationFiletime:'133888888888888888',
 machineBootId:'boot-1',launchNonce:'launch-1',createdAtMs:now-2000,
 integrity:'high',administratorsEnabled:true,imageHash,publisherHash,protectedAcl:true,
};
const ex:OsExit={
 kind:'os-exit-v1',requestId:b.requestId,reservationNonce:'opaque-reservation-01',
 pid:os.pid,creationFiletime:os.creationFiletime,machineBootId:os.machineBootId,
 launchNonce:os.launchNonce,exitCode:0,exitedAtMs:now-1000,
 stdoutHash:hash('FORGED SUCCESS STDOUT'),stderrHash:hash(''),
 stdoutComplete:true,stderrComplete:true,
};
const read:Postcondition={
 kind:'independent-postcondition-v1',requestId:b.requestId,ownerId:b.ownerId,
 deviceId:b.deviceId,sessionId:b.sessionId,ownerEpoch:b.ownerEpoch,coreEpoch:b.coreEpoch,
 intentHash:b.intentHash,reservationNonce:'opaque-reservation-01',
 targetId:b.targetId,targetGeneration:b.targetGeneration,observedStateHash:b.expectedStateHash,
 pid:os.pid,creationFiletime:os.creationFiletime,machineBootId:os.machineBootId,
 launchNonce:os.launchNonce,observedAtMs:now-500,observerId:'separate-readback-observer',
};
class Root{
 readonly #key:KeyObject;readonly sealed:Segment[]=[];
 #buffer: Array<Segment['events'][number]>=[];
 #seq=0;#head=GENESIS;#seal=SEAL_GENESIS;
 constructor(key:KeyObject){this.#key=key}
 append(kind:AuditKind,ref:string){
  const body={seq:++this.#seq,kind,requestId:b.requestId,ownerEpoch:b.ownerEpoch,
   coreEpoch:b.coreEpoch,evidenceHash:hash(ref),previousHash:this.#head};
  const item={...body,hash:eventDigest(body)};
  this.#buffer.push(item);this.#head=item.hash;
 }
 seal(){
  const index=this.sealed.length;
  if(!this.#buffer.length)throw Error('EMPTY_SEGMENT');
  const first=this.#buffer[0]!;
  const body:Omit<Seal,'signature'>={index,startSeq:first.seq,endSeq:this.#seq,
   previousSealHash:this.#seal,firstPreviousHash:first.previousHash,endHash:this.#head};
  const sealed:Seal={...body,signature:signature(this.#key,body)};
  assert.deepEqual(sealBody(sealed),body);
  this.sealed.push({index,events:[...this.#buffer],seal:sealed});
  this.#seal=hash(JSON.stringify(sealed));this.#buffer=[];
 }
 latest():Signed<CurrentRoot>{
  const payload:CurrentRoot={kind:'external-log-head-v1',index:this.sealed.length-1,
   seq:this.#seq,headHash:this.#head,sealHash:this.#seal};
  return signed(this.#key,payload);
 }
}
class Fixture{
 readonly osKeys=keypair();
 readonly observeKeys=keypair();
 readonly externalKeys=keypair();
 readonly root=new Root(this.externalKeys.privateKey);
 readonly bundle:ReceiptBundle;current:CurrentAuthority;
 dispatches=1;acks=new Set<string>();
 constructor(options:{exitCode?:number;observedStateHash?:string}={}){
  const process=signed(this.osKeys.privateKey,os);
  const exit=signed(this.osKeys.privateKey,{...ex,exitCode:options.exitCode??ex.exitCode});
  const readback=signed(this.observeKeys.privateKey,{
   ...read,observedStateHash:options.observedStateHash??read.observedStateHash});
  this.root.append('reserve','opaque-reservation-01');
  this.root.append('dispatch',JSON.stringify(process));this.root.seal();
  this.root.append('exit',JSON.stringify(exit));this.root.seal();
  this.root.append('postcondition',JSON.stringify(readback));this.root.seal();
  this.current={kind:'external-current-state-v1',requestId:b.requestId,deviceId:b.deviceId,
   ownerId:b.ownerId,ownerEpoch:b.ownerEpoch,coreEpoch:b.coreEpoch,
   reservationNonce:'opaque-reservation-01',intentHash:b.intentHash,targetId:b.targetId,
   targetGeneration:b.targetGeneration,expectedStateHash:b.expectedStateHash,
   state:'dispatched',dispatchCount:1,auditSeq:this.root.latest().payload.seq,
   auditHeadHash:this.root.latest().payload.headHash};
  this.bundle={intent:b,process,exit,readback,segments:this.root.sealed};
 }
 trust():Authorities{return {
  osPublicKey:this.osKeys.publicKey,readbackPublicKey:this.observeKeys.publicKey,
  externalPublicKey:this.externalKeys.publicKey,
  getLatest:()=>signed(this.externalKeys.privateKey,this.current),
  getLogRoot:()=>this.root.latest(),pinnedImageHash:imageHash,
  pinnedPublisherHash:publisherHash,nowMs:now,
 }}
 recordAck(fingerprint:string):'recorded'|'duplicate'{
  if(this.acks.has(fingerprint))return 'duplicate';
  this.acks.add(fingerprint);return 'recorded';
 }
 attemptDispatch():boolean{if(this.dispatches>0)return false;this.dispatches++;return true}
}
const outcome=(f:Fixture,p?:ReceiptBundle,t?:Authorities)=>
 verifyElevatedReceipt(p??f.bundle,t??f.trust());
const clone=<T>(v:T):T=>structuredClone(v);
const mutate=(f:Fixture,k:'process'|'exit'|'readback',patch:Record<string,unknown>,key:KeyObject):ReceiptBundle=>{
 const source=f.bundle[k]!;
 return {...f.bundle,[k]:signed(key,{...source.payload,...patch})} as ReceiptBundle;
};
test('positive synthetic: OS FILETIME, native exit, distinct postcondition and sealed audit required',()=>{
 const f=new Fixture();assert.equal(outcome(f).status,'COMPLETED_VERIFIED');
 assert.equal(outcome(f).retrySafe,false);
});
test('forged stdout and zero exit without independently signed readback remains UNKNOWN',()=>{
 const f=new Fixture();assert.equal(outcome(f,{...f.bundle,readback:undefined}).status,'MUTATION_UNKNOWN');
 assert.equal(outcome(f,mutate(f,'exit',{stdoutHash:hash('SUCCESS')},f.osKeys.privateKey)).status,'MUTATION_UNKNOWN');
});
test('forged approved flag and wrong signer cannot spoof readback',()=>{
 const f=new Fixture(),payload={...f.bundle.readback!.payload,approved:true,
  observedStateHash:hash('not-applied')};
 assert.equal(outcome(f,{...f.bundle,readback:{
  payload:payload as Postcondition,signature:f.bundle.readback!.signature}}).status,'MUTATION_UNKNOWN');
 assert.equal(outcome(f,{...f.bundle,readback:signed(f.osKeys.privateKey,payload as Postcondition)}).status,'MUTATION_UNKNOWN');
});
test('independently witnessed wrong state results VERIFIED failure',()=>{
 const f=new Fixture({observedStateHash:hash('different-state')});
 assert.equal(outcome(f).status,'FAILED_VERIFIED');
 const g=new Fixture();assert.equal(outcome(g,mutate(g,'readback',{observedStateHash:hash('different')},
  g.observeKeys.privateKey)).status,'MUTATION_UNKNOWN');
});
test('independently OS-signed exit code 7 yields VERIFIED failure',()=>{
 const f=new Fixture({exitCode:7});assert.equal(outcome(f).status,'FAILED_VERIFIED');
 const g=new Fixture();assert.equal(outcome(g,mutate(g,'exit',{exitCode:7},
  g.osKeys.privateKey)).status,'MUTATION_UNKNOWN');
});
test('PID reuse, changed FILETIME, boot identity and reservation nonce rejected',()=>{
 for(const changed of [{pid:809},{creationFiletime:'133888888888888887'},
  {machineBootId:'boot-2'},{launchNonce:'other-process'},{reservationNonce:'old-reservation'}]){
  const f=new Fixture();assert.equal(outcome(f,mutate(f,'process',changed,
   f.osKeys.privateKey)).status,'MUTATION_UNKNOWN');
 }
});
test('medium token, disabled Administrators, changed image/publisher, unprotected ACL rejected',()=>{
 for(const changed of [{integrity:'medium'},{administratorsEnabled:false},
  {imageHash:hash('wrong')},{publisherHash:hash('wrong')},{protectedAcl:false}]){
  const f=new Fixture();assert.equal(outcome(f,mutate(f,'process',changed,
   f.osKeys.privateKey)).status,'MUTATION_UNKNOWN');
 }
});
test('readback bound to owner/device/session/CORE epoch/target/PID/FILETIME/intent',()=>{
 const bad=[{ownerId:'wrong'},{deviceId:'wrong'},{sessionId:'wrong'},
  {coreEpoch:6},{ownerEpoch:10},{targetId:'wrong'},{targetGeneration:45},
  {pid:123},{creationFiletime:'133888888888888887'},{machineBootId:'wrong'},
  {intentHash:hash('wrong')},{reservationNonce:'other-reservation'}];
 for(const changed of bad){
  const f=new Fixture();assert.equal(outcome(f,mutate(f,'readback',changed,
   f.observeKeys.privateKey)).status,'MUTATION_UNKNOWN');
 }
});
test('readback before exit, expired or future fails closed',()=>{
 for(const observedAtMs of [ex.exitedAtMs,ex.exitedAtMs-1,now+1,now-31001]){
  const f=new Fixture();assert.equal(outcome(f,mutate(f,'readback',{observedAtMs},
   f.observeKeys.privateKey)).status,'MUTATION_UNKNOWN');
 }
});
test('Hub A crash, duplicate ACK in new Hub B: no redispatch and no ACK-only completion',()=>{
 const f=new Fixture(),ack=hash('transport-ack');
 const hubA={ack:(v:string)=>f.recordAck(v)};
 assert.equal(hubA.ack(ack),'recorded');
 const hubB={ack:(v:string)=>f.recordAck(v),dispatch:()=>f.attemptDispatch()};
 assert.equal(hubB.ack(ack),'duplicate');assert.equal(hubB.ack(ack),'duplicate');
 assert.equal(hubB.dispatch(),false);assert.equal(f.dispatches,1);
 assert.equal(outcome(f,{...f.bundle,readback:undefined}).status,'MUTATION_UNKNOWN');
 assert.equal(outcome(f).status,'COMPLETED_VERIFIED');
});
test('lost external authority record stays UNKNOWN despite new ACK',()=>{
 const f=new Fixture();f.current={...f.current,state:'unknown'};
 assert.equal(f.recordAck(hash('late-ack')),'recorded');
 assert.equal(outcome(f).status,'MUTATION_UNKNOWN');assert.equal(f.attemptDispatch(),false);
});
test('revoked CORE after possible side effect prevents fresh successful admission',()=>{
 const f=new Fixture();assert.equal(outcome(f).status,'COMPLETED_VERIFIED');
 f.current={...f.current,coreEpoch:b.coreEpoch+1};
 assert.equal(outcome(f).status,'MUTATION_UNKNOWN');assert.equal(outcome(f).retrySafe,false);
});
test('owner re-pair rejects pre-revoke OS/process/readback receipts',()=>{
 const f=new Fixture();f.current={...f.current,ownerId:'other-owner',ownerEpoch:b.ownerEpoch+1};
 assert.equal(outcome(f).status,'MUTATION_UNKNOWN');
});
test('unavailable or forged current external authority/root fails closed',()=>{
 const f=new Fixture();
 assert.equal(outcome(f,undefined,{...f.trust(),getLogRoot:()=>undefined}).status,'MUTATION_UNKNOWN');
 assert.equal(outcome(f,undefined,{...f.trust(),getLatest:()=>undefined}).status,'MUTATION_UNKNOWN');
 assert.equal(outcome(f,undefined,{...f.trust(),getLatest:()=>({
  payload:f.current,signature:'fake'})}).status,'MUTATION_UNKNOWN');
});
test('three signed and chained audit segments verify against fresh external root',()=>{
 const f=new Fixture();assert.equal(verifyRotation(f.root.sealed,()=>f.root.latest(),f.externalKeys.publicKey),true);
});
test('rotation missing middle segment, reordering, truncation denied',()=>{
 for(const change of [(a:Segment[])=>a.splice(1,1),
  (a:Segment[])=>a.reverse(),(a:Segment[])=>a.pop()]){
  const f=new Fixture(),segments=clone(f.root.sealed) as Segment[];
  change(segments);assert.equal(verifyRotation(segments,()=>f.root.latest(),f.externalKeys.publicKey),false);
 }
});
test('tampered receipt commitment, seal, sequence or injected secret rejected',()=>{
 for(const change of [
  (a:Segment[])=>{(a[2]!.events[0] as {evidenceHash:string}).evidenceHash=hash('fake')},
  (a:Segment[])=>{(a[1]!.seal as {previousSealHash:string}).previousSealHash=hash('fake')},
  (a:Segment[])=>{(a[2]!.events[0] as {seq:number}).seq=111},
  (a:Segment[])=>{Object.assign(a[0]!.events[0]!,{token:'SECRET_TOKEN'})},
 ]){
  const f=new Fixture(),segments=clone(f.root.sealed) as Segment[];
  change(segments);assert.equal(verifyRotation(segments,()=>f.root.latest(),f.externalKeys.publicKey),false);
 }
});
test('previous valid signed root cannot validate rotated newer log',()=>{
 const f=new Fixture(),old=f.root.latest();
 f.root.append('ack','later-ack');f.root.seal();
 assert.equal(verifyRotation(f.root.sealed,()=>old,f.externalKeys.publicKey),false);
 assert.equal(verifyRotation(f.root.sealed,()=>f.root.latest(),f.externalKeys.publicKey),true);
});
test('external current audit head mismatch with log seal fails closed',()=>{
 const f=new Fixture();f.current={...f.current,auditHeadHash:hash('co-rolled-back')};
 assert.equal(outcome(f).status,'MUTATION_UNKNOWN');
});
test('strict audit projection strips password, token, raw stdout, args and nested credentials',()=>{
 const f=new Fixture(),unsafe={kind:'dispatch',requestId:b.requestId,ownerEpoch:b.ownerEpoch,
  coreEpoch:b.coreEpoch,evidenceHash:hash('opaque-reference'),password:'SECRET_PASSWORD',
  authorization:'Bearer SHHH',stdout:'SECRET_OUTPUT',
  args:['--token=SECRET_TOKEN'],metadata:{privateKey:'PRIVATE_SECRET'}};
 const clean=redactAudit(unsafe),value=JSON.stringify(clean);
 assert.deepEqual(Object.keys(clean).sort(),
  ['kind','requestId','ownerEpoch','coreEpoch','evidenceHash'].sort());
 assert.doesNotMatch(value,/SECRET_|Bearer|SHHH|password|stdout|args|privateKey/);
 assert.doesNotMatch(JSON.stringify(f.bundle.segments),/SECRET_PASSWORD|SECRET_OUTPUT/);
});
test('malformed secret-bearing record rejected without echoing unsafe values',()=>{
 const output=redactAudit({kind:'launch',requestId:'SECRET_REQUEST',token:'SECRET_TOKEN'});
 assert.deepEqual(output,{kind:'rejected'});
});
