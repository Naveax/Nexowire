import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer as httpsServer} from 'node:https';
import * as tls from 'node:tls';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {HttpsExternalGrantCas}
 from '../src/agent/https-external-grant-cas.js';
import {isolatedRemoteCas} from './fixtures/agent-remote-cas-fixture.js';

const fp='e'.repeat(64);
test('actual isolated TLS adapter validates reserve and revoke receipts, and denies forgery',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'nw-bound-cas-tls-'));
 const fixture=await isolatedRemoteCas(root);
 const before=tls.getCACertificates('default');
 tls.setDefaultCACertificates([...before,await readFile(fixture.certificate,'utf8')]);
 const fakeDb=new Map<string,{sequence:number;created:boolean}>();
 let epoch=3,revoked=false,wrongProof=false;
 let replayReserve=false,replayRevoke=false,replayRepair=false;
 let savedReserve:Record<string,unknown>|undefined;
 let savedRevoke:Record<string,unknown>|undefined;
 let savedRepair:Record<string,unknown>|undefined;
 const reserveChallenges:string[]=[],revokeChallenges:string[]=[],repairChallenges:string[]=[];
 const server=httpsServer({
  key:await readFile(path.join(fixture.root,'cas.key')),
  cert:await readFile(fixture.certificate),
 },(req,res)=>{
  void(async()=>{
   let json='';
   for await(const c of req)json+=String(c);
   const data=JSON.parse(json) as Record<string,any>;
   const allowed=req.headers.authorization==='Bearer '+fixture.settings.token;
   if(!allowed){res.writeHead(403);res.end();return}
   const send=(o:unknown,status=200)=>{
    res.writeHead(status,{'content-type':'application/json',
      'connection':'close'});
    res.end(JSON.stringify(o));
   };
   if(typeof data.challengeNonce!=='string'||
      !/^[0-9a-f]{64}$/.test(data.challengeNonce)){
    send({error:'challenge required'},400);return;
   }
   if(req.url==='/v1/grant-cas/reserve'){
    const op=data.request,scope=data.scope;
    reserveChallenges.push(data.challengeNonce);
    if(replayReserve&&savedReserve){send(savedReserve);return}
    if(revoked||scope.expectedGeneration!==epoch){
     send({error:'revoked'},409);return;
    }
    const old=fakeDb.get(op.requestId);
    if(!old)fakeDb.set(op.requestId,{sequence:fakeDb.size+1,created:true});
    const result=fakeDb.get(op.requestId)!;
    savedReserve={authorityId:fixture.authorityId,deviceId:op.deviceId,
      epoch:op.epoch,requestId:op.requestId,challengeNonce:data.challengeNonce,
      ownerId:scope.ownerId,sessionEpoch:wrongProof?randomUUID():scope.sessionEpoch,
      grantGeneration:scope.expectedGeneration,
      fingerprint:op.fingerprint,capability:op.capability,
      sequence:result.sequence,created:!old};
    send(savedReserve);
    return;
   }
   if(req.url==='/v1/grant-cas/re-pair'){
    repairChallenges.push(data.challengeNonce);
    if(replayRepair&&savedRepair){send(savedRepair);return}
    savedRepair={authorityId:fixture.authorityId,deviceId:data.deviceId,
      ownerId:data.ownerId,deviceEpoch:data.deviceEpoch,sessionEpoch:data.sessionEpoch,
      challengeNonce:data.challengeNonce,previousGeneration:data.expectedGeneration,
      generation:data.expectedGeneration+1,revoked:true,newOwnerId:data.newOwnerId,
      newDeviceEpoch:data.newDeviceEpoch,newSessionEpoch:data.newSessionEpoch,
      coreCleared:true};
    send(savedRepair);return;
   }
   if(req.url==='/v1/grant-cas/revoke'){
    revokeChallenges.push(data.challengeNonce);
    if(replayRevoke&&savedRevoke){send(savedRevoke);return}
    if(revoked||data.expectedGeneration!==epoch){
     send({error:'stale'},409);return;
    }
    revoked=true;epoch++;
    savedRevoke={authorityId:fixture.authorityId,deviceId:data.deviceId,
      ownerId:data.ownerId,deviceEpoch:data.deviceEpoch,
      sessionEpoch:data.sessionEpoch,challengeNonce:data.challengeNonce,
      previousGeneration:data.expectedGeneration,generation:epoch,revoked:true};
    send(savedRevoke);
    return;
   }
   res.writeHead(404);res.end();
  })().catch(()=>{if(!res.headersSent){res.writeHead(503);res.end()}});
 });
 await new Promise<void>(resolve=>server.listen(0,'localhost',resolve));
 t.after(async()=>{
  server.closeAllConnections();
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  tls.setDefaultCACertificates(before);
  await fixture.stop();
  await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 });
 const port=(server.address() as {port:number}).port;
 const transport=new HttpsExternalGrantCas({
  endpoint:'https://localhost:'+port+'/v1/grant-cas/reserve',
  authorityId:fixture.authorityId,
  credentialFor:async()=>fixture.settings.token,
 });
 const scope={ownerId:randomUUID(),deviceId:fixture.deviceId,
  deviceEpoch:fixture.epoch,sessionEpoch:randomUUID(),
  expectedGeneration:epoch,requiredPrivilege:'CORE' as const};
 const input={deviceId:scope.deviceId,epoch:scope.deviceEpoch,
  requestId:randomUUID(),fingerprint:fp,capability:'shell.exec'};
 assert.equal((await transport.reserveIfCurrent(input,scope)).created,true);
 replayReserve=true;
 await assert.rejects(transport.reserveIfCurrent(input,scope),
  {code:'EXTERNAL_GRANT_PROOF_SCOPE_MISMATCH'});
 replayReserve=false;
 assert.notEqual(reserveChallenges[0],reserveChallenges[1]);
 assert.equal((await transport.reserveIfCurrent(input,scope)).created,false);
 wrongProof=true;
 await assert.rejects(transport.reserveIfCurrent({...input,requestId:randomUUID()},scope),
  {code:'EXTERNAL_GRANT_PROOF_SCOPE_MISMATCH'});
 wrongProof=false;
 const proof='SIGNED_OPERATOR_APPROVAL_DEMO_'.repeat(2);
 const original={deviceId:scope.deviceId,ownerId:scope.ownerId,
  deviceEpoch:scope.deviceEpoch,sessionEpoch:scope.sessionEpoch,
  expectedGeneration:scope.expectedGeneration,signedOwnerApproval:proof};
 const repair={...original,newOwnerId:randomUUID(),
  newDeviceEpoch:randomUUID(),newSessionEpoch:randomUUID()};
 const repaired=await transport.rePairIfCurrent(repair);
 assert.equal(repaired.coreCleared,true);
 assert.equal(Object.hasOwn(repaired,'challengeNonce'),false);
 replayRepair=true;
 await assert.rejects(transport.rePairIfCurrent(repair),
  {code:'EXTERNAL_REPAIR_PROOF_SCOPE_MISMATCH'});
 replayRepair=false;
 assert.notEqual(repairChallenges[0],repairChallenges[1]);
 const revokeReceipt=await transport.revokeIfCurrent(original);
 assert.equal(revokeReceipt.revoked,true);
 assert.equal(Object.hasOwn(revokeReceipt,'challengeNonce'),false);
 replayRevoke=true;
 await assert.rejects(transport.revokeIfCurrent(original),
  {code:'EXTERNAL_REVOKE_PROOF_SCOPE_MISMATCH'});
 replayRevoke=false;
 assert.notEqual(revokeChallenges[0],revokeChallenges[1]);
 await assert.rejects(transport.reserveIfCurrent({...input,requestId:randomUUID()},scope),
  {code:'EXTERNAL_GRANT_AUTHORITY_REFUSED'});
});
test('remote grant adapter cannot downgrade to HTTP or missing credential',async()=>{
 assert.throws(()=>new HttpsExternalGrantCas({
  endpoint:'http://localhost:443/v1/grant-cas/reserve',authorityId:randomUUID(),
  credentialFor:async()=>undefined,
 }),{code:'EXTERNAL_GRANT_URL_INVALID'});
 const v=new HttpsExternalGrantCas({
  endpoint:'https://localhost:443/v1/grant-cas/reserve',
  authorityId:randomUUID(),credentialFor:async()=>undefined,
 });
 await assert.rejects(v.reserveIfCurrent({
  deviceId:randomUUID(),epoch:randomUUID(),requestId:randomUUID(),
  fingerprint:fp,capability:'shell.exec',
 },{ownerId:randomUUID(),deviceId:randomUUID(),deviceEpoch:randomUUID(),
  sessionEpoch:randomUUID(),expectedGeneration:1,requiredPrivilege:'CORE'}),
  {code:'EXTERNAL_GRANT_SCOPE_INVALID'});
});
