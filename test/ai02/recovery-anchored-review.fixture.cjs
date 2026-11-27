// Explicit local review harness. No runtime export or real provider. Run with
// NODE_PATH=<typescript install> node --test test/ai02/recovery-anchored-review.fixture.cjs
const {test}=require('node:test');const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');const {resolve}=require('node:path');
const {generateKeyPairSync,sign,createHash,randomUUID}=require('node:crypto');
const ts=require('typescript');const Module=require('node:module');
const file=resolve(__dirname,'../../src/security/recovery-anchored-authority-review.ts');
const original=readFileSync(file,'utf8');
const production=ts.transpileModule(original,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},reportDiagnostics:true});
assert.equal(production.diagnostics.length,0);
const load=(code)=>{const m=new Module(file,module);m.filename=file;m._compile(code,file);return m.exports;};
const pub=load(production.outputText);
assert.deepEqual(Object.keys(pub),['independentRecoveryUnavailable']);
const internal=load(ts.transpileModule(original+'\nexport {stageConsume,stageTerminal,signFreshConsume,canonicalJson,verifyExactAck};',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText);
const {stageConsume,stageTerminal,signFreshConsume,canonicalJson,verifyExactAck}=internal;
const hex=c=>c.repeat(64);
function fixture(mode='ok'){
 const scope=Object.freeze({authorityId:randomUUID(),storeId:randomUUID(),deviceId:randomUUID(),ownerAccountId:randomUUID(),ownerEpoch:'1',directoryHead:hex('a'),installationLineageId:randomUUID(),resourceId:randomUUID(),bootId:randomUUID(),sessionEpoch:randomUUID(),generation:'1',purpose:'rollback',transactionSha256:hex('b'),authorizationId:randomUUID(),attemptId:randomUUID(),requestId:randomUUID(),challenge:hex('c'),requestSha256:hex('d'),bindingSha256:hex('e'),envelopeSha256:hex('f'),signerSpkiSha256:hex('1'),deadlineMs:Date.now()+20000});
 const lease=randomUUID(),genesis={sequence:'0',hash:hex('0')};let dbHead=genesis,externalHead=genesis,row,staged,epoch=scope.directoryHead,freeze=false,release=[],queries=[],appends=0,signs=0;
 const pool={async connect(){return {async query(sql,v=[]){queries.push(sql);
 if(sql==='BEGIN'||sql.startsWith('SET LOCAL'))return {rows:[]};
 if(sql.includes('lock_recovery_anchor'))return {rows:[{lifecycle_store_id:scope.storeId,lifecycle_sequence:dbHead.sequence,lifecycle_head:dbHead.hash}]};
 if(sql.startsWith('SELECT id FROM helper_selection.leases'))return {rows:row?.state==='ACTIVE'?[row]:[]};
 if(sql.includes("kind='RECOVERY'"))return {rows:row?[row]:[]};
 if(sql.includes('clock_timestamp'))return {rows:[{ms:String(Date.now())}]};
 if(sql.includes('stage_recovery_consume')){if(row)throw Error('REPLAY');staged={id:v[1],state:'ACTIVE',lifecycle_scope:JSON.parse(v[0]),consume_sequence:String(BigInt(v[2])+1n),consume_head:v[4]};return {rows:[{id:v[1]}]};}
 if(sql.includes('stage_recovery_terminal')){staged={...row,state:'RELEASED',terminal_sequence:String(BigInt(v[4])+1n),terminal_head:v[6]};return {rows:[{id:v[1]}]};}
 if(sql==='ROLLBACK'){staged=undefined;return {rows:[]};}
 if(sql==='COMMIT'){if(mode==='commit-before')throw Error('commit lost before persistence');row=staged;dbHead=externalHead;if(mode==='commit-after')throw Error('commit reply lost');return {rows:[]};}
 throw Error('unexpected SQL '+sql);},release(destroy){release.push(destroy);}};}};
 const trust={async admit(){return scope;},async verifyLocked(_db,s,h){if(freeze||s.directoryHead!==epoch||canonicalJson(h)!==canonicalJson(externalHead))throw Error('STALE_OR_FROZEN');},async compareAndAppend(t){appends++;if(mode==='epoch-race')epoch=hex('2');if(t.kind==='CONSUME'&&epoch!==t.scope.directoryHead)throw Error('STALE_EPOCH');if(canonicalJson(t.previous)!==canonicalJson(externalHead))throw Error('STALE_HEAD');externalHead=t.next;if(mode==='append-lost')throw Error('lost witness response');return {head:t.next,transitionKind:t.kind,leaseId:t.leaseId,directoryHead:mode==='wrong-receipt'?hex('3'):epoch};},async freezeUnknown(){freeze=true;if(mode==='freeze-lost')throw Error('freeze response lost');},async verifyTerminalLocked(){return {ownerAccountId:scope.ownerAccountId,ownerEpoch:'2',directoryHead:epoch};},async readback(t){if(mode==='readback-lost'||mode==='freeze-lost'||canonicalJson(dbHead)!==canonicalJson(t.next)||canonicalJson(externalHead)!==canonicalJson(t.next)||(t.kind==='CONSUME'&&epoch!==t.scope.directoryHead))throw Error('READBACK');}};
 const keys=generateKeyPairSync('ed25519');const pin=createHash('sha256').update(keys.publicKey.export({type:'spki',format:'der'})).digest('hex');
 const signer={async signCommitted(ack){signs++;if(mode==='sign-lost')throw Error('SIGN_LOST');const bytes=Buffer.from(canonicalJson(ack));return Buffer.concat([sign(null,bytes,keys.privateKey),bytes]);},async verifyForNativeEffect(packet,ack){verifyExactAck(packet.subarray(64),packet.subarray(0,64),keys.publicKey,pin,ack,Date.now());}};
 return {scope,lease,pool,trust,signer,keys,pin,rotate(){epoch=hex('2');},restore(){dbHead=genesis;row=undefined;},status(){return {dbHead,externalHead,row,freeze,release,queries,appends,signs};}};
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
