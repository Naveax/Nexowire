/** Real disposable TLS socket; deliberately no real native effect or authority. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,generateKeyPairSync,randomUUID,X509Certificate} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {request} from 'node:https';
import type {AddressInfo} from 'node:net';
import path from 'node:path';
import os from 'node:os';
import {createCoreNativeVerifierServer} from '../../src/security/core-native-verifier-server.js';
import {createBrokerDispatchAuthorityHandler} from '../../src/agent/broker-dispatch-authority-handler.js';

test('protected dispatch reauthenticates after native readback and denies changed credential',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'nx-dispatch-recheck-'));
  let server:ReturnType<typeof createCoreNativeVerifierServer>|undefined;
  try{
    let openssl='';
    for(const bin of ['openssl','C:\\Program Files\\Git\\usr\\bin\\openssl.exe']){
      try{execFileSync(bin,['version'],{stdio:'ignore'});openssl=bin;break}catch{}
    }
    assert.ok(openssl,'OpenSSL required');
    const run=(args:string[])=>execFileSync(openssl,args,{cwd:root,stdio:'ignore',timeout:15000});
    run(['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes',
      '-keyout','ca.key','-out','ca.crt','-days','1','-subj','/CN=Dispatch Recheck CA',
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
    const cert=await pem('client.crt'),ca=await pem('ca.crt'),key=await pem('client.key');
    const fingerprint=createHash('sha256').update(new X509Certificate(cert).raw).digest('hex');
    const principal={brokerId:randomUUID(),ownerId:randomUUID(),deviceId:randomUUID(),
      deviceEpoch:randomUUID(),sessionEpoch:randomUUID()};
    const evidence={verified:true as const,brokerId:principal.brokerId,ownerEpoch:1,grantGeneration:1,
      highIntegrityToken:true as const,signedProtectedImage:true as const,protectedParentAndImports:true as const};
    const op={requestId:randomUUID(),fingerprint:'a'.repeat(64),capability:'fixture.no-effect',
      scope:{ownerId:principal.ownerId,deviceId:principal.deviceId,deviceEpoch:principal.deviceEpoch,
        sessionEpoch:principal.sessionEpoch,ownerEpoch:1,expectedGeneration:1,requiredPrivilege:'CORE'}};
    let active=true,changeDuringNative=true,authCalls=0,nativeCalls=0,dispatchCalls=0;
    const noEffect=async()=>{dispatchCalls++;throw Error('fixture never grants effects')};
    const handler=createBrokerDispatchAuthorityHandler({authorityId:randomUUID(),
      publicKeyPem:generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString(),
      requireMutualTls:true,
      authenticateBroker:async(credential,peer)=>{
        authCalls++;assert.equal(credential,'a'.repeat(48));assert.equal(peer?.certificateSha256,fingerprint);
        return active?principal:undefined;
      },
      readProtectedBroker:async()=>{
        nativeCalls++;if(changeDuringNative)active=false;return evidence;
      },
      verifyOwnerRevocation:async()=>false,
      authority:{beginIfCurrent:noEffect,commitIfCurrent:noEffect,revokeAndDrain:noEffect,release:noEffect},
    });
    server=createCoreNativeVerifierServer({keyPem:await pem('server.key'),certificatePem:await pem('server.crt'),
      clientCaPem:ca,handler});
    const listener=server;
    await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));
    const port=(listener.address() as AddressInfo).port;
    const call=()=>new Promise<number>((resolve,reject)=>{
      const body=JSON.stringify({request:op,broker:evidence,challengeNonce:'b'.repeat(64)});
      const req=request({hostname:'127.0.0.1',port,path:'/v1/broker-dispatch/begin',
        method:'POST',agent:false,key,cert,ca,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',
        headers:{authorization:'Bearer '+'a'.repeat(48),'content-type':'application/json',
          'content-length':Buffer.byteLength(body)}},res=>{
          res.resume();res.once('end',()=>resolve(res.statusCode!));
        });
      req.once('error',reject);req.setTimeout(3000,()=>req.destroy(Error('fixture timeout')));req.end(body);
    });
    assert.equal(await call(),403);
    assert.equal(authCalls,2);assert.equal(nativeCalls,1);assert.equal(dispatchCalls,0);
    active=true;changeDuringNative=false;
    assert.equal(await call(),503,'stable binding reaches only the denying fixture authority');
    assert.equal(authCalls,4);assert.equal(nativeCalls,2);assert.equal(dispatchCalls,1);
  }finally{
    if(server){server.closeAllConnections();await new Promise<void>(r=>server!.close(()=>r()));}
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
