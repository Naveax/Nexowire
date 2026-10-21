import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign,type KeyObject} from 'node:crypto';
import {createServer} from 'node:https';
import * as tls from 'node:tls';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import {HttpsBrokerDispatchAuthority}
 from '../src/agent/https-broker-dispatch-authority.js';
import {BrokerExternalDispatchFence}
 from '../src/agent/broker-external-dispatch-fence.js';
import {isolatedRemoteCas} from './fixtures/agent-remote-cas-fixture.js';

function signed(value:unknown,key:KeyObject){
 const bytes=Buffer.from(JSON.stringify(value));
 return {payload:bytes.toString('base64url'),
  signature:sign(null,bytes,key).toString('base64url')};
}
test('real isolated TLS dispatch begin/release/revoke, rejects forged receipts',async t=>{
 const dir=await mkdtemp(path.join(process.cwd(),'test','nx-587-tls-broker-'));
 const ca=await isolatedRemoteCas(dir);
 const prior=tls.getCACertificates('default');
 tls.setDefaultCACertificates([...prior,await readFile(ca.certificate,'utf8')]);
 const signer=generateKeyPairSync('ed25519');
 const impostor=generateKeyPairSync('ed25519');
 const authorityId=ca.authorityId,brokerId=randomUUID();
 const ownerId=randomUUID(),sessionEpoch=randomUUID(),deviceEpoch=ca.epoch;
 let generation=5,revoked=false,forged=false,released=0;
 const server=createServer({
  key:await readFile(path.join(ca.root,'cas.key')),
  cert:await readFile(ca.certificate),
 },(req,res)=>{
  void(async()=>{
   let source='';
   for await(const part of req)source+=String(part);
   const payload=JSON.parse(source);
   const respond=(data:unknown,status=200)=>{
    res.writeHead(status,{'content-type':'application/json','connection':'close'});
    res.end(JSON.stringify(data));
   };
   if(req.headers.authorization!=='Bearer '+ca.settings.token){
    respond({error:'not authorized'},401);return;
   }
   if(req.url==='/v1/broker-dispatch/begin'){
    const op=payload.request,scope=op.scope;
    if(revoked||scope.expectedGeneration!==generation){
      respond({error:'grant revoked'},409);return;
    }
    const now=Date.now();
    respond(signed({kind:'broker_dispatch_permit_v1',
      authorityId,brokerId,dispatchId:randomUUID(),
      requestId:op.requestId,fingerprint:op.fingerprint,
      capability:op.capability,ownerId:scope.ownerId,
      deviceId:scope.deviceId,deviceEpoch:scope.deviceEpoch,
      sessionEpoch:scope.sessionEpoch,generation:scope.expectedGeneration,
      privilege:scope.requiredPrivilege,issuedAtMs:now,
      expiresAtMs:now+1500},forged?impostor.privateKey:signer.privateKey));
    return;
   }
   if(req.url==='/v1/broker-dispatch/release'){
    released++;res.writeHead(204);res.end();return;
   }
   if(req.url==='/v1/broker-dispatch/revoke-and-drain'){
    if(revoked||payload.expectedGeneration!==generation){
      respond({error:'stale'},409);return;
    }
    revoked=true;const before=generation++;
    respond(signed({kind:'broker_dispatch_revocation_v1',authorityId,
      deviceId:payload.deviceId,ownerId:payload.ownerId,
      deviceEpoch:payload.deviceEpoch,sessionEpoch:payload.sessionEpoch,
      previousGeneration:before,generation,revoked:true,drained:true},
      signer.privateKey));
    return;
   }
   respond({error:'route'},404);
  })().catch(()=>{
    if(!res.headersSent){res.writeHead(503);res.end()}
  });
 });
 await new Promise<void>(resolve=>server.listen(0,'localhost',resolve));
 t.after(async()=>{
  server.closeAllConnections();
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  tls.setDefaultCACertificates(prior);
  await ca.stop();
  await rm(dir,{recursive:true,force:true,maxRetries:4,retryDelay:75});
 });
 const port=(server.address() as {port:number}).port;
 const remote=new HttpsBrokerDispatchAuthority({
  endpoint:'https://localhost:'+port+'/v1/broker-dispatch',
  brokerCredential:async()=>ca.settings.token,
 });
 const fence=new BrokerExternalDispatchFence({
  authority:remote,authorityId,
  publicKeyPem:signer.publicKey.export({type:'spki',format:'pem'}).toString(),
  verifyIdentity:async()=>true,
  verifyEffectiveBroker:async()=>({verified:true,brokerId,
    highIntegrityToken:true,signedProtectedImage:true,
    protectedParentAndImports:true}),
  verifyOwnerRevocation:async()=>true,
 });
 const request=()=>({requestId:randomUUID(),fingerprint:'b'.repeat(64),
  capability:'shell.exec',scope:{ownerId,deviceId:ca.deviceId,
    deviceEpoch,sessionEpoch,expectedGeneration:5,
    requiredPrivilege:'CORE' as const}});
 assert.equal(await fence.execute(request(),async()=>42),42);
 assert.equal(released,1);
 forged=true;
 await assert.rejects(fence.execute(request(),async()=>false),
  {code:'DISPATCH_SIGNATURE_UNTRUSTED'});
 // Invalid remote proof fences this Broker instance until reviewed.
 await assert.rejects(fence.execute(request(),async()=>false),
  {code:'DISPATCH_REVOKE_PENDING'});
 const fresh=new BrokerExternalDispatchFence({
  authority:remote,authorityId,
  publicKeyPem:signer.publicKey.export({type:'spki',format:'pem'}).toString(),
  verifyIdentity:async()=>true,
  verifyEffectiveBroker:async()=>({verified:true,brokerId,
    highIntegrityToken:true,signedProtectedImage:true,
    protectedParentAndImports:true}),
  verifyOwnerRevocation:async()=>true,
 });
 forged=false;
 assert.equal((await fresh.revoke({deviceId:ca.deviceId,ownerId,
  deviceEpoch,sessionEpoch,expectedGeneration:5,
  signedOwnerApproval:'SIGNED_EXTERNAL_OWNER_REVOKE'.repeat(2)})).revoked,true);
 await assert.rejects(fresh.execute(request(),async()=>false),
  {code:'DISPATCH_REVOKE_PENDING'});
});
test('HTTPS transport rejects downgrade and malformed endpoints',()=>{
 for(const endpoint of [
  'http://localhost/v1/broker-dispatch',
  'https://attacker:secret@example.com/v1/broker-dispatch',
  'https://example.com/v1/broker-dispatch?x=1',
 ]){
  assert.throws(()=>new HttpsBrokerDispatchAuthority({
   endpoint,brokerCredential:async()=>undefined,
  }),{code:'BROKER_DISPATCH_ENDPOINT_INVALID'});
 }
});
