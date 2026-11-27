import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {createServer as createHttpsServer} from 'node:https';
import {ProtectedRecoveryWitnessReadback} from '../../src/security/recovery-provider-readback.js';
import {execFileSync} from 'node:child_process';
import {createHash,generateKeyPairSync,X509Certificate,sign,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Disposable fixture only. Never install these certificates in OS trust. */
export function createHelperSelectionTlsFixture(){
  const root=mkdtempSync(path.join(os.tmpdir(),'nx-ai05-tls-'));
  const run=(args:string[])=>execFileSync('openssl',args,{cwd:root,stdio:'pipe',timeout:30000});
  const read=(file:string)=>readFileSync(path.join(root,file),'utf8');
  try{
    run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','1','-subj','/CN=AI05 disposable CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
    const issue=(name:string,extensions:string)=>{
      run(['req','-new','-newkey','rsa:2048','-nodes','-keyout',name+'.key','-out',name+'.csr','-subj','/CN='+name]);
      writeFileSync(path.join(root,name+'.ext'),extensions);
      run(['x509','-req','-in',name+'.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out',name+'.pem','-days','1','-extfile',name+'.ext']);
      const cert=read(name+'.pem'),key=read(name+'.key'),x=new X509Certificate(cert);
      return {cert,key,certSha256:createHash('sha256').update(x.raw).digest('hex'),spkiSha256:createHash('sha256').update(x.publicKey.export({type:'spki',format:'der'})).digest('hex')};
    };
    const server=issue('server','basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n');
    const runtime=issue('runtime','basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n');
    const deployment=issue('deployment','basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n');
    const signer=generateKeyPairSync('ed25519'),other=generateKeyPairSync('ed25519');
    return {ca:read('ca.pem'),server,runtime,deployment,privateKey:signer.privateKey.export({type:'pkcs8',format:'pem'}).toString(),
      publicKey:signer.publicKey.export({type:'spki',format:'pem'}).toString(),wrongPublicKey:other.publicKey.export({type:'spki',format:'pem'}).toString(),
      close(){rmSync(root,{recursive:true,force:true});}};
  }catch(error){rmSync(root,{recursive:true,force:true});throw error;}
}

/** Existing disposable TLS fixture extended with the real V3 readback client.
 * Never reuse these generated keys or local state as a production witness. */
export async function createHelperLegacyWitnessFixture(t:TestContext,tls:ReturnType<typeof createHelperSelectionTlsFixture>){
  // Test-only independent witness over real mTLS + nonce-bound Ed25519.
  // No candidate-controlled head, no real restore-external provider.
  const witnessKey=generateKeyPairSync('ed25519'),ackKey=generateKeyPairSync('ed25519');
  const sha=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
  const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v!==null&&typeof v==='object'?
    Object.fromEntries(Object.entries(v).sort(([x],[y])=>x<y?-1:x>y?1:0).map(([k,x])=>[k,canonical(x)])):v;
  const json=(v:unknown)=>JSON.stringify(canonical(v));
  const domain='nexowire.lifecycle.witness.readback.v1';
  const witnesses=new Map<string,{storeId:string;ownerId:string;state:'UNANCHORED'|'PENDING'}>();
  const witnessServer=createHttpsServer({key:tls.server.key,cert:tls.server.cert,ca:tls.ca,
    requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3',maxVersion:'TLSv1.3'},async(request,response)=>{
    try{
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
      const raw=Buffer.concat(chunks);const r=JSON.parse(raw.toString('utf8'));
      const entry=witnesses.get(r.authorityId);
      assert(entry&&r.storeId===entry.storeId&&r.domain===domain&&r.action==='READBACK');
      assert.equal(request.url,'/v1/lifecycle/readback');
      const now=Date.now(),unanchored=entry.state==='UNANCHORED';
      const snapshot={authorityId:r.authorityId,storeId:entry.storeId,state:entry.state,
        head:unanchored?null:{sequence:'1',hash:'3'.repeat(64)},transitionSha256:unanchored?null:'4'.repeat(64),
        ownerAccountId:unanchored?null:entry.ownerId,ownerEpoch:unanchored?null:'1',directoryHead:'5'.repeat(64),
        issuedMs:now,expiresMs:now+4000};
      const payload=Buffer.from(json({domain,nonce:r.nonce,requestSha256:sha(raw),snapshot}));
      const out=Buffer.from(JSON.stringify({payload:payload.toString('base64url'),signature:sign(null,payload,witnessKey.privateKey).toString('base64url')}));
      response.writeHead(200,{'content-type':'application/json','content-length':out.length});response.end(out);
    }catch{response.writeHead(500);response.end();}
  });
  t.after(async()=>{witnessServer.closeAllConnections();if(witnessServer.listening)await new Promise<void>((resolve,reject)=>witnessServer.close(e=>e?reject(e):resolve()));});
  await new Promise<void>((resolve,reject)=>{witnessServer.once('error',reject);witnessServer.listen(0,'127.0.0.1',()=>resolve());});
  const witnessAddress=witnessServer.address();assert(witnessAddress&&typeof witnessAddress==='object');
  const witnessPort=witnessAddress.port;
  function witnessFor(s:{authorityId:string;ownerId:string}){
    const entry={storeId:randomUUID(),ownerId:s.ownerId,state:'UNANCHORED' as 'UNANCHORED'|'PENDING'};
    witnesses.set(s.authorityId,entry);
    return new ProtectedRecoveryWitnessReadback({authorityId:s.authorityId,storeId:entry.storeId,
      endpoint:'https://127.0.0.1:'+witnessPort+'/v1/lifecycle/readback',
      caPem:tls.ca,clientCertificatePem:tls.runtime.cert,clientKeyPem:tls.runtime.key,
      serverSpkiSha256:tls.server.spkiSha256,witnessPublicKeyPem:witnessKey.publicKey.export({type:'spki',format:'pem'}).toString(),
      witnessSpkiSha256:sha(witnessKey.publicKey.export({type:'spki',format:'der'})),
      recoveryAckSpkiSha256:sha(ackKey.publicKey.export({type:'spki',format:'der'}))});
  }
  return {witnessFor,setState(authorityId:string,state:'UNANCHORED'|'PENDING'){const entry=witnesses.get(authorityId);assert(entry);entry.state=state;}};
}
