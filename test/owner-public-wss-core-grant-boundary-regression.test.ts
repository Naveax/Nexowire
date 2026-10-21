import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign,X509Certificate} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {PeerCertificate} from 'node:tls';
import type {Agent as HttpsAgent} from 'node:https';
import {MemoryControlPlaneStore} from '../src/product/memory-control-plane-store.js';
import {ControlPlaneService} from '../src/product/control-plane-service.js';
import {createControlPlaneHttpHandler} from '../src/product/control-plane-http.js';
import {
  ProposedOwnerPublicWssEnrollmentLease,
} from '../src/product/owner-public-wss-enrollment-lease-proposal.js';
import {
  serializeOwnerPublicWssEnrollment,
  verifySignedOwnerPublicWssEnrollment,
  type SignedOwnerPublicWssEnrollment,
  type TrustedOwnerPublicWssEnrollmentContext,
} from '../src/product/owner-public-wss-operator-enrollment-proposal.js';
import {
  createOwnerPublicWssClientOptions,ownerPublicWssPeerVerifier,
  validateOwnerPublicWssTrustProfile,
  type OwnerPublicWssTrustProfile,
} from '../src/product/owner-public-wss-trust-proposal.js';

const instant=Date.parse('2026-10-21T12:00:00Z');
const ownerId='security-owner-qa-01';
const operator=generateKeyPairSync('ed25519');
const otherOperator=generateKeyPairSync('ed25519');
const publicPem=(key:typeof operator.publicKey)=>key.export({
  type:'spki',format:'pem',
}).toString();
const pathWss='/internal/owner-quota/v1/outbound';
const defaultProfile:OwnerPublicWssTrustProfile={
  endpoint:'wss://edge.example.com'+pathWss,
  expectedHostname:'edge.example.com',
  trustedSpkiSha256:['a'.repeat(64)],caMode:'system',
};
function state(deviceId:string):TrustedOwnerPublicWssEnrollmentContext{
  return {
    operatorId:'operator-key-owner-qa',keyId:'operator-root-v1',
    operatorPublicKeyPem:publicPem(operator.publicKey),
    accountId:ownerId,deviceId,activeSessionGeneration:5,
    minimumProfileRevision:2,nowMs:instant,
  };
}
function enrollment(
  deviceId:string,profile=defaultProfile,
):SignedOwnerPublicWssEnrollment{
  const e:SignedOwnerPublicWssEnrollment={
    version:1,operatorId:'operator-key-owner-qa',keyId:'operator-root-v1',
    accountId:ownerId,deviceId,sessionGeneration:5,profileRevision:2,
    issuedAtMs:instant-1000,expiresAtMs:instant+60_000,
    profile,signature:'',
  };
  e.signature=sign(null,serializeOwnerPublicWssEnrollment(e),
    operator.privateKey).toString('base64url');
  return e;
}
async function ownerDevice(){
  const store=new MemoryControlPlaneStore();
  const service=new ControlPlaneService(store,{now:()=>new Date(instant)});
  const identity={accountId:ownerId,role:'user' as const};
  await service.ensureAccount({id:identity.accountId});
  await service.ensureAccount({id:'other-owner-qa-01'});
  const challenge=await service.beginPairing(identity,'synthetic-test-device');
  const {device,deviceCredential}=await service.consumePairing({
    pairingId:challenge.pairingId,token:challenge.token,
    platform:'win32',deviceAnchorHash:'1'.repeat(64),
  });
  return {service,store,identity,challenge,device,deviceCredential};
}

test('signed owner WSS receipt + paired device token cannot spoof CORE HTTP session or Windows elevation',async()=>{
  const {service,identity,challenge,device,deviceCredential}=await ownerDevice();
  await service.setDeviceAccessMode(identity,device.id,'full');
  await service.setDevicePresence(device.id,true,new Date(instant).toISOString(),{
    privilegeMode:'broker',adminBridgeReady:true,
  });
  const receipt=enrollment(device.id);
  assert.equal(verifySignedOwnerPublicWssEnrollment(receipt,state(device.id))
    .expectedHostname,'edge.example.com');
  const handler=createControlPlaneHttpHandler(service,{
    // Independent synthetic bearer authority. Claims in headers/body are
    // NEVER an identity source. An on-wire signed receipt is NOT a login.
    authenticate:async request=>{
      switch(request.headers.get('authorization')){
        case 'Bearer qa-owner-session':return identity;
        case 'Bearer qa-agent-service':return {accountId:ownerId,role:'service'};
        case 'Bearer qa-other-owner':return {accountId:'other-owner-qa-01',role:'user'};
        default:return null;
      }
    },
  });
  const route='https://control.example.com/api/v1/me/devices/core-preference';
  const request=(token:string)=>new Request(route,{
    method:'POST',
    headers:{
      'content-type':'application/json','authorization':'Bearer '+token,
      'x-nexowire-confirm':'core-preference-v1',
      'x-claimed-owner-account':ownerId,
    },
    body:JSON.stringify({
      deviceId:device.id,enabled:true,confirmation:'CORE UNLIMITED',
      // An attacker-controlled UI flag or signed WSS response is not
      // evidence of a privileged access token.
      active:true,privilegeMode:'broker',signedWssReceipt:receipt,
    }),
  });
  for(const token of [
    challenge.token,deviceCredential,receipt.signature,'forged-owner-session',
  ]){
    assert.equal((await handler(request(token))).status,401);
  }
  assert.equal((await handler(request('qa-agent-service'))).status,403);
  assert.equal((await handler(request('qa-other-owner'))).status,404);
  const granted=await handler(request('qa-owner-session'));
  assert.equal(granted.status,200);
  const data=await granted.json() as {
    persistentMaintenance:{enabled:boolean;active:boolean};
  };
  assert.equal(data.persistentMaintenance.enabled,true);
  assert.equal(data.persistentMaintenance.active,false);
  const replayed=await handler(request('qa-owner-session'));
  assert.equal(replayed.status,200);
  assert.equal((await replayed.json() as {
    persistentMaintenance:{active:boolean}
  }).persistentMaintenance.active,false);
  // A persisted CORE UI request cannot become an elevated Windows token.
  assert.equal((await service.dashboard(identity)).devices[0]
    ?.persistentMaintenance.active,false);
  await service.setDeviceAccessMode(identity,device.id,'safe');
  const dashboard=await service.dashboard(identity);
  assert.equal(dashboard.devices[0]?.persistentMaintenance.enabled,false);
  assert.equal(dashboard.devices[0]?.persistentMaintenance.active,false);
});

test('pairing token replay or a copied signed WSS enrollment does not transfer owner/device authority',async()=>{
  const {service,identity,challenge,device}=await ownerDevice();
  await assert.rejects(service.consumePairing({
    pairingId:challenge.pairingId,token:challenge.token,
    platform:'win32',deviceAnchorHash:'1'.repeat(64),
  }),/PAIRING_ALREADY-CONSUMED|already-consumed|PAIRING_ALREADY_CONSUMED/i);
  const trusted=state(device.id);
  const signed=enrollment(device.id);
  assert.equal(verifySignedOwnerPublicWssEnrollment(signed,trusted)
    .endpoint,defaultProfile.endpoint);
  for(const untrusted of [
    {...trusted,accountId:'other-owner-qa-01'},
    {...trusted,deviceId:'different-device-01'},
    {...trusted,operatorPublicKeyPem:publicPem(otherOperator.publicKey)},
    {...trusted,activeSessionGeneration:6},
    {...trusted,minimumProfileRevision:3},
    {...trusted,nowMs:instant+120_000},
  ]){
    assert.throws(()=>verifySignedOwnerPublicWssEnrollment(signed,untrusted));
  }
  // None of the above WSS verifications modify the device's owner account
  // or create a CORE policy or OS grant.
  assert.equal((await service.dashboard(identity)).devices[0]
    ?.persistentMaintenance.enabled,false);
});

test('replayed enrollment stays invalid after independent owner revoke/key rotation, even after state restore',async()=>{
  const deviceId='device-enrollment-qa-01';
  const e=enrollment(deviceId);
  let current=state(deviceId);
  const lease=await ProposedOwnerPublicWssEnrollmentLease.establish(
    e,async()=>current,
  );
  await lease.requireCurrent();
  current={...current,operatorPublicKeyPem:publicPem(otherOperator.publicKey)};
  await assert.rejects(lease.requireCurrent(),/revoked|unavailable/);
  current=state(deviceId);
  await assert.rejects(lease.requireCurrent(),/invalidated/);
  const again=await ProposedOwnerPublicWssEnrollmentLease.establish(
    e,async()=>current,
  );
  current={...current,activeSessionGeneration:6};
  await assert.rejects(again.requireCurrent(),/revoked|unavailable/);
  current=state(deviceId);
  await assert.rejects(again.requireCurrent(),/invalidated/);
});

const opensslBinary=(()=>{
  for(const binary of ['openssl','C:/Program Files/Git/usr/bin/openssl.exe']){
    try{
      execFileSync(binary,['version'],{timeout:8000,stdio:'ignore'});
      return binary;
    }catch{}
  }
  return null;
})();
function syntheticCertificate(host:string){
  const temp=mkdtempSync(path.join(tmpdir(),'nexowire-wss-core-tls-'));
  const certFile=path.join(temp,'certificate.pem');
  const keyFile=path.join(temp,'key.pem');
  try{
    execFileSync(opensslBinary!,[
      'req','-x509','-newkey','rsa:2048','-sha256','-nodes',
      '-keyout',keyFile,'-out',certFile,'-days','1',
      '-subj','/CN=nexowire-test',
      '-addext','subjectAltName=DNS:'+host,
      '-addext','basicConstraints=critical,CA:TRUE',
    ],{stdio:'ignore',timeout:20000});
    const cert=new X509Certificate(readFileSync(certFile));
    const spki=cert.publicKey.export({format:'der',type:'spki'});
    const pin=createHash('sha256').update(spki).digest('hex');
    const peer={
      ...(cert.toLegacyObject() as unknown as Record<string,unknown>),
      raw:cert.raw,
    } as PeerCertificate;
    return {pin,peer,cleanup:()=>rmSync(temp,{recursive:true,force:true})};
  }catch(e){
    rmSync(temp,{recursive:true,force:true});
    throw e;
  }
}

test('synthetic TLS hostname/SPKI rotation is bound to signed WSS profile, never CORE approval',
  {timeout:25000,skip:!opensslBinary},()=>{
    const oldCert=syntheticCertificate('edge.example.com');
    const nextCert=syntheticCertificate('edge.example.com');
    const wrongHost=syntheticCertificate('elsewhere.example.com');
    const deviceId='device-enrollment-qa-01';
    try{
      const profile:OwnerPublicWssTrustProfile={
        ...defaultProfile,trustedSpkiSha256:[oldCert.pin,nextCert.pin],
      };
      const signed=enrollment(deviceId,profile);
      const verified=verifySignedOwnerPublicWssEnrollment(signed,state(deviceId));
      const checker=ownerPublicWssPeerVerifier(
        validateOwnerPublicWssTrustProfile(verified),
      );
      assert.equal(checker('edge.example.com',oldCert.peer),undefined);
      assert.equal(checker('edge.example.com',nextCert.peer),undefined);
      assert.match(checker('edge.example.com',wrongHost.peer)?.message??'',
        /Hostname|IP|cert/i);
      assert.match(checker('mismatch.example.com',nextCert.peer)?.message??'',
        /hostname/i);
      const downgraded={...signed,profile:{
        ...signed.profile,trustedSpkiSha256:[nextCert.pin],
      }};
      assert.throws(
        ()=>verifySignedOwnerPublicWssEnrollment(downgraded,state(deviceId)),
        /signature/,
      );
      const opts=createOwnerPublicWssClientOptions(verified);
      try{
        assert.equal(opts.rejectUnauthorized,true);
        assert.equal(opts.followRedirects,false);
        assert.equal(opts.perMessageDeflate,false);
        const agent=opts.agent as HttpsAgent;
        assert.equal(agent.options.minVersion,'TLSv1.3');
        assert.equal(agent.options.rejectUnauthorized,true);
      }finally{(opts.agent as HttpsAgent).destroy()}
    }finally{
      oldCert.cleanup();nextCert.cleanup();wrongHost.cleanup();
    }
  });
