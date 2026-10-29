/** Disposable TLS + explicitly synthetic ledger/native identity/signing keys.
 * These tests never show a Windows prompt or prove hardware/human presence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {createServer,request as httpsRequest} from 'node:https';
import {createServer as createHttpServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createCoreNativeEnrollmentVerifierHandler,type CoreNativeVerifierPrincipal}
  from '../src/security/core-native-enrollment-verifier-handler.js';
import {CoreApprovalLedgerError} from '../src/security/postgres-core-approval-ledger.js';
import {RemoteTrustedNativeCoreEnrollmentVerifier} from '../src/product/core-native-consent-verifier.js';
import {parseTrustedCoreNativeResponse,type CoreNativeProof,type CoreNativeWireRequest}
  from '../src/protocol/core-native-consent-transport.js';

function proof():CoreNativeProof{return {version:1,challengeId:randomUUID(),receiptId:randomUUID(),
  ownerAccountId:'owner-fixture-0001',deviceId:'device-fixture-0001',installationId:randomUUID(),
  enrollmentId:randomUUID(),ownerEpoch:1,grantGeneration:2,revokeEpoch:0,windowsSessionId:2,
  windowsUserSid:'S-1-5-21-101-202-303-1001',windowsLogonLuid:'000000000000a101',
  windowsLogonSessionEpoch:randomUUID(),approvedAtMs:Date.now(),consumed:true};}
function expected(p:CoreNativeProof){return {version:1 as const,scope:'physical-console' as const,
  ownerAccountId:p.ownerAccountId,deviceId:p.deviceId,installationId:p.installationId,enrollmentId:p.enrollmentId,
  ownerEpoch:p.ownerEpoch,grantGeneration:p.grantGeneration,revokeEpoch:p.revokeEpoch,
  approvedLocallyAtMs:p.approvedAtMs,issuerSpkiSha256:'a'.repeat(64)};}
function readback(p:CoreNativeProof){return {ownerAccountId:p.ownerAccountId,deviceId:p.deviceId,
  installationId:p.installationId,enrollmentId:p.enrollmentId,ownerEpoch:p.ownerEpoch,
  grantGeneration:p.grantGeneration,revokeEpoch:p.revokeEpoch,nativeConsentReceiptId:p.receiptId,
  windowsSessionId:p.windowsSessionId,windowsUserSid:p.windowsUserSid,windowsLogonLuid:p.windowsLogonLuid,
  windowsLogonSessionEpoch:p.windowsLogonSessionEpoch};}
function opensslBinary(){
  for(const bin of ['openssl','C:\\Program Files\\Git\\usr\\bin\\openssl.exe']){
    try{execFileSync(bin,['version'],{stdio:'ignore'});return bin}catch{}
  }
  throw Error('OPENSSL_REQUIRED_FOR_DISPOSABLE_MTLS_TEST');
}

test('independent native enrollment verifier enforces real TLS transport and scoped one-use responses',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'nx-native-verifier-fixture-')),openssl=opensslBinary();
  const run=(args:string[])=>execFileSync(openssl,args,{cwd:root,stdio:'ignore',timeout:15000});
  run(['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout','ca.key',
    '-out','ca.crt','-days','1','-subj','/CN=Nexowire Disposable Verifier CA',
    '-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
  for(const name of ['server','client']){
    await writeFile(path.join(root,name+'.ext'),'basicConstraints=critical,CA:FALSE\n'+
      'keyUsage=critical,digitalSignature\nextendedKeyUsage='+
      (name==='server'?'serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n':'clientAuth\n'));
    run(['req','-new','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes',
      '-keyout',name+'.key','-out',name+'.csr','-subj','/CN=Disposable '+name]);
    run(['x509','-req','-in',name+'.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial',
      '-out',name+'.crt','-days','1','-extfile',name+'.ext']);
  }
  const ca=await readFile(path.join(root,'ca.crt')),clientCert=await readFile(path.join(root,'client.crt')),
    clientKey=await readFile(path.join(root,'client.key'));
  const keys=generateKeyPairSync('ed25519'),pin=keys.publicKey.export({format:'der',type:'spki'}).toString('base64');
  const p=proof(),tombstones=new Set<string>();let consumes=0,reads=0,authentications=0,revoked=false;
  let lost=false,holdSign:(()=>Promise<void>)|undefined,holdAuth:(()=>Promise<void>)|undefined,forge=false;
  const credential='fixture-not-a-production-credential';
  const principal:CoreNativeVerifierPrincipal={role:'independent-enrollment-verifier',
    ownerAccountId:p.ownerAccountId,deviceId:p.deviceId,installationId:p.installationId};
  let presentedFingerprint='';
  const config={ledger:{
    async consumeForEnrollment(value:CoreNativeProof){
      consumes++;if(tombstones.has(value.receiptId))throw new CoreApprovalLedgerError('CORE_APPROVAL_ENROLLMENT_REPLAY');
      assert.deepEqual(value,p);tombstones.add(value.receiptId);
      if(lost)throw new CoreApprovalLedgerError('CORE_APPROVAL_TRANSACTION_UNKNOWN');return {...p};
    },
    async readEnrollmentProof(receiptId:string,binding:Record<string,unknown>){
      reads++;if(revoked)throw new CoreApprovalLedgerError('CORE_APPROVAL_BINDING_REVOKED_OR_STALE');
      assert.equal(receiptId,p.receiptId);for(const k of Object.keys(binding))
        assert.equal(binding[k],(p as Record<string,unknown>)[k]);
      return {...p};
    },
  },authenticateVerifier:async(token:string,peer:Readonly<{certificateSha256:string}>)=>{
    authentications++;presentedFingerprint=peer.certificateSha256;await holdAuth?.();
    return token===credential?{...principal}:null;
  },signer:{publicSpkiBase64:pin,sign:async(bytes:Uint8Array)=>{
    await holdSign?.();const sig=sign(null,bytes,keys.privateKey);if(forge)sig[0]=sig[0]!^1;return sig;
  }},timeoutMs:3500};
  const handler=createCoreNativeEnrollmentVerifierHandler(config);
  const server=createServer({key:await readFile(path.join(root,'server.key')),
    cert:await readFile(path.join(root,'server.crt')),ca,requestCert:true,rejectUnauthorized:false},handler);
  const plain=createHttpServer(handler);
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  await new Promise<void>(r=>plain.listen(0,'127.0.0.1',r));
  const addr=server.address(),pa=plain.address();assert.ok(addr&&typeof addr!=='string'&&pa&&typeof pa!=='string');
  const origin='https://127.0.0.1:'+addr.port;
  const post=(value:unknown,options:{client?:boolean;token?:string;body?:string;encoding?:string;
    method?:string;origin?:string}={})=>
    new Promise<{status:number;body:unknown}>( (resolve,reject)=>{
      const data=options.body??JSON.stringify(value);
      const req=httpsRequest((options.origin??origin)+'/v1/core-native-consent',{method:options.method??'POST',ca,
        ...(options.client===false?{}:{key:clientKey,cert:clientCert}),headers:{
          authorization:'Bearer '+(options.token??credential),'content-type':'application/json',
          'content-length':Buffer.byteLength(data),...(options.encoding?{'content-encoding':options.encoding}:{}),
        }},res=>{const chunks:Buffer[]=[];res.on('data',b=>chunks.push(Buffer.from(b)));
          res.on('error',reject);res.on('end',()=>{
            assert.equal(res.headers['cache-control'],'no-store');
            resolve({status:res.statusCode??0,body:JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown});
          });});
      req.setTimeout(5000,()=>req.destroy(Error('fixture request timeout')));req.on('error',reject);req.end(data);
    });
  const wire=(operation:CoreNativeWireRequest['operation'],value:unknown):CoreNativeWireRequest=>
    ({version:1,operation,nonce:randomUUID(),expected:value});
  const consume=()=>wire('verify-and-consume',{proof:p,expected:expected(p)});
  const reset=()=>{tombstones.clear();revoked=false;lost=false;holdSign=undefined;holdAuth=undefined;forge=false};
  t.after(async()=>{
    server.closeAllConnections();plain.closeAllConnections();
    await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>plain.close(()=>r()))]);
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });

  await t.test('plaintext, missing client certificate, wrong credentials and role fail before ledger access',async()=>{
    const before=consumes;
    assert.equal((await fetch('http://127.0.0.1:'+pa.port+'/v1/core-native-consent',{
      method:'POST',body:JSON.stringify(consume()),headers:{authorization:'Bearer '+credential,
        'content-type':'application/json','x-forwarded-proto':'https'}})).status,403);
    const authBefore=authentications;
    assert.equal((await post(consume(),{client:false})).status,403);assert.equal(authentications,authBefore);
    assert.equal((await post(consume(),{token:'wrong-credential-fixture'})).status,403);
    const old=principal.role;(principal as {role:string}).role='agent';
    assert.equal((await post(consume())).status,403);principal.role=old;
    assert.equal(consumes,before);
  });
  await t.test('existing remote verifier uses actual mTLS HTTP handler and rejects a replay',async()=>{
    reset();
    const fetchImpl=(async(_url,init)=>{const result=await post(JSON.parse(String(init?.body)) as unknown);
      return Response.json(result.body,{status:result.status});}) as typeof fetch;
    const remote=new RemoteTrustedNativeCoreEnrollmentVerifier({origin,credential,pinnedSpkiBase64:pin,fetchImpl});
    assert.equal(await remote.verifyAndConsume(p,expected(p)),true);
    assert.match(presentedFingerprint,/^[a-f0-9]{64}$/);
    assert.equal(await remote.verifyAndConsume(p,expected(p)),false);
    assert.equal(await remote.currentReadback(readback(p)),true);
  });
  await t.test('exact nonce/hash/signature, cross-owner scope and current-session checks remain bound',async()=>{
    reset();const request=consume(),result=await post(request);assert.equal(result.status,200);
    assert.deepEqual(parseTrustedCoreNativeResponse(result.body,request,pin).proof,p);
    assert.throws(()=>parseTrustedCoreNativeResponse(result.body,{...request,nonce:randomUUID()},pin));
    const before=consumes;
    assert.equal((await post(wire('verify-and-consume',{proof:{...p,ownerAccountId:'other-owner-fixture'},
      expected:{...expected(p),ownerAccountId:'other-owner-fixture'}}))).status,403);
    assert.equal((await post(wire('verify-and-consume',{proof:p,expected:{...expected(p),grantGeneration:99}}))).status,403);
    assert.equal(consumes,before);
    // The fixture ledger compares the actual binding supplied by the handler.
    // A mismatch cannot return a signed successful proof.
    assert.notEqual((await post(wire('current-readback',{...readback(p),windowsLogonSessionEpoch:randomUUID()}))).status,200);
  });
  await t.test('approval creation, raw receipt-only readback and oversized/ambiguous payloads are refused',async()=>{
    const before=consumes;
    assert.equal((await post(wire('approve-and-consume',{...p}))).status,403);
    assert.equal((await post(wire('current-readback',{receiptId:p.receiptId}))).status,400);
    assert.equal((await post(consume(),{body:'{not-json'})).status,400);
    assert.equal((await post(consume(),{body:'x'.repeat(17000)})).status,413);
    assert.equal((await post(consume(),{encoding:'gzip'})).status,400);
    assert.equal((await post(consume(),{method:'GET'})).status,404);assert.equal(consumes,before);
  });
  await t.test('lost consume ACK keeps the fixture tombstone and a second HTTP request cannot succeed',async()=>{
    reset();lost=true;assert.equal((await post(consume())).status,503);lost=false;
    assert.equal((await post(consume())).status,403);assert.equal(tombstones.has(p.receiptId),true);
  });
  await t.test('a revoke during asynchronous signing suppresses its signed response without undoing consume',async()=>{
    reset();holdSign=async()=>{revoked=true};assert.equal((await post(consume())).status,403);
    holdSign=undefined;revoked=false;
    assert.equal((await post(consume())).status,403);assert.equal(tombstones.has(p.receiptId),true);
  });
  await t.test('invalid protected signer output fails closed after consume and cannot be retried',async()=>{
    reset();forge=true;assert.equal((await post(consume())).status,503);forge=false;
    assert.equal((await post(consume())).status,403);
  });
  await t.test('mutable constructor aliases cannot substitute a trusted signer after authentication awaits',async()=>{
    reset();let entered!:()=>void,release!:()=>void;
    const barrier=new Promise<void>(r=>{release=r}),ready=new Promise<void>(r=>{entered=r});
    holdAuth=async()=>{entered();await barrier};const pending=post(consume());await ready;
    const original=config.signer.publicSpkiBase64;config.signer.publicSpkiBase64=generateKeyPairSync('ed25519')
      .publicKey.export({format:'der',type:'spki'}).toString('base64');release();
    const requestResult=await pending;config.signer.publicSpkiBase64=original;
    assert.equal(requestResult.status,200,'original immutable signer pin is retained');
  });
  await t.test('expired authentication never reaches consume and expired signing never reopens a consumed receipt',async()=>{
    reset();const short=createServer({key:await readFile(path.join(root,'server.key')),
      cert:await readFile(path.join(root,'server.crt')),ca,requestCert:true,rejectUnauthorized:false},
      createCoreNativeEnrollmentVerifierHandler({...config,timeoutMs:100}));
    await new Promise<void>(r=>short.listen(0,'127.0.0.1',r));
    const address=short.address();assert.ok(address&&typeof address!=='string');
    const shortOrigin='https://127.0.0.1:'+address.port;
    try{
      let release!:()=>void;const barrier=new Promise<void>(r=>{release=r});holdAuth=async()=>barrier;
      const before=consumes;
      assert.equal((await post(consume(),{origin:shortOrigin})).status,503);release();
      await new Promise<void>(r=>setImmediate(r));assert.equal(consumes,before);holdAuth=undefined;
      let releaseSign!:()=>void;const signBarrier=new Promise<void>(r=>{releaseSign=r});holdSign=async()=>signBarrier;
      assert.equal((await post(consume(),{origin:shortOrigin})).status,503);releaseSign();holdSign=undefined;
      assert.equal(tombstones.has(p.receiptId),true);
      assert.equal((await post(consume(),{origin:shortOrigin})).status,403);
    }finally{short.closeAllConnections();await new Promise<void>(r=>short.close(()=>r()))}
  });
  assert.ok(reads>0);
});

test('verifier refuses absent protected dependencies and non-Ed25519 signing pins',()=>{
  const noConfig={} as Parameters<typeof createCoreNativeEnrollmentVerifierHandler>[0];
  assert.throws(()=>createCoreNativeEnrollmentVerifierHandler(noConfig),/CORE_NATIVE_VERIFIER_SIGNER_INVALID/);
  assert.throws(()=>createCoreNativeEnrollmentVerifierHandler({...noConfig,signer:{
    publicSpkiBase64:generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey
      .export({format:'der',type:'spki'}).toString('base64'),sign:async()=>new Uint8Array(64)}}),
    /CORE_NATIVE_VERIFIER_SIGNER_INVALID/);
});
