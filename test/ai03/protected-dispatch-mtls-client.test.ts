/** Disposable local mTLS transport test; no native effects or production trust. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID,X509Certificate} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:https';
import type {AddressInfo} from 'node:net';
import type {TLSSocket} from 'node:tls';
import path from 'node:path';
import os from 'node:os';
import {createProtectedHttpsBrokerDispatchAuthority,createBrokerDispatchMtlsFetch}
  from '../../src/agent/broker-dispatch-mtls-fetch.js';

test('protected dispatch transport pins the server, authenticates the client and denies ambiguous ACKs',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'nx-dispatch-mtls-'));
  let server:ReturnType<typeof createServer>|undefined;
  try{
    let openssl='';
    for(const bin of ['openssl','C:\\Program Files\\Git\\usr\\bin\\openssl.exe']){
      try{execFileSync(bin,['version'],{stdio:'ignore'});openssl=bin;break}catch{}
    }
    assert.ok(openssl,'OpenSSL required');
    const run=(args:string[])=>execFileSync(openssl,args,{cwd:root,stdio:'ignore',timeout:15000});
    run(['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes',
      '-keyout','ca.key','-out','ca.crt','-days','1','-subj','/CN=Dispatch Fixture CA',
      '-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
    for(const name of ['server','client']){
      await writeFile(path.join(root,name+'.ext'),'basicConstraints=critical,CA:FALSE\n'+
        'keyUsage=critical,digitalSignature\nextendedKeyUsage='+
        (name==='server'?'serverAuth\nsubjectAltName=IP:127.0.0.1\n':'clientAuth\n'));
      run(['req','-new','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes',
        '-keyout',name+'.key','-out',name+'.csr','-subj','/CN=Disposable '+name]);
      run(['x509','-req','-in',name+'.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial',
        '-out',name+'.crt','-days','1','-extfile',name+'.ext']);
    }
    const pem=(name:string)=>readFile(path.join(root,name),'utf8');
    const serverCert=await pem('server.crt'),ca=await pem('ca.crt');
    const pin=createHash('sha256').update(new X509Certificate(serverCert).publicKey.export(
      {type:'spki',format:'der'})).digest('hex');
    const credential='a'.repeat(48);
    const receipt={payload:'YWJj',signature:'YWJj'};
    let mode='ok',calls=0;
    server=createServer({key:await pem('server.key'),cert:serverCert,ca,
      requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3',maxVersion:'TLSv1.3'},(req,res)=>{
      void(async()=>{
        assert.equal((req.socket as TLSSocket).authorized,true);
        assert.equal(req.headers.authorization,'Bearer '+credential);
        for await(const _ of req){}
        calls++;
        if(mode==='release'){res.writeHead(204);res.end();return}
        if(mode==='partial'){res.writeHead(206);res.end();return}
        if(mode==='duplicate'){res.writeHead(200,['content-type','application/json','content-type','text/plain']);
          res.end(JSON.stringify(receipt));return}
        res.writeHead(200,{'content-type':'application/json'});
        if(mode==='oversize'){res.end('x'.repeat(8193));return}
        if(mode==='stall'){res.write('{"payload":');return}
        res.end(JSON.stringify(receipt));
      })().catch(()=>res.destroy());
    });
    const listener=server;
    await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));
    const endpoint='https://127.0.0.1:'+(listener.address() as AddressInfo).port+'/v1/broker-dispatch';
    const config={endpoint,keyPem:await pem('client.key'),certificatePem:await pem('client.crt'),
      serverCaPem:ca,serverSpkiSha256:pin,timeoutMs:1500,brokerCredential:async()=>credential};
    const client=createProtectedHttpsBrokerDispatchAuthority(config);
    const op={requestId:randomUUID(),fingerprint:'a'.repeat(64),capability:'fixture.no-effect',
      scope:{ownerId:randomUUID(),deviceId:randomUUID(),deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),
        ownerEpoch:1,expectedGeneration:1,requiredPrivilege:'CORE' as const}};
    const broker={verified:true as const,brokerId:randomUUID(),ownerEpoch:1,grantGeneration:1,
      highIntegrityToken:true as const,signedProtectedImage:true as const,protectedParentAndImports:true as const};
    const begin=()=>client.beginIfCurrent(op,broker,'b'.repeat(64));
    await t.test('correct certificate and SPKI allow only the scoped dispatch route',async()=>{
      assert.deepEqual(await begin(),receipt);assert.equal(calls,1);
      const direct=createBrokerDispatchMtlsFetch(config);
      await assert.rejects(direct(endpoint.replace('/broker-dispatch','/core-native-consent'),
        {method:'POST',redirect:'error',body:'{}'}),/REQUEST_INVALID/);
      assert.equal(calls,1);
    });
    await t.test('wrong server pin denies before HTTP handler',async()=>{
      const wrong=createProtectedHttpsBrokerDispatchAuthority({...config,serverSpkiSha256:'0'.repeat(64)});
      await assert.rejects(wrong.beginIfCurrent(op,broker,'b'.repeat(64)));
      assert.equal(calls,1);
    });
    await t.test('partial, duplicate, oversized and incomplete ACKs do not authorize or retry',async()=>{
      for(const next of ['partial','duplicate','oversize','stall']){
        mode=next;const before=calls;await assert.rejects(begin());assert.equal(calls,before+1);
      }
      mode='release';await client.release({dispatchId:randomUUID(),brokerId:broker.brokerId,request:op});
    });
  }finally{
    if(server){server.closeAllConnections();await new Promise<void>(r=>server!.close(()=>r()));}
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
