import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,X509Certificate} from 'node:crypto';
import {Agent as HttpsAgent} from 'node:https';
import type {PeerCertificate} from 'node:tls';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {
  validateOwnerPublicWssTrustProfile,ownerPublicWssPeerVerifier,
  createOwnerPublicWssClientOptions,type OwnerPublicWssTrustProfile,
} from '../src/product/owner-public-wss-trust-proposal.js';

const endpoint='wss://edge.example.com/internal/owner-quota/v1/outbound';
const profile:OwnerPublicWssTrustProfile={
  endpoint,expectedHostname:'edge.example.com',
  trustedSpkiSha256:['a'.repeat(64)],caMode:'system',
};
test('exact operator WSS hostname and path accepted, TLS1.3 options require authenticated chain',()=>{
  const validated=validateOwnerPublicWssTrustProfile(profile);
  assert.equal(validated.endpoint,endpoint);
  const opts=createOwnerPublicWssClientOptions(profile);
  try{
    const agent=opts.agent as HttpsAgent;
    assert.equal(opts.followRedirects,false);
    assert.equal(opts.rejectUnauthorized,true);
    assert.equal(agent.options.rejectUnauthorized,true);
    assert.equal(agent.options.minVersion,'TLSv1.3');
    assert.equal(agent.options.maxVersion,'TLSv1.3');
    assert.equal(opts.perMessageDeflate,false);
  }finally{(opts.agent as HttpsAgent).destroy()}
});
test('network URL cannot downgrade to ws/http, substitute host, port, IP, /agent, metadata',()=>{
  const bad=[
    'ws://edge.example.com/internal/owner-quota/v1/outbound',
    'https://edge.example.com/internal/owner-quota/v1/outbound',
    'wss://evil.example.com/internal/owner-quota/v1/outbound',
    'wss://127.0.0.1/internal/owner-quota/v1/outbound',
    'wss://100.116.23.60/internal/owner-quota/v1/outbound',
    'wss://edge.example.com:444/internal/owner-quota/v1/outbound',
    'wss://edge.example.com/agent',
    'wss://edge.example.com/internal/owner-quota/v1/outbound/',
    'wss://edge.example.com/internal/owner-quota/v1/outbound?a=1',
    'wss://edge.example.com/internal/owner-quota/v1/outbound#x',
    'wss://admin:pass@edge.example.com/internal/owner-quota/v1/outbound',
    'WSS://edge.example.com/internal/owner-quota/v1/outbound',
    'wss://edge.example.com:443/internal/owner-quota/v1/outbound',
    'wss://edge.example.com/../internal/owner-quota/v1/outbound',
  ];
  for(const url of bad)assert.throws(
    ()=>validateOwnerPublicWssTrustProfile({...profile,endpoint:url}),url);
});
test('private domains, local hostnames, IP literals and wildcards cannot be approved as public WSS',()=>{
  for(const host of [
    'localhost','internal.local','pc.home','owner.lan',
    'pc.internal','dev.test','x.invalid','10.1.1.3',
    '*.example.com','edge.example.com.','-bad.example.com',
  ])assert.throws(()=>validateOwnerPublicWssTrustProfile({
    ...profile,endpoint:'wss://'+host+'/internal/owner-quota/v1/outbound',
    expectedHostname:host,
  }),host);
});
test('trust profile refuses caller-injected policy keys, implicit CA and missing pins',()=>{
  for(const bad of [
    {...profile,caMode:'unsafe'},
    {...profile,caMode:'system',trustedCaPem:'FAKE'},
    {...profile,caMode:'custom'},
    {...profile,caMode:'custom',trustedCaPem:'junk'},
    {...profile,trustedSpkiSha256:[]},
    {...profile,trustedSpkiSha256:['a'.repeat(64),'a'.repeat(64)]},
    {...profile,trustedSpkiSha256:['a'.repeat(64),'b'.repeat(64),'c'.repeat(64)]},
    {...profile,trustedSpkiSha256:['not-a-real-pin']},
    {...profile,expectedHostname:'different.example.com'},
    {...profile,allowInsecureTls:true},
  ])assert.throws(()=>validateOwnerPublicWssTrustProfile(
    bad as OwnerPublicWssTrustProfile));
});
function openssl(){
  for(const bin of ['openssl','C:\\Program Files\\Git\\usr\\bin\\openssl.exe']){
    try{execFileSync(bin,['version'],{timeout:8000,stdio:'ignore'});return bin}catch{}
  }
  return null;
}
const opensslBinary=openssl();
function tempCert(san='DNS:edge.example.com'){
  if(!opensslBinary)throw new Error('OpenSSL not available');
  const dir=mkdtempSync(path.join(tmpdir(),'nx-public-identity-'));
  const pem=path.join(dir,'cert.pem'),key=path.join(dir,'key.pem');
  try{
    execFileSync(opensslBinary,[
      'req','-x509','-newkey','rsa:2048','-sha256','-nodes',
      '-out',pem,'-keyout',key,'-days','1',
      '-subj','/CN=operator-staging',
      '-addext','subjectAltName='+san,
      '-addext','basicConstraints=critical,CA:TRUE',
    ],{timeout:20000,stdio:'ignore'});
    const content=readFileSync(pem,'utf8');
    const certificate=new X509Certificate(content);
    const spki=certificate.publicKey.export({format:'der',type:'spki'});
    const digest=createHash('sha256').update(spki).digest('hex');
    const peer={
      ...(certificate.toLegacyObject() as unknown as Record<string,unknown>),
      raw:certificate.raw,
    } as PeerCertificate;
    return {dir,content,certificate,digest,peer,
      cleanup:()=>rmSync(dir,{recursive:true,force:true})};
  }catch(e){rmSync(dir,{recursive:true,force:true});throw e}
}
test('correct genuine certificate IP/host SAN and pinned SPKI accepted, two rotation pins supported',
  {skip:!opensslBinary},()=>{
  const cert=tempCert();
  try{
    const trust=validateOwnerPublicWssTrustProfile({
      ...profile,trustedSpkiSha256:['0'.repeat(64),cert.digest],
    });
    const check=ownerPublicWssPeerVerifier(trust);
    assert.equal(check('edge.example.com',cert.peer),undefined);
    const opts=createOwnerPublicWssClientOptions({
      ...profile,caMode:'custom',trustedCaPem:cert.content,
      trustedSpkiSha256:[cert.digest],
    });
    try{
      const agent=opts.agent as HttpsAgent;
      assert.equal(agent.options.ca,cert.content);
      assert.equal(agent.options.rejectUnauthorized,true);
    }finally{(opts.agent as HttpsAgent).destroy()}
  }finally{cert.cleanup()}
});
test('wrong operator SPKI, TLS host and valid wrong-SAN certificate are rejected',
  {skip:!opensslBinary},()=>{
  const right=tempCert(),wrong=tempCert('DNS:elsewhere.example.com');
  try{
    const check=ownerPublicWssPeerVerifier(validateOwnerPublicWssTrustProfile({
      ...profile,trustedSpkiSha256:[right.digest],
    }));
    assert.match(check('edge.example.com',wrong.peer)?.message??'',/Hostname|IP|cert/i);
    assert.match(check('elsewhere.example.com',right.peer)?.message??'',/hostname/i);
    const wrongPin=ownerPublicWssPeerVerifier(validateOwnerPublicWssTrustProfile(profile));
    assert.match(wrongPin('edge.example.com',right.peer)?.message??'',/SPKI pin mismatch/);
    assert.match(wrongPin('edge.example.com',{...right.peer,raw:undefined} as unknown as PeerCertificate)?.message??'',/Missing/);
  }finally{right.cleanup();wrong.cleanup()}
});
