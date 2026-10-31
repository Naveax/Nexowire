/** AI-08 disposable localhost TLS pin probe. Never contacts a device.
 * Not a real enrollment authority or full two-PC mTLS acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,X509Certificate} from 'node:crypto';
import {createServer} from 'node:https';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createCoreNativeMtlsFetch} from '../src/security/core-native-mtls-fetch.js';

function openssl(){
  for(const candidate of ['openssl','C:\\Program Files\\Git\\usr\\bin\\openssl.exe']){
    try{execFileSync(candidate,['version'],{stdio:'ignore',timeout:4000});return candidate;}
    catch{}
  }
  throw Error('AI08_OPENSSL_NOT_AVAILABLE');
}

test('AI-08: server SPKI pin mismatch denies before the HTTP handler',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'nx-ai08-pin-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const run=(args:string[])=>execFileSync(openssl(),args,{
    cwd:root,stdio:'ignore',timeout:15000,
  });
  run(['req','-x509','-newkey','rsa:2048','-nodes',
    '-keyout','fixture.key','-out','fixture.crt','-days','1',
    '-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-addext','basicConstraints=critical,CA:TRUE']);
  const keyPem=await readFile(path.join(root,'fixture.key'),'utf8');
  const certificatePem=await readFile(path.join(root,'fixture.crt'),'utf8');
  const pinned=createHash('sha256').update(
    new X509Certificate(certificatePem).publicKey.export({type:'spki',format:'der'}),
  ).digest('hex');
  let httpRequests=0;
  const server=createServer({key:keyPem,cert:certificatePem,
    minVersion:'TLSv1.3',maxVersion:'TLSv1.3'},(_req,res)=>{
    httpRequests++;
    res.writeHead(200,{'content-type':'application/json'});
    res.end('{"fixture":true}');
  });
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  t.after(async()=>{
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  });
  const address=server.address();
  assert.ok(address&&typeof address!=='string');
  const origin='https://127.0.0.1:'+address.port;
  const config={origin,keyPem,certificatePem,serverCaPem:certificatePem,
    serverSpkiSha256:pinned,timeoutMs:3000};
  const url=origin+'/v1/core-native-consent';
  const init={method:'POST',redirect:'error' as const,
    headers:{authorization:'Bearer ai08_disposable_0123456789abcdef',
      'content-type':'application/json'},body:'{}'};
  const attacker=createCoreNativeMtlsFetch({...config,
    serverSpkiSha256:'0'.repeat(64)});
  await assert.rejects(attacker(url,init),/CORE_MTLS_REQUEST_UNKNOWN/);
  assert.equal(httpRequests,0,'wrong SPKI never reaches the HTTP handler');
  const valid=createCoreNativeMtlsFetch(config);
  const response=await valid(url,init);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{fixture:true});
  assert.equal(httpRequests,1);
  // An already-aborted request must fail before sending any protected payload.
  const aborted=new AbortController();
  aborted.abort();
  await assert.rejects(valid(url,{...init,signal:aborted.signal}),
    /CORE_MTLS_REQUEST_UNKNOWN/);
  assert.equal(httpRequests,1,'a pre-aborted request must not reach localhost');
  // Neither origin mutation nor redirect options may change the pinned endpoint.
  config.origin='https://attacker.invalid';
  await assert.rejects(valid('https://attacker.invalid/v1/core-native-consent',init),
    /CORE_MTLS_REQUEST_INVALID/);
  await assert.rejects(valid(url,{...init,redirect:'follow'}),
    /CORE_MTLS_REQUEST_INVALID/);
  assert.equal(httpRequests,1);
});
