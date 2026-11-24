import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign,X509Certificate} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import type {AddressInfo} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {createProtectedTransferAuthorityServer,ProtectedTransferAuthorityClient,createProtectedHubTransferRuntime,createProtectedNativeTransferAdmission,transferNativeClaimDigest,type ProtectedTransferAuthorityBackend,type TransferNativeClaim,type ProtectedTransferAuthorityTlsConfig} from '../../src/security/protected-transfer-authority.js';
import {finalTransferSigningBytes,verifyNativeTransferReceipt} from '../../src/agent/native-transfer-publisher.js';
import type {LargeTransferBinding,LargeTransferIntent,LargeTransferFinalReceipt,LargeTransferCommit} from '../../src/mcp/durable-large-transfer.js';

test('protected transfer authority real mTLS: signed scoped replies, separate Native claims and no ambiguous replay',{timeout:45000},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-transfer-authority-'));
  let server:ReturnType<typeof createProtectedTransferAuthorityServer>|undefined;
  t.after(async()=>{if(server){server.closeAllConnections();await new Promise<void>(r=>server!.close(()=>r()));}await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  let openssl='';
  for(const bin of ['openssl','C:\\Program Files\\Git\\usr\\bin\\openssl.exe']){
    try{execFileSync(bin,['version'],{stdio:'ignore'});openssl=bin;break;}catch{}
  }
  assert(openssl,'OpenSSL required for disposable TLS fixture');
  const run=(args:string[])=>execFileSync(openssl,args,{cwd:root,stdio:'ignore',timeout:15000});
  run(['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout','ca.key','-out','ca.crt','-days','1','-subj','/CN=AI07 Transfer Fixture CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
  for(const name of ['server','hub','native']){
    await fs.writeFile(path.join(root,name+'.ext'),'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage='+(name==='server'?'serverAuth\nsubjectAltName=IP:127.0.0.1\n':'clientAuth\n'));
    run(['req','-new','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout',name+'.key','-out',name+'.csr','-subj','/CN=Disposable '+name]);
    run(['x509','-req','-in',name+'.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-out',name+'.crt','-days','1','-extfile',name+'.ext']);
  }
  const pem=(name:string)=>fs.readFile(path.join(root,name),'utf8');
  const ca=await pem('ca.crt'),serverCert=await pem('server.crt');
  const certHash=(cert:string)=>createHash('sha256').update(new X509Certificate(cert).raw).digest('hex');
  const hubCert=await pem('hub.crt'),nativeCert=await pem('native.crt');
  const serverPin=createHash('sha256').update(new X509Certificate(serverCert).publicKey.export({type:'spki',format:'der'})).digest('hex');
  const authorityKey=generateKeyPairSync('ed25519'),targetKey=generateKeyPairSync('ed25519'),wrongKey=generateKeyPairSync('ed25519');
  const pub=(key:typeof authorityKey)=>key.publicKey.export({type:'spki',format:'pem'}).toString();
  const scope={ownerId:'owner',projectId:'project',sourceDeviceId:'source',targetDeviceId:'target'};
  const id=randomUUID(),target=path.join(root,'final.bin');
  const b:LargeTransferBinding={...scope,id,sourcePath:'source.bin',targetPath:target,stagePath:target+'.nexowire-upload-'+id+'.part',size:0,sha256:createHash('sha256').digest('hex')};
  const l={epoch:1,token:randomBytes(32).toString('hex')};
  const p:LargeTransferIntent={kind:'publish',requestId:randomUUID(),epoch:1,offset:0,length:0,sha256:b.sha256,dispatched:true};
  const body={jobId:b.id,requestId:p.requestId,epoch:p.epoch,targetDeviceId:b.targetDeviceId,targetPath:b.targetPath,size:b.size,sha256:b.sha256};
  const receipt:LargeTransferFinalReceipt={...body,proof:sign(null,finalTransferSigningBytes(b,body),targetKey.privateKey).toString('base64url')};
  const hubToken=randomBytes(32).toString('hex'),nativeToken=randomBytes(32).toString('hex');
  let grants=0,claimed=0,settled=0,effects=0,revoked=false,provenance=true,failSettle=false;
  const tombstones=new Map<string,TransferNativeClaim>();
  let committed:{receipt:LargeTransferFinalReceipt;commit:LargeTransferCommit}|undefined;
  const backend:ProtectedTransferAuthorityBackend={
    async cancelTransfer(binding,lease){assert.deepEqual(binding,b);assert.deepEqual(lease,l);},
    async assertGrant(s){grants++;assert(!revoked);assert.deepEqual(s,scope);},
    async acquire(_b,previous){assert.equal(previous,0);return l;},
    async assertCurrent(_b,lease,offset){assert.deepEqual(lease,l);assert.equal(offset,0);},
    async proveWriteNoEffect(){return false;},
    async verifyFinal(binding,r){return verifyNativeTransferReceipt(binding,r,targetKey.publicKey);},
    async commitPublished(binding,lease,r){assert.deepEqual(lease,l);assert(!committed);const commit={jobId:binding.id,requestId:r.requestId,epoch:r.epoch,sha256:binding.sha256,commitId:randomUUID()};committed={receipt:r,commit};return commit;},
    async recoverPublished(){return committed;},
    async recoverNativeReceipt(){return receipt;},
    async commitRecoveredPublication(binding,i,r){assert.equal(i.requestId,r.requestId);assert(!committed);const commit={jobId:binding.id,requestId:i.requestId,epoch:i.epoch,sha256:binding.sha256,commitId:randomUUID()};committed={receipt:r,commit};return commit;},
    async claimNativeEffect(binding,lease,i){assert.deepEqual(lease,l);assert(!tombstones.has(i.requestId));claimed++;const c={claimId:randomUUID(),jobId:binding.id,requestId:i.requestId,epoch:i.epoch,intentSha256:transferNativeClaimDigest(binding,lease,i)};tombstones.set(i.requestId,c);return c;},
    async settleNativeEffect(_b,_l,i,c){assert.deepEqual(tombstones.get(i.requestId),c);settled++;if(failSettle)throw Error('settlement outcome unknown');},
  };
  server=createProtectedTransferAuthorityServer({
    tls:{key:await pem('server.key'),cert:serverCert,ca},authorityId:'fixture-authority',authorityPrivateKeyPem:authorityKey.privateKey.export({type:'pkcs8',format:'pem'}).toString(),
    resolvePrincipal:async(cert,token)=>cert===certHash(hubCert)&&token===hubToken?{role:'hub',scope}:cert===certHash(nativeCert)&&token===nativeToken?{role:'native',scope}:undefined,
    verifyIndependentProvenance:async()=>provenance,backend,
  });
  await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));
  const endpoint='https://127.0.0.1:'+(server.address() as AddressInfo).port+'/v1/large-transfer-authority';
  const config:ProtectedTransferAuthorityTlsConfig={endpoint,authorityId:'fixture-authority',role:'hub',scope,certificatePem:hubCert,keyPem:await pem('hub.key'),serverCaPem:ca,serverSpkiSha256:serverPin,authorityPublicKeyPem:pub(authorityKey),enrolledTargetPublicKeyPem:pub(targetKey),credential:async()=>hubToken,timeoutMs:3000};
  const hub=createProtectedHubTransferRuntime({...config,journalPath:path.join(root,'journal.sqlite')}).authority;
  const native=new ProtectedTransferAuthorityClient({...config,role:'native',certificatePem:nativeCert,keyPem:await pem('native.key'),credential:async()=>nativeToken});
  await t.test('real mTLS grant, lease, native signature, recovered original receipt and commit',async()=>{
    await hub.assertGrant(scope);assert.deepEqual(await hub.acquire(b,0),l);await hub.assertCurrent(b,l,0);
    assert.equal(await hub.verifyFinal(b,receipt),true);
    assert.equal(await hub.verifyFinal(b,{...receipt,proof:'A'.repeat(86)}),false);
    assert.deepEqual(await hub.recoverNativeReceipt(b,p),receipt);
    const commit=await hub.commitRecoveredPublication(b,p,receipt);
    assert.deepEqual(await hub.recoverPublished(b,p),{receipt,commit});
  });
  await t.test('wrong CA/SPKI, authority signer, principal and role deny; no caller scope substitution',async()=>{
    const before=grants;
    await assert.rejects(new ProtectedTransferAuthorityClient({...config,serverSpkiSha256:'0'.repeat(64)}).assertGrant(scope));assert.equal(grants,before);
    await assert.rejects(new ProtectedTransferAuthorityClient({...config,authorityPublicKeyPem:pub(wrongKey)}).assertGrant(scope),/SIGNATURE_INVALID/);
    const current=grants;
    await assert.rejects(new ProtectedTransferAuthorityClient({...config,credential:async()=>nativeToken}).assertGrant(scope));assert.equal(grants,current);
    await assert.rejects(hub.assertGrant({...scope,ownerId:'other'}),/SCOPE_DENIED/);
    await assert.rejects(hub.claimNativeEffect(b,l,p),/ROLE_DENIED/);await assert.rejects(native.assertGrant(scope),/ROLE_DENIED/);
    provenance=false;await assert.rejects(hub.assertGrant(scope));provenance=true;assert.equal(grants,current);
  });
  await t.test('Native claim requires a protected callback; repeated UUID and lost settlement never replay',async()=>{
    const guard=createProtectedNativeTransferAdmission(native,async(_b,_l,_p,_c,effect)=>{await effect();});
    await guard.admit(b,l,p,async()=>{effects++;});
    assert.equal(effects,1);assert.equal(claimed,1);assert.equal(settled,1);
    await assert.rejects(guard.admit(b,l,p,async()=>{effects++;}));assert.equal(effects,1);
    const next={...p,requestId:randomUUID()};
    failSettle=true;await assert.rejects(guard.admit(b,l,next,async()=>{effects++;}));failSettle=false;
    await assert.rejects(guard.admit(b,l,next,async()=>{effects++;}));assert.equal(effects,2);assert.equal(claimed,2);
    const skipped={...p,requestId:randomUUID()};
    const noCallback=createProtectedNativeTransferAdmission(native,async()=>{});
    await assert.rejects(noCallback.admit(b,l,skipped,async()=>{effects++;}),/EFFECT_UNCONFIRMED/);assert.equal(effects,2);
    revoked=true;await assert.rejects(hub.assertGrant(scope));await assert.rejects(guard.admit(b,l,{...p,requestId:randomUUID()},async()=>{effects++;}));assert.equal(effects,2);
  });
});
