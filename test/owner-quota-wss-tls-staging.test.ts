import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {X509Certificate,generateKeyPairSync,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import WebSocket from 'ws';
import {
  startProposedOwnerQuotaOutboundWsHub,ProposedOutboundQuotaWsClient,
  verifyStagingQuotaWsUrl,type OutboundQuotaFrame,type StagingOwnerWssIdentity,
} from '../src/product/owner-quota-outbound-ws-proposal.js';
import {startProposedOwnerQuotaLoopbackRpc,
  signDevOwnerQuotaRpcEnvelope} from '../src/product/owner-quota-loopback-rpc-proposal.js';
import {ProposedTrustedOwnerQuotaAuthority}
  from '../src/product/trusted-owner-quota-authority-proposal.js';

const account='tls-owner-account-001',device='tls-owner-device-001';
const bearer='tls-owner-firstparty-bearer-001';
const kp=generateKeyPairSync('ed25519');
const devPub=kp.publicKey.export({format:'pem',type:'spki'}).toString();
const devPriv=kp.privateKey.export({format:'pem',type:'pkcs8'}).toString();
function opensslPath():string|null{
  for(const candidate of [
    'openssl',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
  ]){
    try{execFileSync(candidate,['version'],{stdio:'ignore',timeout:10000});
      return candidate;
    }catch{}
  }
  return null;
}
const openssl=opensslPath();
function certFixture(san='IP:127.0.0.1'){
  if(!openssl)throw new Error('OpenSSL unavailable for ephemeral DEV certificate');
  const folder=mkdtempSync(path.join(tmpdir(),'nexowire-wss-dev-'));
  const key=path.join(folder,'temporary.key');
  const cert=path.join(folder,'temporary.crt');
  execFileSync(openssl,[
    'req','-x509','-newkey','rsa:2048','-sha256','-nodes',
    '-keyout',key,'-out',cert,'-days','1',
    '-subj','/CN=DEV-Nexowire-test-only',
    '-addext','subjectAltName='+san,
    '-addext','basicConstraints=critical,CA:TRUE',
  ],{timeout:25000,stdio:'ignore'});
  const certificatePem=readFileSync(cert,'utf8');
  const privateKeyPem=readFileSync(key,'utf8');
  const expectedLeafSha256=new X509Certificate(certificatePem).fingerprint256
    .replaceAll(':','').toLowerCase();
  return {
    certificatePem,privateKeyPem,expectedLeafSha256,
    close:()=>rmSync(folder,{recursive:true,force:true}),
  };
}
async function setup(certReturn?:ReturnType<typeof certFixture>){
  const cert=certReturn??certFixture();
  const db=new DatabaseSync(':memory:');
  for(const file of [
    'test/fixtures/scale-v2-owner-shared-quota-dev.sql',
    'test/fixtures/scale-v2-all-ingress-transport-staging.sql',
    'test/fixtures/scale-v2-owner-quota-rpc-dev.sql',
  ])db.exec(readFileSync(path.join(process.cwd(),file),'utf8'));
  db.prepare('INSERT INTO proposed_owner_quota_accounts VALUES(?,?,?,?,?)')
    .run(account,'custom',100,1,1);
  db.prepare('INSERT INTO proposed_owner_quota_devices VALUES(?,?,?,?)')
    .run(device,account,1,'safe');
  db.prepare('INSERT INTO proposed_owner_rpc_device_keys VALUES(?,?,1)')
    .run(device,devPub);
  const auth=new ProposedTrustedOwnerQuotaAuthority(db,async token=>
    token===bearer?{accountId:account,sessionGeneration:1}:null);
  const rpc=await startProposedOwnerQuotaLoopbackRpc({
    db,authority:auth,
    trustedToolCatalog:new Map([['tls-read-tool-001',{
      operationClass:'read',
      toolFingerprint:createHash('sha256').update('tls-read').digest('hex'),
    }]]),
  });
  const hub=await startProposedOwnerQuotaOutboundWsHub({
    trustedOwnerRpcOrigin:rpc.origin,
    tls:{certificatePem:cert.certificatePem,privateKeyPem:cert.privateKeyPem},
  });
  const trusted:StagingOwnerWssIdentity={
    trustedCaPem:cert.certificatePem,
    expectedLeafSha256:cert.expectedLeafSha256,
  };
  const clients:ProposedOutboundQuotaWsClient[]=[];
  const dial=(id:StagingOwnerWssIdentity=trusted)=>{
    const client=new ProposedOutboundQuotaWsClient(hub.url,id);
    clients.push(client);return client;
  };
  const used=()=>Number((db.prepare('SELECT used FROM proposed_owner_quota_daily')
    .get() as {used:number}|undefined)?.used??0);
  return {
    cert,db,hub,rpc,trusted,dial,used,
    async close(){for(const c of clients)c.close();
      await hub.close();await rpc.close();db.close();
      if(!certReturn)cert.close()},
  };
}
function frame(nonce:string,id:string):OutboundQuotaFrame {
  const signed=signDevOwnerQuotaRpcEnvelope({
    envelope:{
      version:1,deviceId:device,nonce,
      issuedAtMs:Date.now(),
      body:{bearerToken:bearer,invocationId:id,toolId:'tls-read-tool-001'},
    },
    devicePrivateKeyPem:devPriv,
  });
  return {version:1,kind:'reserve',
    requestId:'wss-req-'+nonce,envelope:signed};
}
test('secure WSS requires exact localhost URL and pinned CA identity config',()=>{
  assert.throws(()=>verifyStagingQuotaWsUrl(
    'wss://prod.example.com/internal/owner-quota/v1/outbound',true));
  assert.throws(()=>verifyStagingQuotaWsUrl(
    'ws://127.0.0.1:34567/internal/owner-quota/v1/outbound',true));
  assert.throws(()=>new ProposedOutboundQuotaWsClient(
    'wss://127.0.0.1:34567/internal/owner-quota/v1/outbound'));
  assert.throws(()=>new ProposedOutboundQuotaWsClient(
    'wss://127.0.0.1:34567/internal/owner-quota/v1/outbound',
    {trustedCaPem:'no certificate',expectedLeafSha256:'bad'}));
});
test('TLS 1.3 pinned WSS -> signed owner RPC -> daily quota works end-to-end',
  {skip:!openssl},async()=>{
  const x=await setup();try{
    const client=x.dial();
    const result=await client.reserve(frame('wss-valid-nonce-0001','wss-invocation-0001'));
    assert.equal(result.httpStatus,200);
    assert.equal((result.data as {decision:{status:string}}).decision.status,'reserved');
    assert.equal((result.data as {decision:{authorizesToolExecution:boolean}})
      .decision.authorizesToolExecution,false);
    assert.equal(x.used(),1);
    assert.match(x.hub.url,/^wss:\/\/127\.0\.0\.1:\d+/);
  }finally{await x.close()}
});
test('trusted WSS cannot reuse signed nonce; fresh nonce old logical invocation no double spend',
  {skip:!openssl},async()=>{
  const x=await setup();try{
    const c=x.dial();
    const first=frame('wss-first-nonce-0001','wss-same-invocation-0001');
    assert.equal((await c.reserve(first)).httpStatus,200);
    const replay=await c.reserve({...first,requestId:'wss-retry-request-0002'});
    assert.equal(replay.httpStatus,409);
    const second=await c.reserve(frame('wss-second-nonce-0002','wss-same-invocation-0001'));
    assert.equal((second.data as {decision:{status:string}}).decision.status,'duplicate');
    assert.equal(x.used(),1);
  }finally{await x.close()}
});
test('incorrect leaf certificate pin blocks WSS before a quota is reserved',
  {skip:!openssl},async()=>{
  const x=await setup();try{
    const wrong=x.dial({...x.trusted,expectedLeafSha256:'0'.repeat(64)});
    await assert.rejects(wrong.reserve(frame('wss-wrong-pin-0001','wss-pin-invocation-001')));
    assert.equal(x.used(),0);
  }finally{await x.close()}
});
test('untrusted CA blocks WSS even with correct leaf fingerprint',
  {skip:!openssl},async()=>{
  const a=certFixture(),b=certFixture();
  const x=await setup(a);try{
    const c=x.dial({
      trustedCaPem:b.certificatePem,
      expectedLeafSha256:a.expectedLeafSha256,
    });
    await assert.rejects(c.reserve(frame('wss-wrong-ca-0001','wss-ca-invocation-001')));
    assert.equal(x.used(),0);
  }finally{await x.close();a.close();b.close()}
});
test('untrusted WSS cannot opt out of hostname verification',
  {skip:!openssl},async()=>{
  const x=await setup();try{
    const wrongUrl=x.hub.url.replace('127.0.0.1','localhost');
    assert.throws(()=>new ProposedOutboundQuotaWsClient(wrongUrl,x.trusted));
    assert.equal(x.used(),0);
  }finally{await x.close()}
});
test('trusted certificate + valid pin still rejected when hostname/IP SAN differs',
  {skip:!openssl},async()=>{
  const wrongHost=certFixture('DNS:localhost');
  const x=await setup(wrongHost);try{
    const c=x.dial();
    await assert.rejects(c.reserve(frame('wss-hostname-001','wss-hostname-invocation-001')));
    assert.equal(x.used(),0);
  }finally{await x.close();wrongHost.close()}
});
test('legacy TLS 1.2 client rejected by TLS1.3-only WSS origin',
  {skip:!openssl},async()=>{
  const x=await setup();try{
    const legacy=new WebSocket(x.hub.url,{
      ca:x.cert.certificatePem,
      rejectUnauthorized:true,
      minVersion:'TLSv1.2',maxVersion:'TLSv1.2',
      handshakeTimeout:2000,
    });
    await new Promise<void>((resolve,reject)=>{
      legacy.once('open',()=>reject(new Error('TLS1.2 unexpectedly accepted')));
      legacy.once('error',()=>resolve());
      legacy.once('close',()=>resolve());
    });
    legacy.terminate();
    assert.equal(x.used(),0);
  }finally{await x.close()}
});
