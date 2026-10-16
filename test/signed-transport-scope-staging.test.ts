import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createServer,type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  issueOperatorRouteAttestation,
  verifyOperatorRouteAttestation,
  createSignedStagingTransportBudget,
  type TrustedSignedTransportClaims,
} from '../src/mcp/signed-transport-scope-proposal.js';
import { ProposedAllIngressTransportMeter }
  from '../src/mcp/all-ingress-transport-meter-proposal.js';
import { createLocalFirstIngressServer } from '../src/mcp/local-first-ingress.js';

const keys=generateKeyPairSync('ed25519');
const privateKey=keys.privateKey.export({format:'pem',type:'pkcs8'}).toString();
const publicKey=keys.publicKey.export({format:'pem',type:'spki'}).toString();
const issuedAt=new Date('2026-10-16T19:00:00.000Z');
const expectedUrl='https://mcp.example.test/mcp';
const claims:TrustedSignedTransportClaims={
  version:1,audience:'nexowire-local-first-mcp',
  issuer:'verified-owner-control-plane-001',
  keyId:'route-key-v1',
  tunnelId:'verified-tunnel-001',
  callerKind:'application',
  callerId:'verified-calling-app-001',
  publicResourceUrl:expectedUrl,
  routeGeneration:5,
  issuedAtMs:issuedAt.getTime(),
  expiresAtMs:issuedAt.getTime()+900000,
};
const route=issueOperatorRouteAttestation(claims,privateKey);
const params={
  route,operatorPublicKeyPem:publicKey,
  expectedIssuer:claims.issuer,expectedKeyId:claims.keyId,
  expectedPublicResourceUrl:expectedUrl,minimumRouteGeneration:5,
  now:issuedAt,
};
function verify(patch:Partial<typeof params>={}){
  return verifyOperatorRouteAttestation({...params,...patch});
}
function fakeMeter(limit=1){
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(path.join(process.cwd(),
    'test/fixtures/scale-v2-all-ingress-transport-staging.sql'),'utf8'));
  return {db,meter:new ProposedAllIngressTransportMeter(db,limit),
    close(){db.close()}};
}
async function listen(s:Server){
  await new Promise<void>((resolve,reject)=>{
    s.once('error',reject);
    s.listen(0,'127.0.0.1',()=>{s.off('error',reject);resolve()});
  });
  return (s.address() as AddressInfo).port;
}
async function close(s:Server){
  s.closeAllConnections();
  await new Promise<void>((resolve,reject)=>s.close(err=>err?reject(err):resolve()));
}

test('valid owner Ed25519 attestation derives deterministic opaque budget scope',()=>{
  const a=verify();
  assert.match(a.scopeId,/^tr_[a-f0-9]{64}$/);
  assert.equal(a.expiresAtMs,claims.expiresAtMs);
  assert.equal(verify().scopeId,a.scopeId);
  assert.doesNotMatch(JSON.stringify(a),/verified-tunnel|verified-calling-app/);
});
test('changed calling app, tunnel, fallback user or resource fails verification',()=>{
  for(const changes of [
    {callerId:'other-calling-app-001'},
    {tunnelId:'other-tunnel-001'},
    {callerKind:'user' as const},
    {publicResourceUrl:'https://evil.example.test/mcp'},
    {routeGeneration:999},
  ]){
    const attacker={route:{...route,claims:{...route.claims,...changes}}};
    assert.throws(()=>verify(attacker),/signature invalid|no longer authorized/);
  }
});
test('operator-signed app and fallback user yield separate provider budgets',()=>{
  const fallback=issueOperatorRouteAttestation({
    ...claims,callerKind:'user',callerId:'owner-user-001',
  },privateKey);
  const otherApp=issueOperatorRouteAttestation({
    ...claims,callerId:'verified-calling-app-002',
  },privateKey);
  assert.notEqual(verify({route:fallback}).scopeId,verify().scopeId);
  assert.notEqual(verify({route:otherApp}).scopeId,verify().scopeId);
});
test('wrong issuer/key ID, pinned public key or route URL never authorizes',()=>{
  const wrong=generateKeyPairSync('ed25519').publicKey
    .export({type:'spki',format:'pem'}).toString();
  for(const patch of [
    {expectedIssuer:'another-operator-001'},
    {expectedKeyId:'some-other-key-v2'},
    {operatorPublicKeyPem:wrong},
    {expectedPublicResourceUrl:'https://another.example.test/mcp'},
    {minimumRouteGeneration:6},
  ])assert.throws(()=>verify(patch));
});
test('expired, too-new, overlong, non-UTC safe clock and old generation fail closed',()=>{
  assert.throws(()=>verify({now:new Date(claims.expiresAtMs)}));
  assert.throws(()=>verify({now:new Date(claims.issuedAtMs-30001)}));
  assert.throws(()=>verify({now:new Date(NaN)}));
  assert.throws(()=>issueOperatorRouteAttestation({
    ...claims,expiresAtMs:claims.issuedAtMs+900001,
  },privateKey));
  assert.throws(()=>issueOperatorRouteAttestation({
    ...claims,routeGeneration:0,
  },privateKey));
});
test('unknown claim fields, misleading ID or unsupported curve rejected',()=>{
  assert.throws(()=>issueOperatorRouteAttestation({
    ...claims,overrideScope:'evil',
  } as TrustedSignedTransportClaims,privateKey),/schema/);
  assert.throws(()=>issueOperatorRouteAttestation({
    ...claims,callerId:'not a valid ID',
  },privateKey));
  const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
  assert.throws(()=>issueOperatorRouteAttestation(claims,
    rsa.privateKey.export({type:'pkcs8',format:'pem'}).toString()),/Ed25519/);
});
test('malformed signature and fake public key fail closed',()=>{
  assert.throws(()=>verify({route:{...route,signatureBase64url:'0'.repeat(86)}}));
  assert.throws(()=>verify({route:{...route,signatureBase64url:'!!evil!!'}}));
  assert.throws(()=>verify({operatorPublicKeyPem:'not a key'}));
});
test('runtime signed scope checks still refuse after expiry or generation revocation',()=>{
  const x=fakeMeter();try{
    let current=issuedAt;
    let minGeneration=5;
    const hook=createSignedStagingTransportBudget({
      route,operatorPublicKeyPem:publicKey,
      expectedIssuer:claims.issuer,expectedKeyId:claims.keyId,
      expectedPublicResourceUrl:expectedUrl,
      minimumRouteGeneration:()=>minGeneration,meter:x.meter,
      clock:()=>current,
    });
    assert.equal(hook.meter.observe(hook.trustedScope,current).allowed,true);
    minGeneration=6;
    // The trusted operator-side generation accessor is checked on EVERY
    // inbound arrival; stale generation cannot continue forwarding.
    assert.throws(()=>hook.meter.observe(hook.trustedScope,current),/no longer authorized/);
    minGeneration=5;
    current=new Date(claims.expiresAtMs);
    assert.throws(()=>hook.meter.observe(hook.trustedScope,current),/no longer authorized/);
    assert.equal(x.db.prepare(
      'SELECT observed AS n FROM proposed_ingress_transport_totals',
    ).get()!.n,1);
    assert.equal(minGeneration,5);
  }finally{x.close()}
});
test('forged per-request scope is rejected and does not allocate a new bucket',()=>{
  const x=fakeMeter();try{
    const hook=createSignedStagingTransportBudget({
      route,operatorPublicKeyPem:publicKey,
      expectedIssuer:claims.issuer,expectedKeyId:claims.keyId,
      expectedPublicResourceUrl:expectedUrl,
      minimumRouteGeneration:()=>5,meter:x.meter,clock:()=>issuedAt,
    });
    assert.throws(()=>hook.meter.observe('tr_fake-client-scope',issuedAt),/scope mismatch/);
    assert.equal(hook.meter.observe(hook.trustedScope,issuedAt).allowed,true);
    assert.equal(hook.meter.observe(hook.trustedScope,issuedAt).allowed,false);
    assert.equal(x.db.prepare(
      'SELECT COUNT(*) AS n FROM proposed_ingress_transport_totals',
    ).get()!.n,1);
  }finally{x.close()}
});
test('renewed signed assertion for same tunnel+calling app retains one budget',()=>{
  const x=fakeMeter(1);try{
    const newer=issueOperatorRouteAttestation({
      ...claims,routeGeneration:6,
      issuedAtMs:claims.issuedAtMs+1000,
      expiresAtMs:claims.expiresAtMs+1000,
    },privateKey);
    const same=verify().scopeId;
    const other=verify({
      route:newer,minimumRouteGeneration:6,
      now:new Date(claims.issuedAtMs+1000),
    }).scopeId;
    assert.equal(same,other);
    assert.equal(x.meter.observe(same,issuedAt).allowed,true);
    assert.equal(x.meter.observe(other,new Date(claims.issuedAtMs+1000)).allowed,false);
  }finally{x.close()}
});
test('public verifier key cannot act as operator signing private key',()=>{
  assert.throws(()=>issueOperatorRouteAttestation(claims,publicKey));
});
test('full mock ingress rejects when signed route expires, no Hub forwarding',async()=>{
  const x=fakeMeter(3);
  let current=issuedAt;
  const hook=createSignedStagingTransportBudget({
    route,operatorPublicKeyPem:publicKey,
    expectedIssuer:claims.issuer,expectedKeyId:claims.keyId,
    expectedPublicResourceUrl:expectedUrl,
    minimumRouteGeneration:()=>5,meter:x.meter,clock:()=>current,
  });
  let arrivals=0;
  const hub=createServer((_req,res)=>{arrivals++;res.end('ok')});
  const hubPort=await listen(hub);
  const proxy=createLocalFirstIngressServer({
    hubPort,listenPort:43111,stagingTransportBudget:hook,
  });
  const port=await listen(proxy);
  const uri='http://127.0.0.1:'+port+'/mcp';
  try{
    const before=await fetch(uri,{method:'POST',
      headers:{authorization:'Bearer this-is-a-long-test-token'},body:'{}'});
    assert.equal(before.status,200);
    current=new Date(claims.expiresAtMs);
    const after=await fetch(uri,{method:'POST',
      headers:{authorization:'Bearer this-is-a-long-test-token'},body:'{}'});
    assert.equal(after.status,503);
    assert.equal(arrivals,1);
  }finally{await close(proxy);await close(hub);x.close()}
});
