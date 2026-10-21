/**
 * P0 #29 continuation: synthetic source-only negative admission and audit provenance.
 * Never invokes real commands, OS APIs, Broker, Agent, UAC, VM or user files.
 * Ed25519 keys and monotonic authority are ephemeral test-only stand-ins.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign, verify, type KeyObject} from 'node:crypto';
const hash = (s:string) => createHash('sha256').update(s).digest('hex');
const validHash = (v:unknown):v is string => typeof v==='string' && /^[0-9a-f]{64}$/.test(v);
const bytes = (v:unknown) => Buffer.from(JSON.stringify(v),'utf8');
const signature = (key:KeyObject,v:unknown) => sign(null,bytes(v),key).toString('base64');
const authentic = (key:KeyObject,v:unknown,s:string) => {
  try{return typeof s==='string' && verify(null,bytes(v),key,Buffer.from(s,'base64'))}catch{return false}
};
type Binding = Readonly<{requestId:string;ownerId:string;deviceId:string;sessionId:string;
 ownerEpoch:number;coreEpoch:number;intentDigest:string;targetId:string;
 targetGeneration:number;expectedDigest:string}>;
const B:Binding = Object.freeze({
 requestId:'29e5fa2a-45ad-4ff0-877f-21e85c71d115',ownerId:'qa-owner',
 deviceId:'qa-device',sessionId:'qa-session',ownerEpoch:11,coreEpoch:7,
 intentDigest:hash('opaque-fixture-command-reference'),targetId:'fixture-target',
 targetGeneration:48,expectedDigest:hash('expected-state'),
});
type Exit = Readonly<{requestId:string;pid:number;startFiletime:string;launchNonce:string;
 stdoutDigest:string;stderrDigest:string;stdoutComplete:boolean;stderrComplete:boolean;
 exitCode:number;exitedAt:number}>;
const X:Exit = Object.freeze({
 requestId:B.requestId,pid:501,startFiletime:'133799000000000001',launchNonce:'fixture-launch-01',
 stdoutDigest:hash('attacker-fabricated-stdout'),stderrDigest:hash(''),
 stdoutComplete:true,stderrComplete:true,exitCode:0,exitedAt:2000,
});
type Readback = Readonly<{kind:'independent_readback';requestId:string;ownerId:string;
 deviceId:string;sessionId:string;ownerEpoch:number;coreEpoch:number;intentDigest:string;targetId:string;
 targetGeneration:number;pid:number;startFiletime:string;launchNonce:string;
 observedDigest:string;observedAt:number;observer:string}>;
type SignedReadback = Readonly<{report:Readback;signature:string}>;
class IndependentFixtureObserver {
 readonly #private:KeyObject;readonly publicKey:KeyObject;
 constructor(){const p=generateKeyPairSync('ed25519');this.#private=p.privateKey;this.publicKey=p.publicKey}
 measure(b:Binding,x:Exit,observedDigest:string,observedAt=x.exitedAt+10):SignedReadback{
  const report:Readback={
   kind:'independent_readback',requestId:b.requestId,ownerId:b.ownerId,deviceId:b.deviceId,
   sessionId:b.sessionId,ownerEpoch:b.ownerEpoch,coreEpoch:b.coreEpoch,intentDigest:b.intentDigest,
   targetId:b.targetId,targetGeneration:b.targetGeneration,pid:x.pid,
   startFiletime:x.startFiletime,launchNonce:x.launchNonce,observedDigest,observedAt,
   observer:'separate-fixture-observer',
  };
  return {report,signature:signature(this.#private,report)};
 }
}
/** Grant generation is a simulated EXTERNAL authority, never restored with Hub state. */
class OwnerAuthority {
 private readonly generations=new Map<string,{ownerId:string;ownerEpoch:number;coreEpoch:number}>();
 initialize(b:Binding){this.generations.set(b.deviceId,{ownerId:b.ownerId,ownerEpoch:b.ownerEpoch,coreEpoch:b.coreEpoch})}
 current(b:Binding){const g=this.generations.get(b.deviceId);return !!g && g.ownerId===b.ownerId &&
  g.ownerEpoch===b.ownerEpoch && g.coreEpoch===b.coreEpoch}
 revoke(b:Binding){const g=this.generations.get(b.deviceId);if(!g)throw Error('NO_GRANT');
  this.generations.set(b.deviceId,{...g,coreEpoch:g.coreEpoch+1})}
 rePair(b:Binding,newOwner:string){const g=this.generations.get(b.deviceId);if(!g)throw Error('NO_GRANT');
  this.generations.set(b.deviceId,{ownerId:newOwner,ownerEpoch:g.ownerEpoch+1,coreEpoch:g.coreEpoch+1})}
}
type Outcome='succeeded'|'failed'|'unknown';
function classify(b:Binding,x:Exit|undefined,s:SignedReadback|undefined,key:KeyObject,owner:OwnerAuthority):Outcome{
 if(!owner.current(b)||!x||!s)return 'unknown';
 if(x.requestId!==b.requestId||!Number.isSafeInteger(x.pid)||x.pid<=0||!x.startFiletime||
   !x.launchNonce||!validHash(x.stdoutDigest)||!validHash(x.stderrDigest)||
   !x.stdoutComplete||!x.stderrComplete||!Number.isSafeInteger(x.exitCode)||
   !Number.isSafeInteger(x.exitedAt))return 'unknown';
 const w=s.report;
 if(!w||!authentic(key,w,s.signature)||w.kind!=='independent_readback'||
  w.observer!=='separate-fixture-observer'||w.requestId!==b.requestId||
  w.ownerId!==b.ownerId||w.deviceId!==b.deviceId||w.sessionId!==b.sessionId||
  w.ownerEpoch!==b.ownerEpoch||w.coreEpoch!==b.coreEpoch||w.intentDigest!==b.intentDigest||
  w.targetId!==b.targetId||w.targetGeneration!==b.targetGeneration||
  w.pid!==x.pid||w.startFiletime!==x.startFiletime||w.launchNonce!==x.launchNonce||
  !Number.isSafeInteger(w.observedAt)||w.observedAt<=x.exitedAt||
  w.observedAt>x.exitedAt+2000||!validHash(w.observedDigest))return 'unknown';
 return x.exitCode!==0||w.observedDigest!==b.expectedDigest?'failed':'succeeded';
}
type Reservation={binding:Binding;status:'reserved'|'dispatched'|'unknown';
 dispatches:number;ackFingerprints:Set<string>};
/** Independent synthetic linearizable CAS; deliberately not a real durable store. */
class ReservationAuthority {
 readonly #ids=new Map<string,Reservation>();readonly #intents=new Map<string,string>();
 constructor(readonly owners:OwnerAuthority){}
 reserve(b:Binding){
  if(!this.owners.current(b)||this.#ids.has(b.requestId))return false;
  const fingerprint=hash(JSON.stringify([b.deviceId,b.ownerId,b.intentDigest]));
  if(this.#intents.has(fingerprint))return false;
  this.#ids.set(b.requestId,{binding:b,status:'reserved',dispatches:0,ackFingerprints:new Set()});
  this.#intents.set(fingerprint,b.requestId);return true;
 }
 dispatchOnce(b:Binding){
  const r=this.#ids.get(b.requestId);
  if(!r||!this.owners.current(b)||r.status!=='reserved'||
    JSON.stringify(r.binding)!==JSON.stringify(b))return false;
  r.status='dispatched';r.dispatches++;return true;
 }
 lostAck(b:Binding){const r=this.#ids.get(b.requestId);if(r?.status==='dispatched')r.status='unknown'}
 ack(b:Binding,fingerprint:string):'recorded'|'duplicate'|'untrusted'{
  const r=this.#ids.get(b.requestId);
  if(!r||JSON.stringify(b)!==JSON.stringify(r.binding)||!validHash(fingerprint))return 'untrusted';
  if(r.ackFingerprints.has(fingerprint))return 'duplicate';
  r.ackFingerprints.add(fingerprint);return 'recorded'; // no status change
 }
 status(b:Binding){const r=this.#ids.get(b.requestId);return r&&this.owners.current(b)?r.status:'unknown'}
 dispatchCount(b:Binding){return this.#ids.get(b.requestId)?.dispatches??0}
}
class Hub {
 constructor(readonly external:ReservationAuthority){}
 reserve(b:Binding){return this.external.reserve(b)}
 dispatch(b:Binding){return this.external.dispatchOnce(b)}
 ack(b:Binding,ref:string){return this.external.ack(b,ref)}
 status(b:Binding){return this.external.status(b)}
}
type Kind='reserve'|'launch'|'exit'|'readback_ref'|'ack'|'unknown'|'revoke';
type Event={seq:number;segmentIndex:number;kind:Kind;requestId:string;
 ownerEpoch:number;coreEpoch:number;refDigest:string;prevHash:string;hash:string};
type Checkpoint={seq:number;headHash:string;signature:string};
type Segment={index:number;startSeq:number;parent:Checkpoint;records:Event[];closedAt?:Checkpoint};
const GENESIS=hash('qa29-segmented-audit-genesis');
const checkpointData=(a:Checkpoint)=>({seq:a.seq,headHash:a.headHash});
const same=(a:Checkpoint,b:Checkpoint)=>a.seq===b.seq&&a.headHash===b.headHash&&a.signature===b.signature;
const eventHash=(e:Omit<Event,'hash'>)=>hash(JSON.stringify(e));
class MonotonicRoot {
 readonly #private:KeyObject;readonly publicKey:KeyObject;#seq=0;#head=GENESIS;
 constructor(){const p=generateKeyPairSync('ed25519');this.#private=p.privateKey;this.publicKey=p.publicKey}
 latest():Checkpoint{const data={seq:this.#seq,headHash:this.#head};
  return {...data,signature:signature(this.#private,data)}}
 commit(seq:number,prev:string,head:string){
  if(seq!==this.#seq+1||prev!==this.#head||!validHash(head))throw Error('CAS_CONFLICT');
  this.#seq=seq;this.#head=head;
 }
}
class RotatingLog {
 readonly segments:Segment[];
 constructor(readonly root:MonotonicRoot){
  this.segments=[{index:0,startSeq:1,parent:root.latest(),records:[]}];
 }
 append(kind:Kind,b:Binding,refDigest:string){
  if(!validHash(refDigest)||!['reserve','launch','exit','readback_ref','ack','unknown','revoke'].includes(kind))
    throw Error('AUDIT_UNSAFE_FIELD');
  const seg=this.segments.at(-1)!,latest=this.root.latest();
  const e:Omit<Event,'hash'>={seq:latest.seq+1,segmentIndex:seg.index,kind,
    requestId:b.requestId,ownerEpoch:b.ownerEpoch,coreEpoch:b.coreEpoch,
    refDigest,prevHash:latest.headHash};
  const full={...e,hash:eventHash(e)};this.root.commit(full.seq,latest.headHash,full.hash);
  seg.records.push(full);
 }
 rotate(){
  const seg=this.segments.at(-1)!;
  if(!seg.records.length)throw Error('EMPTY_ROTATION_DENIED');
  seg.closedAt=this.root.latest();
  this.segments.push({index:seg.index+1,startSeq:seg.closedAt.seq+1,
    parent:seg.closedAt,records:[]});
 }
}
/** Always fetches fresh external checkpoint, not a caller-supplied old signed witness. */
function checkRotated(segments:readonly Segment[],freshRoot:()=>Checkpoint|undefined,key:KeyObject):boolean{
 try{
  const latest=freshRoot();
  if(!latest||!authentic(key,checkpointData(latest),latest.signature)||
    !Number.isSafeInteger(latest.seq)||latest.seq<0||!validHash(latest.headHash)||
    segments.length<1||segments.length>32)return false;
  let seq=0,head=GENESIS,checkpoint=segments[0]!.parent;
  if(checkpoint.seq!==0||checkpoint.headHash!==GENESIS||
    !authentic(key,checkpointData(checkpoint),checkpoint.signature))return false;
  for(let i=0;i<segments.length;i++){
   const s=segments[i];
   if(!s||s.index!==i||s.startSeq!==seq+1||!same(s.parent,checkpoint)||
      !authentic(key,checkpointData(s.parent),s.parent.signature)||
      (i<segments.length-1&&!s.records.length)||s.records.length>128)return false;
   for(const e of s.records){
    if(!e||e.seq!==seq+1||e.segmentIndex!==i||e.prevHash!==head||
      !validHash(e.refDigest)||!validHash(e.hash)||e.requestId!==B.requestId||
      !Number.isSafeInteger(e.ownerEpoch)||e.ownerEpoch<=0||
      !Number.isSafeInteger(e.coreEpoch)||e.coreEpoch<=0||
      !['reserve','launch','exit','readback_ref','ack','unknown','revoke'].includes(e.kind))return false;
    const {hash:claimed,...unsigned}=e;
    if(eventHash(unsigned)!==claimed)return false;
    seq++;head=claimed;
   }
   if(i<segments.length-1){
    const closed=s.closedAt;
    if(!closed||closed.seq!==seq||closed.headHash!==head||
      !authentic(key,checkpointData(closed),closed.signature))return false;
    checkpoint=closed;
   }else if(s.closedAt)return false;
  }
  return latest.seq===seq&&latest.headHash===head;
 }catch{return false}
}
function rotatedFixture(){
 const root=new MonotonicRoot(),log=new RotatingLog(root);
 log.append('reserve',B,hash('reserve-ref'));log.append('launch',B,hash('launch-ref'));
 log.rotate();log.append('exit',B,hash('exit-ref'));
 log.append('readback_ref',B,hash('signed-witness-ref'));
 log.rotate();log.append('ack',B,hash('ack-ref'));return {root,log};
}
test('forged stdout and zero exit are not independently verified postcondition',()=>{
 const o=new OwnerAuthority();o.initialize(B);const w=new IndependentFixtureObserver();
 assert.equal(classify(B,X,undefined,w.publicKey,o),'unknown');
 assert.equal(classify(B,{...X,stdoutDigest:hash('forged-output')},undefined,w.publicKey,o),'unknown');
});
test('separate readback signer proves matching observation in fixture only',()=>{
 const o=new OwnerAuthority();o.initialize(B);const w=new IndependentFixtureObserver();
 assert.equal(classify(B,X,w.measure(B,X,B.expectedDigest),w.publicKey,o),'succeeded');
});
test('authenticated mismatching postcondition defeats exitCode=0',()=>{
 const o=new OwnerAuthority();o.initialize(B);const w=new IndependentFixtureObserver();
 assert.equal(classify(B,X,w.measure(B,X,hash('not-changed')),w.publicKey,o),'failed');
});
test('forged report contents and caller-approved flag cannot counterfeit signature',()=>{
 const o=new OwnerAuthority();o.initialize(B);const w=new IndependentFixtureObserver();
 const genuine=w.measure(B,X,hash('not-changed'));
 assert.equal(classify(B,X,{...genuine,report:{...genuine.report,observedDigest:B.expectedDigest}},w.publicKey,o),'unknown');
 const fake={report:{...genuine.report,approved:true},signature:'fake'} as SignedReadback;
 assert.equal(classify(B,X,fake,w.publicKey,o),'unknown');
});
test('wrong target, generation, session, epoch, device or run nonce rejects readback',()=>{
 const o=new OwnerAuthority();o.initialize(B);const w=new IndependentFixtureObserver();
 for(const d of [{targetId:'other'},{targetGeneration:49},{sessionId:'old'},
  {coreEpoch:6},{ownerEpoch:10},{intentDigest:hash('other-intent')},
  {requestId:'other'},{deviceId:'other'}]){
  assert.equal(classify(B,X,w.measure({...B,...d},X,B.expectedDigest),w.publicKey,o),'unknown');
 }
 assert.equal(classify(B,X,w.measure(B,{...X,launchNonce:'old-process'},B.expectedDigest),w.publicKey,o),'unknown');
 assert.equal(classify(B,X,w.measure(B,{...X,pid:502},B.expectedDigest),w.publicKey,o),'unknown');
 assert.equal(classify(B,X,w.measure(B,{...X,startFiletime:'old-filetime'},B.expectedDigest),w.publicKey,o),'unknown');
});
test('readback before process exit or excessively stale fails closed',()=>{
 const o=new OwnerAuthority();o.initialize(B);const w=new IndependentFixtureObserver();
 for(const t of [1999,2000,4001])
  assert.equal(classify(B,X,w.measure(B,X,B.expectedDigest,t),w.publicKey,o),'unknown');
});
test('nonzero exit remains FAILED even with true independent readback',()=>{
 const o=new OwnerAuthority();o.initialize(B);const w=new IndependentFixtureObserver();
 assert.equal(classify(B,{...X,exitCode:7},w.measure(B,X,B.expectedDigest),w.publicKey,o),'failed');
});
test('Hub restart and duplicate ACK do not replay dispatch or clear UNKNOWN',()=>{
 const o=new OwnerAuthority();o.initialize(B);const external=new ReservationAuthority(o);
 const a=new Hub(external);assert.equal(a.reserve(B),true);assert.equal(a.dispatch(B),true);
 const ack=hash('transport-ack');
 assert.equal(a.ack(B,ack),'recorded'); // recorded in external authority before Hub A crash
 external.lostAck(B); // outcome commit lost; ACK does not independently establish postcondition
 const b=new Hub(external); // Hub A replaced; no Hub-local dedupe memory retained
 assert.equal(b.ack(B,ack),'duplicate');assert.equal(b.ack(B,ack),'duplicate');
 assert.equal(b.status(B),'unknown');assert.equal(b.dispatch(B),false);
 assert.equal(b.reserve(B),false);assert.equal(external.dispatchCount(B),1);
});
test('two Hub contenders cannot both dispatch same reservation',()=>{
 const o=new OwnerAuthority();o.initialize(B);const external=new ReservationAuthority(o);
 const a=new Hub(external),b=new Hub(external);assert.equal(a.reserve(B),true);
 assert.deepEqual([a.dispatch(B),b.dispatch(B)],[true,false]);assert.equal(external.dispatchCount(B),1);
});
test('new requestId cannot replay same uncertain intent after crash',()=>{
 const o=new OwnerAuthority();o.initialize(B);const e=new ReservationAuthority(o);
 assert.equal(e.reserve(B),true);assert.equal(e.dispatchOnce(B),true);e.lostAck(B);
 assert.equal(e.reserve({...B,requestId:'new-request-id'}),false);
 assert.equal(e.dispatchCount(B),1);
});
test('ACK from mismatching request or CORE epoch is untrusted',()=>{
 const o=new OwnerAuthority();o.initialize(B);const e=new ReservationAuthority(o);
 e.reserve(B);e.dispatchOnce(B);e.lostAck(B);
 assert.equal(e.ack({...B,coreEpoch:6},hash('ack')),'untrusted');
 assert.equal(e.ack({...B,requestId:'another'},hash('ack')),'untrusted');
 assert.equal(e.status(B),'unknown');
});
test('unmodified three rotated audit segments verify against external root',()=>{
 const {root,log}=rotatedFixture();
 assert.equal(checkRotated(log.segments,()=>root.latest(),root.publicKey),true);
});
test('missing middle segment, reordering and tail truncation fail closed',()=>{
 const {root,log}=rotatedFixture(),s=structuredClone(log.segments);
 assert.equal(checkRotated([s[0]!,s[2]!],()=>root.latest(),root.publicKey),false);
 assert.equal(checkRotated([s[1]!,s[0]!,s[2]!],()=>root.latest(),root.publicKey),false);
 s[2]!.records.pop();
 assert.equal(checkRotated(s,()=>root.latest(),root.publicKey),false);
});
test('tampered digest, parent checkpoint, seal, seq and segment index fail closed',()=>{
 for(const alter of [
  (s:Segment[])=>{s[1]!.records[0]!.refDigest=hash('fake')},
  (s:Segment[])=>{s[1]!.parent=s[0]!.parent},
  (s:Segment[])=>{s[0]!.closedAt=s[0]!.parent},
  (s:Segment[])=>{s[1]!.startSeq++},
  (s:Segment[])=>{s[2]!.index=12},
 ]){
  const {root,log}=rotatedFixture(),s=structuredClone(log.segments);alter(s);
  assert.equal(checkRotated(s,()=>root.latest(),root.publicKey),false);
 }
});
test('old signed local snapshot rejected by fresh external checkpoint; missing root denies',()=>{
 const {root,log}=rotatedFixture(),old=structuredClone(log.segments),stale=root.latest();
 log.append('unknown',B,hash('newer-state'));
 assert.notDeepEqual(stale,root.latest());
 assert.equal(checkRotated(old,()=>root.latest(),root.publicKey),false);
 assert.equal(checkRotated(old,()=>undefined,root.publicKey),false);
});
test('empty rotation, raw credential fields and duplicate audit entries rejected',()=>{
 const root=new MonotonicRoot(),log=new RotatingLog(root);
 assert.throws(()=>log.rotate(),/EMPTY_ROTATION_DENIED/);
 assert.throws(()=>log.append('launch',B,'raw token'),/AUDIT_UNSAFE_FIELD/);
 log.append('reserve',B,hash('opaque'));
 const duplicate=structuredClone(log.segments);
 duplicate[0]!.records.push(structuredClone(duplicate[0]!.records[0]!));
 assert.equal(checkRotated(duplicate,()=>root.latest(),root.publicKey),false);
 assert.doesNotMatch(JSON.stringify(log.segments),/password|raw token|access_token|private.key/i);
});
test('revoked CORE epoch cannot authenticate current success using pre-revoke receipt',()=>{
 const o=new OwnerAuthority();o.initialize(B);const w=new IndependentFixtureObserver();
 const proof=w.measure(B,X,B.expectedDigest);
 assert.equal(classify(B,X,proof,w.publicKey,o),'succeeded');
 o.revoke(B);assert.equal(classify(B,X,proof,w.publicKey,o),'unknown');
});
test('revocation between reserve and dispatch survives Hub crash',()=>{
 const o=new OwnerAuthority();o.initialize(B);const e=new ReservationAuthority(o);
 assert.equal(new Hub(e).reserve(B),true);o.revoke(B);
 const hub2=new Hub(e);assert.equal(hub2.dispatch(B),false);
 assert.equal(hub2.status(B),'unknown');assert.equal(e.dispatchCount(B),0);
});
test('owner re-pair refuses old epoch and requires fresh owner-bound reservation',()=>{
 const o=new OwnerAuthority();o.initialize(B);const e=new ReservationAuthority(o);
 assert.equal(e.reserve(B),true);o.rePair(B,'new-owner');
 assert.equal(e.dispatchOnce(B),false);
 assert.equal(e.reserve({...B,requestId:'stale'}),false);
 const fresh={...B,ownerId:'new-owner',ownerEpoch:12,coreEpoch:8,
  requestId:'new-enrollment',intentDigest:hash('new-approved-intent')};
 assert.equal(e.reserve(fresh),true);assert.equal(e.dispatchOnce(fresh),true);
 assert.equal(e.dispatchCount(B),0);assert.equal(e.dispatchCount(fresh),1);
});
