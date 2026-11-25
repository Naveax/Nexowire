/** Real disposable mTLS transport and signed readback fixture, not native approval. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,generateKeyPairSync,randomUUID,sign,X509Certificate} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import type {AddressInfo} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {createCoreNativeVerifierServer} from '../../src/security/core-native-verifier-server.js';
import {CoreNativeWireRequestSchema,coreNativeSignedResponseBytes,coreNativeWireRequestHash,
  type CoreNativeProof} from '../../src/protocol/core-native-consent-transport.js';
import {createProtectedDispatchInstallationReadback} from '../../src/agent/protected-dispatch-native-installation-readback.js';
import type {ProtectedDispatchCredentialRecord} from '../../src/agent/protected-broker-dispatch-service.js';

test('dispatch installation readback binds protected mapping to independently signed exact native scope',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'nx-dispatch-native-readback-'));
  let server:ReturnType<typeof createCoreNativeVerifierServer>|undefined;
  try{
    let openssl='';
    for(const bin of ['openssl','C:\\Program Files\\Git\\usr\\bin\\openssl.exe']){
      try{execFileSync(bin,['version'],{stdio:'ignore'});openssl=bin;break}catch{}
    }
    assert.ok(openssl);
    const run=(args:string[])=>execFileSync(openssl,args,{cwd:root,stdio:'ignore',timeout:15000});
    run(['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes',
      '-keyout','ca.key','-out','ca.crt','-days','1','-subj','/CN=Dispatch Readback Fixture',
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
    const ca=await pem('ca.crt'),serverCert=await pem('server.crt');
    const signer=generateKeyPairSync('ed25519'),wrongSigner=generateKeyPairSync('ed25519');
    const pin=signer.publicKey.export({format:'der',type:'spki'}).toString('base64');
    const tlsPin=createHash('sha256').update(new X509Certificate(serverCert).publicKey.export({
      format:'der',type:'spki'})).digest('hex');
    const record:ProtectedDispatchCredentialRecord={credentialSha256:'a'.repeat(64),
      certificateSha256:'b'.repeat(64),brokerId:randomUUID(),ownerId:randomUUID(),
      deviceId:randomUUID(),installationId:randomUUID(),deviceEpoch:randomUUID(),
      sessionEpoch:randomUUID(),state:'ACTIVE',notBeforeMs:Date.now()-1000,expiresAtMs:Date.now()+60000};
    const nativeBinding={ownerAccountId:'native-owner-'+randomUUID(),deviceId:'native-device-'+randomUUID(),
      installationId:record.installationId,enrollmentId:randomUUID(),ownerEpoch:2,grantGeneration:3,
      revokeEpoch:1,windowsUserSid:'S-1-5-21-123-456-789-1001',windowsSessionId:1,
      windowsLogonLuid:'000000000000abcd',windowsLogonSessionEpoch:randomUUID(),
      nativeConsentReceiptId:randomUUID()};
    const {nativeConsentReceiptId:receiptId,...nativeFields}=nativeBinding;
    const proof:CoreNativeProof={...nativeFields,version:1,challengeId:randomUUID(),
      receiptId,approvedAtMs:Date.now(),consumed:true};
    let calls=0,wrongProof=false,wrongSignature=false;
    server=createCoreNativeVerifierServer({keyPem:await pem('server.key'),certificatePem:serverCert,
      clientCaPem:ca,handler:(req,res)=>{void(async()=>{
        assert.equal(req.url,'/v1/core-native-consent');
        assert.equal(req.headers.authorization,'Bearer '+'c'.repeat(48));
        const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
        const wire=CoreNativeWireRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        assert.equal(wire.operation,'current-readback');assert.deepEqual(wire.expected,nativeBinding);
        calls++;
        const unsigned={version:1 as const,operation:wire.operation,nonce:wire.nonce,
          requestSha256:coreNativeWireRequestHash(wire),observedAtMs:Date.now(),accepted:true,
          proof:wrongProof?{...proof,windowsLogonLuid:'0000000000001234'}:proof};
        const signatureBase64=sign(null,coreNativeSignedResponseBytes(unsigned),
          wrongSignature?wrongSigner.privateKey:signer.privateKey).toString('base64');
        res.writeHead(200,{'content-type':'application/json'});
        res.end(JSON.stringify({...unsigned,signatureBase64}));
      })().catch(()=>res.destroy());}});
    const listener=server;
    await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));
    const origin='https://127.0.0.1:'+(listener.address() as AddressInfo).port;
    const {state:_,notBeforeMs:__,expiresAtMs:___,...dispatchScope}=record;
    const provision={binding:{...dispatchScope,nativeBinding},verifier:{origin,
      credential:'c'.repeat(48),pinnedSpkiBase64:pin,serverSpkiSha256:tlsPin,
      serverCaPem:ca,keyPem:await pem('client.key'),certificatePem:await pem('client.crt')}};
    const verify=createProtectedDispatchInstallationReadback([provision]);
    const signal=new AbortController().signal;
    assert.equal(await verify({...record,sessionEpoch:randomUUID()},signal),false);
    assert.equal(calls,0);
    assert.equal(await verify(record,signal),true);
    wrongProof=true;assert.equal(await verify(record,signal),false);
    wrongProof=false;wrongSignature=true;assert.equal(await verify(record,signal),false);
    wrongSignature=false;
    const wrongPin=createProtectedDispatchInstallationReadback([{...provision,
      verifier:{...provision.verifier,serverSpkiSha256:'0'.repeat(64)}}]);
    assert.equal(await wrongPin(record,signal),false);
    const ctrl=new AbortController();ctrl.abort();
    assert.equal(await verify(record,ctrl.signal),false);
    assert.equal(calls,3);
    assert.throws(()=>createProtectedDispatchInstallationReadback([provision,provision]));
    assert.throws(()=>createProtectedDispatchInstallationReadback([{...provision,
      binding:{...provision.binding,installationId:randomUUID()}}]));
  }finally{
    if(server){server.closeAllConnections();await new Promise<void>(r=>server!.close(()=>r()));}
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
