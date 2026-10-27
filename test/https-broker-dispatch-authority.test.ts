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
test('isolated TLS dispatch rejects lost begin ACK replay and forged receipts',async t=>{
 const dir=await mkdtemp(path.join(process.cwd(),'test','nx-587-tls-broker-'));
 const ca=await isolatedRemoteCas(dir);
 const prior=tls.getCACertificates('default');
 tls.setDefaultCACertificates([...prior,await readFile(ca.certificate,'utf8')]);
 const signer=generateKeyPairSync('ed25519');
 const impostor=generateKeyPairSync('ed25519');
 const authorityId=ca.authorityId,brokerId=randomUUID();
 const ownerId=randomUUID(),sessionEpoch=randomUUID(),deviceEpoch=ca.epoch;
 let generation=5,revoked=false,forged=false,released=0,lostBeginAck=false;
 let beginCalls=0;
 const beginChallenges:string[]=[];
 const requestTombstones=new Map<string,{request:string;brokerId:string;dispatchId:string}>();
 let claims=new Map<string,{request:Record<string,unknown>;brokerId:string;committed:boolean}>();
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
    beginCalls++;beginChallenges.push(payload.challengeNonce);
    const prior=requestTombstones.get(op.requestId);
    if(prior){
     const same=prior.request===JSON.stringify(op)&&
      prior.brokerId===brokerId;
     respond({error:same?'request outcome unknown; reconcile':
      'request UUID scope collision'},409);return;
    }
    if(revoked||scope.expectedGeneration!==generation||scope.ownerEpoch!==4){
      respond({error:'grant revoked'},409);return;
    }
    const now=Date.now();
    const dispatchId=randomUUID();
    claims.set(dispatchId,{request:op,brokerId,committed:false});
    requestTombstones.set(op.requestId,{request:JSON.stringify(op),
      brokerId,dispatchId});
    if(lostBeginAck){
     lostBeginAck=false;res.socket?.destroy();return;
    }
    respond(signed({kind:'broker_dispatch_permit_v1',
      authorityId,brokerId,dispatchId,
      challengeNonce:payload.challengeNonce,
      requestId:op.requestId,fingerprint:op.fingerprint,
      capability:op.capability,ownerId:scope.ownerId,
      deviceId:scope.deviceId,deviceEpoch:scope.deviceEpoch,
      sessionEpoch:scope.sessionEpoch,ownerEpoch:scope.ownerEpoch,
      generation:scope.expectedGeneration,
      privilege:scope.requiredPrivilege,issuedAtMs:now,
      expiresAtMs:now+1500},forged?impostor.privateKey:signer.privateKey));
    return;
   }
   if(req.url==='/v1/broker-dispatch/commit'){
    const op=payload.request,scope=op.scope;
    const entry=claims.get(payload.dispatchId);
    if(revoked||scope.expectedGeneration!==generation||scope.ownerEpoch!==4||
       !entry||entry.committed||entry.brokerId!==payload.broker?.brokerId||
       JSON.stringify(entry.request)!==JSON.stringify(op)){
      respond({error:'dispatch not reserved'},409);return;
    }
    entry.committed=true;
    const now=Date.now();
    respond(signed({kind:'broker_dispatch_commit_v1',
      authorityId,brokerId,dispatchId:payload.dispatchId,
      challengeNonce:payload.challengeNonce,requestId:op.requestId,
      fingerprint:op.fingerprint,capability:op.capability,
      ownerId:scope.ownerId,deviceId:scope.deviceId,
      deviceEpoch:scope.deviceEpoch,sessionEpoch:scope.sessionEpoch,
      ownerEpoch:scope.ownerEpoch,generation:scope.expectedGeneration,
      privilege:scope.requiredPrivilege,issuedAtMs:now,expiresAtMs:now+1500},
      signer.privateKey));
    return;
   }
   if(req.url==='/v1/broker-dispatch/release'){
    const prior=claims.get(payload.dispatchId);
    if(!prior||prior.brokerId!==payload.brokerId||
       JSON.stringify(prior.request)!==JSON.stringify(payload.request)){
      respond({error:'release scope mismatch'},409);return;
    }
    released++;claims.delete(payload.dispatchId);
    res.writeHead(204);res.end();return;
   }
   if(req.url==='/v1/broker-dispatch/revoke-and-drain'){
    if(revoked||payload.expectedGeneration!==generation||
       [...claims.values()].some(x=>x.committed)){
      respond({error:'stale or active dispatch'},409);return;
    }
    revoked=true;claims.clear();const before=generation++;
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
    ownerEpoch:4,grantGeneration:5,
    highIntegrityToken:true,signedProtectedImage:true,
    protectedParentAndImports:true}),
  verifyOwnerRevocation:async()=>true,
 });
 const request=()=>({requestId:randomUUID(),fingerprint:'b'.repeat(64),
  capability:'shell.exec',scope:{ownerId,deviceId:ca.deviceId,
    deviceEpoch,sessionEpoch,ownerEpoch:4,expectedGeneration:5,
    requiredPrivilege:'CORE' as const}});
 // Independently test the actual TLS request body. The disposable server is
 // a negative contract fixture, NOT an attested monotonic CAS provider.
 const op=request();
 const brokerProof={
  verified:true as const,brokerId,ownerEpoch:4,grantGeneration:5,
  highIntegrityToken:true as const,signedProtectedImage:true as const,
  protectedParentAndImports:true as const,
 };
 const reservation=await remote.beginIfCurrent(op,brokerProof,'0'.repeat(64));
 const dispatchId=(JSON.parse(Buffer.from(reservation.payload,'base64url')
  .toString('utf8')) as {dispatchId:string}).dispatchId;
 for(const wrong of [
  {...op,scope:{...op.scope,ownerId:randomUUID()}},
  {...op,scope:{...op.scope,sessionEpoch:randomUUID()}},
  {...op,scope:{...op.scope,expectedGeneration:6}},
 ]){
  await assert.rejects(remote.release({dispatchId,brokerId,request:wrong}),
   {code:'BROKER_DISPATCH_REMOTE_REFUSED'});
  assert.equal(claims.has(dispatchId),true);
 }
 await assert.rejects(remote.release({
  dispatchId,brokerId:randomUUID(),request:op,
 }),{code:'BROKER_DISPATCH_REMOTE_REFUSED'});
 assert.equal(claims.has(dispatchId),true);
 await remote.release({dispatchId,brokerId,request:op});
 assert.equal(claims.has(dispatchId),false);
 assert.equal(released,1);
 assert.equal(await fence.execute(request(),async()=>42),42);
 assert.equal(released,2);
 const makeFence=()=>new BrokerExternalDispatchFence({
  authority:remote,authorityId,
  publicKeyPem:signer.publicKey.export({type:'spki',format:'pem'}).toString(),
  verifyIdentity:async()=>true,
  verifyEffectiveBroker:async()=>({verified:true,brokerId,
    ownerEpoch:4,grantGeneration:5,
    highIntegrityToken:true,signedProtectedImage:true,
    protectedParentAndImports:true}),
  verifyOwnerRevocation:async()=>true,
 });
 const uncertain=request(),hubA=makeFence(),hubB=makeFence();
 const priorCalls=beginCalls,priorTombstones=requestTombstones.size,
  priorClaims=claims.size;
 let effects=0;
 lostBeginAck=true;
 await assert.rejects(hubA.execute(uncertain,async()=>++effects),
  {code:'DISPATCH_EXTERNAL_CAS_UNKNOWN'});
 assert.equal(effects,0,'lost HTTPS begin ACK must not invoke callback');
 assert.equal(beginCalls,priorCalls+1,
  'client sends one begin request; it has no hidden transport retry');
 assert.equal(requestTombstones.size,priorTombstones+1,
  'synthetic authority tombstone persists before ACK loss');
 assert.equal(claims.size,priorClaims+1,
  'synthetic reservation persists before ACK loss');
 await assert.rejects(hubB.execute(uncertain,async()=>++effects),
  {code:'DISPATCH_EXTERNAL_CAS_UNKNOWN'});
 assert.equal(beginCalls,priorCalls+2,'only the explicit Hub B attempt is sent');
 assert.notEqual(beginChallenges[priorCalls],beginChallenges[priorCalls+1],
  'Hub B uses a fresh challenge nonce');
 assert.equal(requestTombstones.size,priorTombstones+1,
  'duplicate request UUID cannot create another tombstone');
 assert.equal(claims.size,priorClaims+1,
  'duplicate request UUID cannot mint another dispatch');
 assert.equal(effects,0,'lost ACK never authorizes replay');
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
    ownerEpoch:4,grantGeneration:5,
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
