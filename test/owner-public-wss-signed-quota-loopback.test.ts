import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,generateKeyPairSync,X509Certificate} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {Agent as HttpsAgent} from 'node:https';
import {tmpdir} from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {
  createOwnerPublicWssClientOptions,type OwnerPublicWssTrustProfile,
} from '../src/product/owner-public-wss-trust-proposal.js';
import {
  startProposedOwnerQuotaOutboundWsHub,type OutboundQuotaFrame,
} from '../src/product/owner-quota-outbound-ws-proposal.js';
import {startProposedOwnerQuotaLoopbackRpc,signDevOwnerQuotaRpcEnvelope}
  from '../src/product/owner-quota-loopback-rpc-proposal.js';
import {ProposedTrustedOwnerQuotaAuthority}
  from '../src/product/trusted-owner-quota-authority-proposal.js';

/**
 * A TLS/WSS integration proof, NOT real external WSS routing:
 * the owner staging hub binds to 127.0.0.1 only; this test deliberately
 * passes the independently pinned public hostname as TLS SNI while the TCP
 * test transport targets the ephemeral loopback port. Production code must
 * use the exact validated public profile.endpoint without local overrides.
 */
const ACCOUNT='dev-public-wss-identity-001';
const DEVICE='dev-public-wss-device-001';
const TOKEN='dev-public-wss-firstparty-token-001';
const HOST='edge.example.com';
const ENDPOINT='wss://edge.example.com/internal/owner-quota/v1/outbound';
function opensslBinary(){
  for(const bin of ['openssl','C:\\Program Files\\Git\\usr\\bin\\openssl.exe']){
    try{execFileSync(bin,['version'],{stdio:'ignore',timeout:8000});return bin}catch{}
  }
  return null;
}
const openssl=opensslBinary();
function makeCertificate(san='DNS:edge.example.com'){
  if(!openssl)throw new Error('DEV test needs OpenSSL');
  const folder=mkdtempSync(path.join(tmpdir(),'nexowire-public-signed-wss-'));
  try{
    const cert=path.join(folder,'temporary.cert');
    const key=path.join(folder,'temporary.key');
    execFileSync(openssl,[
      'req','-x509','-newkey','rsa:2048','-sha256','-nodes',
      '-keyout',key,'-out',cert,'-days','1',
      '-subj','/CN=DEV-only-owner-wss',
      '-addext','subjectAltName='+san,
      '-addext','basicConstraints=critical,CA:TRUE',
    ],{stdio:'ignore',timeout:20000});
    const certificatePem=readFileSync(cert,'utf8');
    const x509=new X509Certificate(certificatePem);
    const spki=createHash('sha256').update(x509.publicKey.export({
      format:'der',type:'spki',
    })).digest('hex');
    return {
      certificatePem,
      privateKeyPem:readFileSync(key,'utf8'),
      spki,
      remove:()=>rmSync(folder,{recursive:true,force:true}),
    };
  }catch(e){rmSync(folder,{recursive:true,force:true});throw e}
}
async function fixture(){
  const certificate=makeCertificate();
  const key=generateKeyPairSync('ed25519');
  const pub=key.publicKey.export({type:'spki',format:'pem'}).toString();
  const priv=key.privateKey.export({type:'pkcs8',format:'pem'}).toString();
  const db=new DatabaseSync(':memory:');
  for(const file of [
    'test/fixtures/scale-v2-owner-shared-quota-dev.sql',
    'test/fixtures/scale-v2-all-ingress-transport-staging.sql',
    'test/fixtures/scale-v2-owner-quota-rpc-dev.sql',
  ])db.exec(readFileSync(path.resolve(file),'utf8'));
  db.prepare('INSERT INTO proposed_owner_quota_accounts VALUES(?,?,?,?,?)')
    .run(ACCOUNT,'custom',100,1,1);
  db.prepare('INSERT INTO proposed_owner_quota_devices VALUES(?,?,?,?)')
    .run(DEVICE,ACCOUNT,1,'safe');
  db.prepare('INSERT INTO proposed_owner_rpc_device_keys VALUES(?,?,1)')
    .run(DEVICE,pub);
  const authority=new ProposedTrustedOwnerQuotaAuthority(db,async t=>
    t===TOKEN?{accountId:ACCOUNT,sessionGeneration:1}:null);
  const rpc=await startProposedOwnerQuotaLoopbackRpc({
    db,authority,
    trustedToolCatalog:new Map([['public-owner-read',{
      operationClass:'read' as const,
      toolFingerprint:createHash('sha256').update('owner:public-read').digest('hex'),
    }]]),
  });
  const hub=await startProposedOwnerQuotaOutboundWsHub({
    trustedOwnerRpcOrigin:rpc.origin,
    tls:{
      privateKeyPem:certificate.privateKeyPem,
      certificatePem:certificate.certificatePem,
    },
  });
  const trust:OwnerPublicWssTrustProfile={
    endpoint:ENDPOINT,expectedHostname:HOST,
    caMode:'custom',trustedCaPem:certificate.certificatePem,
    trustedSpkiSha256:[certificate.spki],
  };
  const request=(nonce:string,logicalId:string,requestId:string):OutboundQuotaFrame=>({
    kind:'reserve',version:1,requestId,
    envelope:signDevOwnerQuotaRpcEnvelope({
      envelope:{
        version:1,deviceId:DEVICE,nonce,issuedAtMs:Date.now(),
        body:{
          bearerToken:TOKEN,invocationId:logicalId,
          toolId:'public-owner-read',
        },
      },devicePrivateKeyPem:priv,
    }),
  });
  const used=()=>Number((db.prepare(
    'SELECT COALESCE(SUM(used),0) AS used FROM proposed_owner_quota_daily',
  ).get() as {used:number}).used);
  async function close(){
    await hub.close();await rpc.close();db.close();certificate.remove();
  }
  return {hub,trust,request,used,db,close};
}
async function sendThroughTlsTestEdge(input:{
  localStagingUrl:string;
  trust:OwnerPublicWssTrustProfile;
  request:OutboundQuotaFrame;
  serverName?:string;
  /** STAGING ONLY: simulate an application losing an already received ACK. */
  dropReply?:boolean;
}){
  const opts=createOwnerPublicWssClientOptions(input.trust);
  // Test-only transport override: actual TCP goes to local ephemeral WSS,
  // while SNI, TLS trust and pins reference edge.example.com.
  const testOnlySni={servername:input.serverName??HOST};
  const socket=new WebSocket(input.localStagingUrl,{
    ...opts,...testOnlySni,maxPayload:16*1024,
  });
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    return await new Promise<{
      version:number;requestId:string;httpStatus:number;
      data:{decision?:{status?:string;authorizesToolExecution?:boolean},error?:string};
    }>((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('Bounded staging WSS timeout')),5000);
      socket.once('open',()=>socket.send(JSON.stringify(input.request)));
      socket.once('message',raw=>{
        if(input.dropReply){
          reject(new Error('Simulated application-lost WSS ACK'));
          return;
        }
        try{resolve(JSON.parse(raw.toString()))}catch(e){reject(e)}
      });
      socket.once('error',reject);
      socket.once('close',()=>reject(new Error('WSS closed before quota decision')));
    });
  }finally{
    if(timer)clearTimeout(timer);
    socket.terminate();
    (opts.agent as HttpsAgent).destroy();
  }
}
test('real pinned TLS1.3 WSS frames reach signed owner RPC without native execution',
  {skip:!openssl,timeout:25000},async()=>{
  const x=await fixture();
  try{
    assert.match(x.hub.url,/^wss:\/\/127\.0\.0\.1:\d+/);
    const first=x.request('public-wss-nonce-0001','public-wss-logical-0001','public-wss-msg-0001');
    const ok=await sendThroughTlsTestEdge({
      localStagingUrl:x.hub.url,trust:x.trust,request:first,
    });
    assert.equal(ok.httpStatus,200);
    assert.equal(ok.data.decision?.status,'reserved');
    assert.equal(ok.data.decision?.authorizesToolExecution,false);
    assert.equal(x.used(),1);
    const replay=await sendThroughTlsTestEdge({
      localStagingUrl:x.hub.url,trust:x.trust,
      request:{...first,requestId:'public-wss-replayed-0002'},
    });
    assert.equal(replay.httpStatus,409);
    const fresh=await sendThroughTlsTestEdge({
      localStagingUrl:x.hub.url,trust:x.trust,
      request:x.request('public-wss-nonce-0002',
        'public-wss-logical-0001','public-wss-msg-0003'),
    });
    assert.equal(fresh.httpStatus,200);
    assert.equal(fresh.data.decision?.status,'duplicate');
    assert.equal(x.used(),1);
  }finally{await x.close()}
});
test('wrong CA, SPKI and SNI prevent quota spend over the same WSS test edge',
  {skip:!openssl,timeout:25000},async()=>{
  const x=await fixture();
  const other=makeCertificate();
  try{
    const request=x.request('public-wss-reject-nonce-0001',
      'public-wss-reject-logical-0001','public-wss-reject-msg-0001');
    const base={localStagingUrl:x.hub.url,trust:x.trust,request};
    await assert.rejects(sendThroughTlsTestEdge({
      ...base,trust:{...x.trust,trustedSpkiSha256:['0'.repeat(64)]},
    }),/SPKI pin mismatch/);
    await assert.rejects(sendThroughTlsTestEdge({
      ...base,trust:{...x.trust,trustedCaPem:other.certificatePem},
    }),/self-signed|verify|certificate/i);
    await assert.rejects(sendThroughTlsTestEdge({
      ...base,serverName:'other.example.com',
    }),/Unexpected owner WSS TLS SNI hostname/);
    assert.equal(x.used(),0);
  }finally{other.remove();await x.close()}
});

test('application-dropped ACK: new connection cannot replay nonce or double-charge logical invocation',
  {skip:!openssl,timeout:25000},async()=>{
  const x=await fixture();
  try{
    const first=x.request(
      'ack-loss-nonce-0001','ack-loss-logical-0001','ack-loss-frame-0001',
    );
    // Reply reaches the test transport, but application deliberately drops
    // it. This does not claim physical packet loss / separate-ISP coverage.
    await assert.rejects(sendThroughTlsTestEdge({
      localStagingUrl:x.hub.url,trust:x.trust,request:first,dropReply:true,
    }),/application-lost/);
    assert.equal(x.used(),1);
    const reused=await sendThroughTlsTestEdge({
      localStagingUrl:x.hub.url,trust:x.trust,
      request:{...first,requestId:'ack-loss-frame-0002'},
    });
    assert.equal(reused.httpStatus,409);
    assert.equal(x.used(),1);
    const reconciled=await sendThroughTlsTestEdge({
      localStagingUrl:x.hub.url,trust:x.trust,
      request:x.request(
        'ack-loss-nonce-0002','ack-loss-logical-0001','ack-loss-frame-0003',
      ),
    });
    assert.equal(reconciled.httpStatus,200);
    assert.equal(reconciled.data.decision?.status,'duplicate');
    assert.equal(reconciled.data.decision?.authorizesToolExecution,false);
    assert.equal(x.used(),1);
  }finally{await x.close()}
});