// Explicit fixture-only runner. Real PostgreSQL + real HTTPS/mTLS and Ed25519.
// No ambient DSN, production credentials, or effect issuer. The witness fixture
// is a separate state file, NOT proof of a separately operated restore domain.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {readFileSync,writeFileSync,mkdtempSync,rmSync,mkdirSync,openSync,fsyncSync,closeSync,renameSync}=require('node:fs');
const {tmpdir}=require('node:os'),path=require('node:path');
const {generateKeyPairSync,createHash,randomUUID,sign,X509Certificate}=require('node:crypto');
const {createServer}=require('node:https');
const ts=require('typescript'),Module=require('node:module');
const file=path.resolve(__dirname,'../../src/security/recovery-provider-readback.ts');
const compiled=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},reportDiagnostics:true});
assert.equal(compiled.diagnostics.length,0);const mod=new Module(file,module);mod.filename=file;mod._compile(compiled.outputText,file);
const {ProtectedRecoveryWitnessReadback,createRecoveryCommitReadback,assertLegacyAdmissionLocked}=mod.exports;
// Test-only exposure of the unchanged V3 internal orchestration. The accepted
// V3 source and model fixture remain byte-identical, with no public issuer.
const v3file=path.resolve(__dirname,'../../src/security/recovery-anchored-authority-review.ts');
const v3source=readFileSync(v3file,'utf8');
const v3compiled=ts.transpileModule(v3source+'\nexport {stageConsume,signFreshConsume,writers};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}});
const v3=new Module(v3file,module);v3.filename=v3file;v3._compile(v3compiled.outputText,v3file);
const {stageConsume,signFreshConsume,writers}=v3.exports;
const json=v=>JSON.stringify(sort(v));function sort(v){return Array.isArray(v)?v.map(sort):v!==null&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,sort(x)])):v;}
const sha=v=>createHash('sha256').update(v).digest('hex'),hex=c=>c.repeat(64),pin=k=>sha(k.export({format:'der',type:'spki'}));
const uid=randomUUID,DOMAIN='nexowire.lifecycle.witness.readback.v1';
const root=path.resolve(__dirname,'../..');
const BASE={'sql/core-broker-dispatch-authority.sql':'a120585a92d7ab41bb2d1a3aaf5c0bc31f9ca74b','sql/helper-selection-authority.sql':'32338077c0cd85789f475b1a76e93ad4a1351863','sql/core-broker-dispatch-credentials.sql':'4cd511f8246025c7293202070527c66710b80a62','sql/core-broker-dispatch-credential-fence.sql':'6c847b5386312a2550318f68792822feb5a93192','sql/large-transfer-authority.sql':'ab495d8c34b10cdd04f88e5ad1b2d40fde8b082d','sql/helper-selection-lifecycle-review.sql':'09a18ac5f64d282b5964740edddd6ad5d65cd866'};
const blob=p=>{const b=readFileSync(path.join(root,p));return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');};
function tlsFixture(dir){
 const openssl=(...a)=>execFileSync('openssl',a,{cwd:dir,stdio:'ignore',timeout:10000});
 openssl('req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-subj','/CN=NX02 fixture CA','-days','1');
 for(const name of ['server','client','wrong']){
  openssl('req','-newkey','rsa:2048','-nodes','-keyout',name+'.key','-out',name+'.csr','-subj','/CN='+name);
  writeFileSync(path.join(dir,name+'.ext'),name==='server'?'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n':'extendedKeyUsage=clientAuth\n');
  openssl('x509','-req','-in',name+'.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out',name+'.pem','-days','1','-extfile',name+'.ext');
 }
 const read=n=>readFileSync(path.join(dir,n),'utf8');return {read,ca:read('ca.pem'),cert:read('server.pem'),key:read('server.key'),clientCert:read('client.pem'),clientKey:read('client.key')};
}
async function withWitness(fn){
 const dir=mkdtempSync(path.join(tmpdir(),'nx02-readback-witness-'));let server;
 try{
 const tls=tlsFixture(dir),keys=generateKeyPairSync('ed25519'),ack=generateKeyPairSync('ed25519');
 const identity={authorityId:uid(),storeId:uid()},owner=uid(),directoryHead=hex('a'),genesis={sequence:'0',hash:hex('0')};
 const statePath=path.join(dir,'state.json');
 function setState(s){const tmp=statePath+'.tmp',fd=openSync(tmp,'w',0o600);try{writeFileSync(fd,json(s));fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,statePath);const d=openSync(dir,'r');try{fsyncSync(d);}finally{closeSync(d);}}
 const base={...identity,head:genesis,state:'COMMITTED',transitionSha256:hex('1'),ownerAccountId:owner,ownerEpoch:'1',directoryHead};setState(base);
 let mode='normal',last,requests=0;
 server=createServer({key:tls.key,cert:tls.cert,ca:tls.ca,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3',maxVersion:'TLSv1.3'},(req,res)=>{
  const cert=req.socket.getPeerCertificate();if(!req.socket.authorized||cert.fingerprint256!==new X509Certificate(tls.clientCert).fingerprint256||req.url!=='/v1/lifecycle/readback'||req.method!=='POST'){res.writeHead(403);res.end();return;}
  const chunks=[];let total=0;req.on('data',c=>{total+=c.length;if(total>32768)req.destroy();else chunks.push(c);});req.on('end',()=>{try{
   requests++;const raw=Buffer.concat(chunks),r=JSON.parse(raw);assert.equal(r.domain,DOMAIN);assert.equal(r.action,'READBACK');assert.equal(r.authorityId,identity.authorityId);assert.equal(r.storeId,identity.storeId);
   if(mode==='disconnect'){req.socket.destroy();return;}
   const s=JSON.parse(readFileSync(statePath,'utf8')),now=Date.now();const p={domain:DOMAIN,nonce:mode==='nonce'?hex('e'):r.nonce,requestSha256:sha(raw),snapshot:{...s,issuedMs:now,expiresMs:mode==='expired'?now-1:now+3000}};
   const bytes=Buffer.from(json(p));const sig=sign(null,bytes,mode==='wrongSigner'?ack.privateKey:keys.privateKey);
   const body=mode==='replay'&&last?last:Buffer.from(JSON.stringify({payload:bytes.toString('base64url'),signature:sig.toString('base64url')}));last=body;
   res.writeHead(200,{'content-type':'application/json','content-length':body.length,'connection':'close'});res.end(body);
  }catch{res.writeHead(403);res.end();}});
 });await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const config={...identity,endpoint:`https://127.0.0.1:${server.address().port}/v1/lifecycle/readback`,caPem:tls.ca,clientCertificatePem:tls.clientCert,clientKeyPem:tls.clientKey,serverSpkiSha256:pin(new X509Certificate(tls.cert).publicKey),witnessPublicKeyPem:keys.publicKey.export({format:'pem',type:'spki'}).toString(),witnessSpkiSha256:pin(keys.publicKey),recoveryAckSpkiSha256:pin(ack.publicKey)};
 const w=new ProtectedRecoveryWitnessReadback(config);
 await fn({identity,owner,directoryHead,genesis,base,setState,w,config,tls,mode:m=>mode=m,requests:()=>requests});
 }finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}rmSync(dir,{recursive:true,force:true});}
}
function transition(f,previous=f.genesis){const s={...f.identity,ownerAccountId:f.owner,ownerEpoch:'1',directoryHead:f.directoryHead,deviceId:uid(),installationLineageId:uid(),resourceId:uid(),bootId:uid(),sessionEpoch:uid(),generation:'1',purpose:'rollback',transactionSha256:hex('b'),authorizationId:uid(),attemptId:uid(),requestId:uid(),challenge:hex('c'),requestSha256:hex('d'),bindingSha256:hex('e'),envelopeSha256:hex('f'),signerSpkiSha256:hex('1'),deadlineMs:Date.now()+25000};const leaseId=uid(),sequence=(BigInt(previous.sequence)+1n).toString(),next={sequence,hash:sha(json(['nexowire.lifecycle.transition.v1',previous.sequence,previous.hash,sequence,['CONSUME',s,leaseId]]))};return {kind:'CONSUME',scope:s,leaseId,previous,next};}
const witnessed=(f,t,state='COMMITTED')=>({...f.base,head:t.next,state,transitionSha256:sha(json(['nexowire.lifecycle.pending.v1',t]))});
test('real mTLS: exact signed snapshot, nonce, replay, signer, expiry, SPKI and client identity',async()=>withWitness(async f=>{
 assert.deepEqual((await f.w.current()).head,f.genesis);f.mode('replay');await assert.rejects(f.w.current(),/BINDING_DENIED/);f.mode('nonce');await assert.rejects(f.w.current(),/BINDING_DENIED/);f.mode('wrongSigner');await assert.rejects(f.w.current(),/SIGNATURE_DENIED/);f.mode('expired');await assert.rejects(f.w.current(),/FRESHNESS_DENIED/);f.mode('disconnect');await assert.rejects(f.w.current(),/UNKNOWN/);f.mode('normal');
 await assert.rejects(new ProtectedRecoveryWitnessReadback({...f.config,serverSpkiSha256:hex('e')}).current(),/UNKNOWN/);
 await assert.rejects(new ProtectedRecoveryWitnessReadback({...f.config,clientCertificatePem:f.tls.read('wrong.pem'),clientKeyPem:f.tls.read('wrong.key')}).current(),/HTTP_DENIED/);
 assert.throws(()=>new ProtectedRecoveryWitnessReadback({...f.config,recoveryAckSpkiSha256:f.config.witnessSpkiSha256}),/CONFIG_INVALID/);
}));
// Real PG lane only runs explicitly; the hosted workflow forbids silent skip.
const runPG=process.argv.includes('--postgres')||process.env.NX02_READBACK_REAL_PG_FIXTURE==='1';
// --test doesn't forward script args on every Node version: workflow sets the flag.
test('actual PG + authenticated witness: unanchored COMMIT denies, exact readback status only, stale/null restore and early callback denial',{skip:!runPG},async()=>withWitness(async f=>{
 assert.notEqual(process.getuid?.(),0,'initdb must not run as root');for(const [p,h] of Object.entries(BASE))assert.equal(blob(p),h,p);
 for(const k of Object.keys(process.env))if(k.startsWith('PG'))delete process.env[k];
 const {Pool}=require('pg');const dir=mkdtempSync(path.join(tmpdir(),'nx02-readback-pg-')),sock=path.join(dir,'socket'),data=path.join(dir,'data'),port=55483;mkdirSync(sock,{mode:0o700});
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('PG')));env.LC_ALL='C';
 const exec=(p,args)=>execFileSync(p,args,{env,encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});
 let started=false,admin,consume,legacy;
 try{
  exec('initdb',['-D',data,'-U','nx_fixture_admin','--auth=trust','--no-locale']);exec('pg_ctl',['-D',data,'-l',path.join(dir,'postgres.log'),'-o',`-c listen_addresses='' -c unix_socket_directories='${sock}' -p ${port}`,'-w','start']);started=true;
  const mk=user=>new Pool({host:sock,port,user,database:'postgres',ssl:false,max:3,connectionTimeoutMillis:3000,statement_timeout:5000});
  admin=mk('nx_fixture_admin');for(const p of Object.keys(BASE).slice(0,-1))await admin.query(readFileSync(path.join(root,p),'utf8'));
  await admin.query('CREATE ROLE nx_lifecycle_sql_owner NOLOGIN; CREATE ROLE nx_lifecycle_consume NOLOGIN; CREATE ROLE nx_lifecycle_reconcile NOLOGIN; CREATE ROLE nx_readback_consume LOGIN; CREATE ROLE nx_readback_legacy LOGIN; GRANT nx_lifecycle_consume TO nx_readback_consume; GRANT USAGE ON SCHEMA core_dispatch TO nx_readback_legacy; GRANT SELECT ON core_dispatch.authorities TO nx_readback_legacy; GRANT UPDATE(max_seen_ms) ON core_dispatch.authorities TO nx_readback_legacy;');
  await admin.query('INSERT INTO core_dispatch.authorities(authority_id,max_seen_ms) VALUES($1,1)',[f.identity.authorityId]);
  await admin.query(readFileSync(path.join(root,Object.keys(BASE).at(-1)),'utf8'));
  // Operator bypass solely in a fresh disposable fixture; no production genesis path.
  const setDbHead=async(h)=>{const c=await admin.connect();try{await c.query('BEGIN');await c.query('ALTER TABLE core_dispatch.authorities DISABLE TRIGGER lifecycle_anchor_guard');await c.query('UPDATE core_dispatch.authorities SET lifecycle_store_id=$2,lifecycle_sequence=$3,lifecycle_head=$4 WHERE authority_id=$1',[f.identity.authorityId,h?f.identity.storeId:null,h?.sequence??null,h?.hash??null]);await c.query('ALTER TABLE core_dispatch.authorities ENABLE TRIGGER lifecycle_anchor_guard');await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
  consume=mk('nx_readback_consume');legacy=mk('nx_readback_legacy');
  const wrap=p=>({async connect(){const c=await p.connect();return {query:async(sql,values=[])=>({rows:(await c.query(sql,values)).rows}),release:(destroy=false)=>c.release(destroy)};}});
  const legacyCall=async cb=>{const c=await legacy.connect();try{await c.query('BEGIN');await assertLegacyAdmissionLocked(c,f.w);await cb();await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
  let callbacks=0;f.setState({...f.base,state:'UNANCHORED',head:null,transitionSha256:null,ownerAccountId:null,ownerEpoch:null});await legacyCall(()=>{callbacks++;});assert.equal(callbacks,1);console.log('PASS real unanchored early admission');
  // A stale PG snapshot with NULL anchor must not revive legacy admission.
  f.setState(f.base);await assert.rejects(legacyCall(()=>{callbacks++;}),/LEGACY_WRITER_NOT_ENROLLED/);assert.equal(callbacks,1);console.log('PASS null-anchor restore denied before callback');
  await setDbHead(f.genesis);await assert.rejects(legacyCall(()=>{callbacks++;}),/LEGACY_WRITER_NOT_ENROLLED/);assert.equal(callbacks,1);console.log('PASS anchored early callback denial');
  const t=transition(f),guard=createRecoveryCommitReadback(wrap(consume),f.w);assert.equal(Object.keys(guard).join(','),'readback');
  // Fault injection: the writer lies about prepare/append receipts while the
  // independent authenticated witness endpoint still reports genesis. Execute
  // the actual unchanged V3 consume orchestration with a real SQL pool and
  // concrete signed readback, not a simulated DB or boolean readback shim.
  let freezeCount=0,signCount=0;
  const trust={verifyLocked:async(_db,s,h)=>({...f.identity,deviceId:s.deviceId,installationLineageId:s.installationLineageId,resourceId:s.resourceId,bootId:s.bootId,generation:s.generation,directoryHead:s.directoryHead,head:h,nativeFenceSha256:hex('a'),expiresMs:s.deadlineMs,participants:writers.map(writer=>({writer,state:'FENCED',evidenceSha256:hex('d')}))}),preparePending:async transition=>({state:'PENDING',transitionSha256:sha(json(['nexowire.lifecycle.pending.v1',transition]))}),compareAndAppend:async transition=>({head:transition.next,transitionKind:transition.kind,leaseId:transition.leaseId,directoryHead:transition.scope.directoryHead}),readback:guard.readback,freezeUnknown:async()=>{freezeCount++;f.setState({...f.base,state:'FROZEN'});}};
  const signer={signCommitted:async()=>{signCount++;throw Error('effect signer must not run');},verifyForNativeEffect:async()=>{throw Error('effect verifier must not run');}};
  await assert.rejects(async()=>signFreshConsume(await stageConsume(wrap(consume),trust,t.scope,t.leaseId),trust,signer),/LIFECYCLE_UNKNOWN_FREEZE_REQUIRED/);
  const committed=(await consume.query('SELECT lifecycle_sequence,lifecycle_head FROM core_dispatch.authorities WHERE authority_id=$1',[f.identity.authorityId])).rows[0];assert.equal(String(committed.lifecycle_sequence),t.next.sequence);assert.equal(committed.lifecycle_head,t.next.hash);assert.equal(freezeCount,1);assert.equal(signCount,0);assert.equal((await f.w.current()).state,'FROZEN');
  console.log('PASS actual V3 orchestration committed SQL but witness divergence freezes and signer is never called');
  f.setState(f.base);await assert.rejects(guard.readback(t),/WITNESS_DIVERGED/);console.log('PASS actual unanchored COMMIT denied by authenticated readback');
  f.setState(witnessed(f,t,'PENDING'));await assert.rejects(guard.readback(t),/WITNESS_DIVERGED/);f.setState(witnessed(f,t,'FROZEN'));await assert.rejects(guard.readback(t),/WITNESS_DIVERGED/);console.log('PASS PENDING and FROZEN deny exact SQL commit');
  f.setState({...witnessed(f,t),ownerEpoch:'2'});await assert.rejects(guard.readback(t),/WITNESS_DIVERGED/);console.log('PASS current owner epoch mismatch denied');
  f.setState(witnessed(f,t));assert.equal(await guard.readback(t),undefined);console.log('PASS exact committed readback status only (no effect ACK)');
  f.setState(witnessed(f,t));await setDbHead(f.genesis);await assert.rejects(guard.readback(t),/DB_HEAD_DIVERGED/);console.log('PASS stale PG head denied with unchanged external witness');
  console.log('REAL_PG_AUTHENTICATED_READBACK 9 PASS; actual effect ACK NOT_RUN; independent deployment NOT_RUN');
 }finally{for(const pool of [legacy,consume,admin])if(pool)await pool.end();if(started)exec('pg_ctl',['-D',data,'-m','immediate','-w','stop']);rmSync(dir,{recursive:true,force:true});}
}));
