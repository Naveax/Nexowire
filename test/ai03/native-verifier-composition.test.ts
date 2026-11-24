import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign,X509Certificate} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createScopedNativeVerifierResolver,startCoreNativeVerifierService}
  from '../../src/security/core-native-verifier-service.js';
import {createCoreNativeMtlsFetch} from '../../src/security/core-native-mtls-fetch.js';
import {RemoteTrustedNativeCoreEnrollmentVerifier} from '../../src/product/core-native-consent-verifier.js';

// The legacy npm test glob omits direct test/*.test.ts. This entry executes
// the restored transport and actual disposable TLS fixtures, not production
// or the separate real-PostgreSQL job.
import '../core-native-consent-transport.test.js';
import '../core-native-enrollment-verifier-handler.test.js';
import '../core-native-verifier-server.test.js';

const digest=(text:string|Buffer)=>createHash('sha256').update(text).digest('hex');
const credential='fixture_only_'+ 'a'.repeat(48);
const scoped=()=>({credentialSha256:digest(credential),certificateSha256:'a'.repeat(64),
  ownerAccountId:'owner-fixture-0001',deviceId:'device-fixture-0001',installationId:randomUUID(),
  notBeforeMs:Date.now()-10000,expiresAtMs:Date.now()+60000});

test('AI-03 verifier composition: credential and actual peer pin bind one immutable scope',async()=>{
  const record=scoped(),original={...record};
  const resolver=createScopedNativeVerifierResolver([record]);
  record.ownerAccountId='different-owner';record.certificateSha256='b'.repeat(64);
  const signal=new AbortController().signal;
  const accepted=await resolver(credential,{certificateSha256:original.certificateSha256},signal);
  assert.deepEqual(accepted,{role:'independent-enrollment-verifier',ownerAccountId:original.ownerAccountId,
    deviceId:original.deviceId,installationId:original.installationId});
  assert.equal(Object.isFrozen(accepted),true);
  assert.equal(await resolver(credential,{certificateSha256:record.certificateSha256},signal),null);
  assert.equal(await resolver('b'.repeat(64),{certificateSha256:original.certificateSha256},signal),null);
  const cancelled=new AbortController();cancelled.abort();
  assert.equal(await resolver(credential,{certificateSha256:original.certificateSha256},cancelled.signal),null);
  assert.throws(()=>createScopedNativeVerifierResolver([original,{...original,deviceId:'another-device'}]),
    /CORE_NATIVE_VERIFIER_CREDENTIAL_DUPLICATE/);
  assert.throws(()=>createScopedNativeVerifierResolver([]),/CORE_NATIVE_VERIFIER_PROVISIONING_INVALID/);
  const expired=createScopedNativeVerifierResolver([{...original,notBeforeMs:1,expiresAtMs:2}]);
  assert.equal(await expired(credential,{certificateSha256:original.certificateSha256},signal),null);
  const future=createScopedNativeVerifierResolver([{...original,notBeforeMs:Date.now()+60000,
    expiresAtMs:Date.now()+120000}]);
  assert.equal(await future(credential,{certificateSha256:original.certificateSha256},signal),null);
});

test('AI-03 real verifier listener denies absent independent provenance without DB fallback',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'nx-verifier-service-fixture-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  let openssl:string|undefined;
  for(const bin of ['openssl','C:\\Program Files\\Git\\usr\\bin\\openssl.exe']){
    try{execFileSync(bin,['version'],{stdio:'ignore'});openssl=bin;break;}catch{}
  }
  assert.ok(openssl,'OPENSSL_REQUIRED_FOR_DISPOSABLE_MTLS_TEST');
  const run=(args:string[])=>execFileSync(openssl!,args,{cwd:root,stdio:'ignore',timeout:15000});
  run(['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes',
    '-keyout','ca.key','-out','ca.crt','-days','1','-subj','/CN=Disposable CA',
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
  const read=(name:string)=>readFile(path.join(root,name),'utf8');
  const [ca,keyPem,certificatePem,clientKey,clientCert]=await Promise.all(
    ['ca.crt','server.key','server.crt','client.key','client.crt'].map(read));
  assert.ok(ca&&keyPem&&certificatePem&&clientKey&&clientCert);
  const record={...scoped(),certificateSha256:digest(new X509Certificate(clientCert).raw)};
  const keys=generateKeyPairSync('ed25519'),pin=keys.publicKey.export({format:'der',type:'spki'}).toString('base64');
  let provenanceCalls=0,nativeCalls=0,signCalls=0;
  const service=await startCoreNativeVerifierService({host:'127.0.0.1',port:0,authorityId:randomUUID(),
    // This pool is real and lazy. The intentionally unavailable witness must
    // deny before any DB connection. No production database/credential exists.
    database:{host:'localhost',port:1,database:'fixture',user:'fixture',password:'fixture-only',
      caPem:ca,clientCertificatePem:clientCert,clientKeyPem:clientKey},
    tls:{keyPem,certificatePem,clientCaPem:ca},credentialRecords:[record],
    verifyProvenance:async()=>{provenanceCalls++;throw Error('synthetic unavailable provenance');},
    readProtectedNativeBinding:async()=>{nativeCalls++;return null;},
    signer:{publicSpkiBase64:pin,sign:async bytes=>{signCalls++;return sign(null,bytes,keys.privateKey);}},
  });
  t.after(()=>service.close());
  assert.equal(service.physicalAcceptance,'NOT_PROVEN');
  const origin='https://127.0.0.1:'+service.port;
  const transport=createCoreNativeMtlsFetch({origin,keyPem:clientKey,certificatePem:clientCert,
    serverCaPem:ca,serverSpkiSha256:digest(new X509Certificate(certificatePem).publicKey.export({type:'spki',format:'der'}))});
  const verifier=new RemoteTrustedNativeCoreEnrollmentVerifier({origin,credential,pinnedSpkiBase64:pin,
    fetchImpl:transport});
  const expected={ownerAccountId:record.ownerAccountId,deviceId:record.deviceId,
    installationId:record.installationId,enrollmentId:randomUUID(),ownerEpoch:1,grantGeneration:1,
    revokeEpoch:0,nativeConsentReceiptId:randomUUID(),windowsUserSid:'S-1-5-21-101-202-303-1001',
    windowsSessionId:1,windowsLogonLuid:'000000000000a101',windowsLogonSessionEpoch:randomUUID()};
  assert.equal(await verifier.currentReadback({...expected,deviceId:'different-device'}),false);
  assert.equal(provenanceCalls,0,'wrong scope must never reach ledger');
  assert.equal(await verifier.currentReadback(expected),false);
  assert.equal(provenanceCalls,1,'correct scoped mTLS request reaches real ledger preflight');
  assert.equal(nativeCalls,0);
  assert.equal(signCalls,0);
  await service.close();await service.close();
});
