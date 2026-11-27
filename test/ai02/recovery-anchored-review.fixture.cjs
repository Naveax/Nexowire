// Explicit local review harness. No runtime export or real provider. Run with
// NODE_PATH=<typescript install> node --test test/ai02/recovery-anchored-review.fixture.cjs
const {test}=require('node:test');const assert=require('node:assert/strict');
const {readFileSync,writeFileSync,mkdtempSync,openSync,fsyncSync,closeSync,renameSync,rmSync}=require('node:fs');const {tmpdir}=require('node:os');const {resolve}=require('node:path');
const {generateKeyPairSync,sign,createHash,randomUUID}=require('node:crypto');
const ts=require('typescript');const Module=require('node:module');
const file=resolve(__dirname,'../../src/security/recovery-anchored-authority-review.ts');
const original=readFileSync(file,'utf8');
const production=ts.transpileModule(original,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},reportDiagnostics:true});
assert.equal(production.diagnostics.length,0);
const load=(code)=>{const m=new Module(file,module);m.filename=file;m._compile(code,file);return m.exports;};
const pub=load(production.outputText);
assert.deepEqual(Object.keys(pub),['independentRecoveryUnavailable']);
const internal=load(ts.transpileModule(original+'\nexport {stageConsume,stageTerminal,signFreshConsume,canonicalJson,verifyExactAck,reconstructWitnessAhead,transitionDigest,writers};',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText);
const {stageConsume,stageTerminal,signFreshConsume,canonicalJson,verifyExactAck,reconstructWitnessAhead,transitionDigest,writers}=internal;
const hex=c=>c.repeat(64);
const dirs=[];test.after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
// A file-backed model, not a separately operated provider. All updates use a
// same-directory atomic rename and fsync file + directory; reads re-open bytes
// instead of relying on process-local flags. One test process owns the fixture.
function witnessDisk(genesis,epoch){
 const dir=mkdtempSync(resolve(tmpdir(),'nx02-witness-fixture-'));dirs.push(dir);
 const path=resolve(dir,'head.json'),tmp=resolve(dir,'next.json');
 const read=()=>JSON.parse(readFileSync(path,'utf8'));
 const write=x=>{const fd=openSync(tmp,'w',0o600);try{writeFileSync(fd,JSON.stringify(x));fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,path);const d=openSync(dir,'r');try{fsyncSync(d);}finally{closeSync(d);}};
 write({head:genesis,epoch,state:'IDLE',transition:null});return {read,write};
}
function fixture(mode='ok'){
 const scope=Object.freeze({authorityId:randomUUID(),storeId:randomUUID(),deviceId:randomUUID(),ownerAccountId:randomUUID(),ownerEpoch:'1',directoryHead:hex('a'),installationLineageId:randomUUID(),resourceId:randomUUID(),bootId:randomUUID(),sessionEpoch:randomUUID(),generation:'1',purpose:'rollback',transactionSha256:hex('b'),authorizationId:randomUUID(),attemptId:randomUUID(),requestId:randomUUID(),challenge:hex('c'),requestSha256:hex('d'),bindingSha256:hex('e'),envelopeSha256:hex('f'),signerSpkiSha256:hex('1'),deadlineMs:Date.now()+20000});
 const lease=randomUUID(),genesis={sequence:'0',hash:hex('0')};let dbHead=genesis,row,staged,stagedHead,release=[],queries=[],appends=0,signs=0,coverageMode='ok';
 const disk=witnessDisk(genesis,scope.directoryHead);
 const copy=x=>JSON.parse(JSON.stringify(x));
 const pool={async connect(){return {async query(sql,v=[]){queries.push(sql);
 if(sql==='BEGIN'){staged=row;stagedHead=dbHead;return {rows:[]};}
 if(sql.startsWith('SET LOCAL'))return {rows:[]};
 if(sql.includes('lock_recovery_anchor'))return {rows:[{lifecycle_store_id:scope.storeId,lifecycle_sequence:dbHead.sequence,lifecycle_head:dbHead.hash}]};
 if(sql.startsWith('SELECT id FROM helper_selection.leases'))return {rows:row?.state==='ACTIVE'?[row]:[]};
 if(sql.includes("kind='RECOVERY'"))return {rows:staged?[staged]:[]};
 if(sql.includes('clock_timestamp'))return {rows:[{ms:String(Date.now())}]};
 if(sql.includes('stage_recovery_consume')||sql.includes('restore_recovery_consume')){if(row)throw Error('REPLAY');staged={id:v[1],state:'ACTIVE',lifecycle_scope:JSON.parse(v[0]),consume_sequence:String(BigInt(v[2])+1n),consume_head:v[4]};stagedHead={sequence:staged.consume_sequence,hash:v[4]};return {rows:[{id:v[1]}]};}
 if(sql.includes('stage_recovery_terminal')){staged={...row,state:'RELEASED',terminal_sequence:String(BigInt(v[4])+1n),terminal_head:v[6],terminal_outcome:v[7],terminal_evidence_sha256:v[8]};stagedHead={sequence:staged.terminal_sequence,hash:v[6]};return {rows:[{id:v[1]}]};}
 if(sql==='ROLLBACK'){staged=row;stagedHead=dbHead;return {rows:[]};}
 if(sql==='COMMIT'){if(mode==='commit-before')throw Error('commit lost before persistence');row=staged;dbHead=stagedHead;if(mode==='commit-after')throw Error('commit reply lost');return {rows:[]};}
 throw Error('unexpected SQL '+sql);},release(destroy){release.push(destroy);}};}};
 const eq=(a,b)=>canonicalJson(a)===canonicalJson(b);
 const trust={async admit(){return scope;},
 async verifyLocked(_db,s,h){const w=disk.read();if(['PENDING','APPENDED','FROZEN'].includes(w.state)||s.directoryHead!==w.epoch||!eq(h,w.head))throw Error('STALE_OR_FROZEN');
   const participants=writers.map(writer=>({writer,state:'FENCED',evidenceSha256:hex('6')}));if(coverageMode==='missing')participants.pop();if(coverageMode==='duplicate')participants[0]=participants[1];
   return {...s,head:h,nativeFenceSha256:hex('7'),expiresMs:s.deadlineMs,participants};},
 async preparePending(t){const w=disk.read();if(!eq(w.head,t.previous)||w.epoch!==(t.kind==='CONSUME'?t.scope.directoryHead:t.operator.directoryHead)||
   (t.kind==='CONSUME'?w.state!=='IDLE':!['CONSUMED','FROZEN'].includes(w.state)||w.transition?.leaseId!==t.leaseId||!eq(w.head,t.originalConsume)))throw Error('STALE_OR_FROZEN');
   disk.write({...w,state:'PENDING',transition:t});if(mode==='prepare-lost'||mode==='prepare-freeze-lost')throw Error('prepare reply lost');
   return {state:'PENDING',transitionSha256:mode==='wrong-pending'?hex('0'):transitionDigest(t)};},
 async compareAndAppend(t){appends++;let w=disk.read();if(mode==='epoch-race'){disk.write({...w,epoch:hex('2')});w=disk.read();}
   if(w.state!=='PENDING'||!eq(w.transition,t)||w.epoch!==(t.kind==='CONSUME'?t.scope.directoryHead:t.operator.directoryHead)||!eq(t.previous,w.head))throw Error('STALE_HEAD_OR_EPOCH');
   disk.write({...w,head:t.next,state:'APPENDED'});if(mode==='append-lost')throw Error('lost witness response');return {head:t.next,transitionKind:t.kind,leaseId:t.leaseId,directoryHead:mode==='wrong-receipt'?hex('3'):w.epoch};},
 async freezeUnknown(t){const w=disk.read();if(!eq(w.transition,t))throw Error('wrong freeze scope');if(mode==='prepare-freeze-lost')throw Error('freeze unavailable before persistence');disk.write({...w,state:'FROZEN'});if(mode==='freeze-lost')throw Error('freeze response lost');},
 async verifyTerminalLocked(){const w=disk.read();return {ownerAccountId:scope.ownerAccountId,ownerEpoch:'2',directoryHead:w.epoch};},
 async readback(t){const w=disk.read();if(mode==='readback-lost'||mode==='freeze-lost'||!eq(dbHead,t.next)||!eq(w.head,t.next)||!eq(w.transition,t)||(t.kind==='CONSUME'&&w.epoch!==t.scope.directoryHead)||!['APPENDED','CONSUMED','TERMINAL'].includes(w.state))throw Error('READBACK');disk.write({...w,state:t.kind==='CONSUME'?'CONSUMED':'TERMINAL'});},
 async readFrozenLocked(){const w=disk.read();if(w.state!=='FROZEN')throw Error('WITNESS_NOT_FROZEN');return {state:'FROZEN',head:w.head,transition:w.transition};},
 async readbackFrozen(t){const w=disk.read();if(w.state!=='FROZEN'||!eq(w.head,t.next)||!eq(w.transition,t)||!eq(dbHead,t.next))throw Error('FROZEN_READBACK_DENIED');}
 };
 const keys=generateKeyPairSync('ed25519');const pin=createHash('sha256').update(keys.publicKey.export({type:'spki',format:'der'})).digest('hex');
 const signer={async signCommitted(ack){signs++;if(mode==='sign-lost')throw Error('SIGN_LOST');const bytes=Buffer.from(canonicalJson(ack));return Buffer.concat([sign(null,bytes,keys.privateKey),bytes]);},async verifyForNativeEffect(packet,ack){verifyExactAck(packet.subarray(64),packet.subarray(0,64),keys.publicKey,pin,ack,Date.now());}};
 return {scope,lease,pool,trust,signer,keys,pin,rotate(){const w=disk.read();disk.write({...w,epoch:hex('2')});},restore(){dbHead=genesis;row=undefined;},
  normal(){mode='ok';},coverage(v){coverageMode=v;},snapshot(){return {dbHead:copy(dbHead),row:row&&copy(row)};},restoreSnapshot(s){dbHead=s.dbHead;row=s.row;},
  unanchoredCommit(){dbHead={sequence:'1',hash:hex('9')};row={id:lease,state:'ACTIVE'};},
  corruptLocalRow(){row={...row,consume_head:hex('9')};},status(){const w=disk.read();return {dbHead,externalHead:w.head,row,freeze:w.state==='FROZEN',pending:w.state,transition:w.transition,release,queries,appends,signs};}};
}
const consume=f=>stageConsume(f.pool,f.trust,f.scope,f.lease);
test('public runtime remains unavailable',()=>assert.throws(pub.independentRecoveryUnavailable,/NOT_PROVISIONED/));
test('fresh exact consume, one ACK, replay blocked',async()=>{const f=fixture();const t=await consume(f);assert.ok((await signFreshConsume(t,f.trust,f.signer)).length>64);await assert.rejects(signFreshConsume(t,f.trust,f.signer),/REPLAY/);await assert.rejects(signFreshConsume({...t},f.trust,f.signer),/REPLAY/);await assert.rejects(consume(f),/OCCUPIED/);assert.equal(f.status().signs,1);});
for(const mode of ['epoch-race','append-lost','wrong-receipt','commit-before','commit-after','readback-lost','freeze-lost'])test(mode+' fail closed',async()=>{const f=fixture(mode);await assert.rejects(consume(f),/UNKNOWN_FREEZE/);const s=f.status();assert.equal(s.freeze,true);assert.equal(s.signs,0);assert.equal(s.release.length,1);assert.equal(s.release[0],mode.startsWith('commit-'));if(mode.startsWith('commit-'))assert.equal(s.queries.includes('ROLLBACK'),false);await assert.rejects(consume(f),/STALE_OR_FROZEN/);});
test('owner rotation after consume denies ACK',async()=>{const f=fixture();const t=await consume(f);f.rotate();await assert.rejects(signFreshConsume(t,f.trust,f.signer),/UNKNOWN_FREEZE/);assert.equal(f.status().signs,0);});
test('stale restored PG head denied by external witness',async()=>{const f=fixture();await consume(f);f.restore();await assert.rejects(consume(f),/STALE_OR_FROZEN/);assert.equal(f.status().appends,1);});
test('signer failure burns ACK attempt',async()=>{const f=fixture('sign-lost');const t=await consume(f);await assert.rejects(signFreshConsume(t,f.trust,f.signer),/UNKNOWN_FREEZE/);await assert.rejects(signFreshConsume(t,f.trust,f.signer),/REPLAY/);});
test('terminal is status-only, current operator directory anchored',async()=>{const f=fixture();const t=await consume(f);f.rotate();assert.equal(await stageTerminal(f.pool,f.trust,t,{outcome:'NO_EFFECT',evidenceSha256:hex('4')},Buffer.from('synthetic')),undefined);assert.equal(f.status().row.state,'RELEASED');assert.equal(f.status().signs,0);});
test('actual Ed25519 signature rejects wrong purpose, pin, modified bytes, expiry',()=>{const f=fixture();const now=Date.now();const ack={domain:'nexowire.recovery.consume-ack.v1',scope:f.scope,leaseId:f.lease,head:{sequence:'1',hash:hex('2')},state:'CONSUMED',issuedMs:now,expiresMs:now+1000};const b=Buffer.from(canonicalJson(ack)),sig=sign(null,b,f.keys.privateKey);verifyExactAck(b,sig,f.keys.publicKey,f.pin,ack,now);for(const [bytes,pin,expected,time] of [[b,hex('0'),ack,now],[b,f.pin,{...ack,scope:{...ack.scope,purpose:'coordinated-uninstall'}},now],[Buffer.concat([b,Buffer.from(' ')]),f.pin,ack,now],[b,f.pin,ack,now+1000]])assert.throws(()=>verifyExactAck(bytes,sig,f.keys.publicKey,pin,expected,time),/ACK_DENIED/);});
test('lost transport ACK after signing retains occupied tombstone; no second ACK',async()=>{const f=fixture();const t=await consume(f);await signFreshConsume(t,f.trust,f.signer); // caller never receives packet
 await assert.rejects(consume(f),/OCCUPIED/);await assert.rejects(signFreshConsume(t,f.trust,f.signer),/REPLAY/);assert.equal(f.status().row.state,'ACTIVE');assert.equal(f.status().signs,1);});
test('owner rotates during signature, post-sign readback suppresses ACK',async()=>{const f=fixture();const t=await consume(f);const rotating={...f.signer,async signCommitted(ack){const packet=await f.signer.signCommitted(ack);f.rotate();return packet;}};await assert.rejects(signFreshConsume(t,f.trust,rotating),/UNKNOWN_FREEZE/);assert.equal(f.status().signs,1);assert.equal(f.status().freeze,true);});

const repair=f=>reconstructWitnessAhead(f.pool,f.trust,f.scope.authorityId,f.scope.storeId,Buffer.from('fixture-only operator proof'));
test('missing or duplicate writer receipt denies before prepare/SQL',async()=>{for(const mode of ['missing','duplicate']){const f=fixture();f.coverage(mode);await assert.rejects(consume(f),/WRITER_FENCE_INCOMPLETE/);assert.equal(f.status().pending,'IDLE');assert.equal(f.status().appends,0);assert.ok(!f.status().queries.some(x=>x.includes('stage_recovery_consume')));}});
test('durable prepare reply and freeze RPC lost; persisted pending prevents replay',async()=>{const f=fixture('prepare-freeze-lost');await assert.rejects(consume(f),/FREEZE_UNCONFIRMED/);assert.equal(f.status().pending,'PENDING');assert.equal(f.status().appends,0);f.normal();await assert.rejects(consume(f),/STALE_OR_FROZEN/);assert.equal(f.status().signs,0);});
test('wrong prepare receipt cannot stage SQL or ACK',async()=>{const f=fixture('wrong-pending');await assert.rejects(consume(f),/UNKNOWN_FREEZE/);assert.equal(f.status().freeze,true);assert.equal(f.status().appends,0);assert.ok(!f.status().queries.some(x=>x.includes('stage_recovery_consume')));});
test('witness-ahead original consume reconstructed once, never signed or thawed',async()=>{const f=fixture('commit-before');await assert.rejects(consume(f),/UNKNOWN_FREEZE/);const t=f.status().transition;assert.equal(f.status().row,undefined);f.normal();assert.equal(await repair(f),'FROZEN_RECONSTRUCTED');assert.equal(f.status().row.state,'ACTIVE');assert.equal(await repair(f),'FROZEN_ALREADY_PRESENT');assert.equal(f.status().freeze,true);assert.equal(f.status().appends,1);await assert.rejects(signFreshConsume(t,f.trust,f.signer),/REPLAY/);await assert.rejects(consume(f),/STALE_OR_FROZEN/);assert.equal(f.status().signs,0);});
test('ambiguous commit after persistence reconciles only original exact row',async()=>{const f=fixture('commit-after');await assert.rejects(consume(f),/UNKNOWN_FREEZE/);f.normal();assert.equal(await repair(f),'FROZEN_ALREADY_PRESENT');f.corruptLocalRow();await assert.rejects(repair(f),/ROW_DIVERGENCE/);assert.equal(f.status().freeze,true);});
test('terminal witness-ahead replay is status-only and retains freeze',async()=>{const f=fixture();const t=await consume(f);const before=f.snapshot();const terminal={outcome:'NO_EFFECT',evidenceSha256:hex('4')};await stageTerminal(f.pool,f.trust,t,terminal,Buffer.from('fixture'));const terminalTransition=f.status().transition;await f.trust.freezeUnknown(terminalTransition);f.restoreSnapshot(before);assert.equal(await repair(f),'FROZEN_RECONSTRUCTED');assert.equal(f.status().row.state,'RELEASED');assert.equal(f.status().freeze,true);assert.equal(f.status().appends,2);assert.equal(f.status().signs,0);});
test('unanchored local commit counterexample never becomes permission',async()=>{const f=fixture();f.unanchoredCommit();assert.notDeepEqual(f.status().dbHead,f.status().externalHead);await assert.rejects(consume(f),/STALE_OR_FROZEN/);await assert.rejects(repair(f),/NOT_FROZEN/);assert.equal(f.status().signs,0);});
test('corrupted witness transition or mismatched predecessor cannot reconstruct',async()=>{const f=fixture('commit-before');await assert.rejects(consume(f),/UNKNOWN_FREEZE/);f.normal();const original=f.trust.readFrozenLocked;f.trust.readFrozenLocked=async()=>{const p=await original();return {...p,transition:{...p.transition,leaseId:randomUUID()}};};await assert.rejects(repair(f),/HISTORY_CHAIN_DENIED/);f.trust.readFrozenLocked=original;f.unanchoredCommit();await assert.rejects(repair(f),/LOCAL_HEAD_DIVERGENCE/);assert.equal(f.status().signs,0);});
