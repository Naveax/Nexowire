/** In-memory TEST authority and ephemeral TLS; no production CAS proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign,type KeyObject} from 'node:crypto';
import {createServer} from 'node:https';
import {createServer as createHttpServer} from 'node:http';
import * as tls from 'node:tls';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {CasRequest} from '../src/agent/remote-mutation-cas.js';
import type {AuthenticatedGrantScope,ExternalGrantCasReceipt,ExternalRevokeRequest,
  ExternalRevokeReceipt,ExternalRePairRequest,ExternalRePairReceipt}
  from '../src/agent/postgres-bound-grant-cas.js';
import {createGrantCasAuthorityHandler,type ChallengedGrantCasAuthority}
  from '../src/agent/grant-cas-authority-handler.js';
import {HttpsExternalGrantCas} from '../src/agent/https-external-grant-cas.js';
import {signedOperatorGrantVerifier} from '../src/agent/witness-signed-provenance.js';
import {isolatedRemoteCas} from './fixtures/agent-remote-cas-fixture.js';

type Challenged<T>=T&{challengeNonce:string};
function signed(value:unknown,key:KeyObject):string{
  const bytes=Buffer.from(JSON.stringify(value));
  return JSON.stringify({payload:bytes.toString('base64url'),
    signature:sign(null,bytes,key).toString('base64url')});
}

class FixtureAuthority implements ChallengedGrantCasAuthority{
  readonly records=new Map<string,{request:CasRequest;scope:AuthenticatedGrantScope;sequence:number}>();
  generation=7;revoked=false;rootExpired=false;loseReserveAck=false;loseRevokeAck=false;
  replayReserve=false;wrongScope=false;reserveCalls=0;revokeCalls=0;repairCalls=0;
  lastReserve?:Challenged<ExternalGrantCasReceipt>;
  constructor(readonly authorityId:string){}
  async reserveIfCurrent(op:CasRequest,scope:AuthenticatedGrantScope,
    challengeNonce:string):Promise<Challenged<ExternalGrantCasReceipt>>{
    this.reserveCalls++;
    if(this.replayReserve&&this.lastReserve)return this.lastReserve;
    if(this.revoked||scope.expectedGeneration!==this.generation||
       (scope.requiredPrivilege==='ROOT'&&this.rootExpired))throw Error('REVOKED_OR_EXPIRED');
    const old=this.records.get(op.requestId);
    if(old&&(JSON.stringify(old.request)!==JSON.stringify(op)||
       JSON.stringify(old.scope)!==JSON.stringify(scope)))throw Error('UUID_SCOPE_COLLISION');
    const sequence=old?.sequence??this.records.size+1;
    if(!old)this.records.set(op.requestId,{request:structuredClone(op),scope:structuredClone(scope),sequence});
    const proof={challengeNonce,authorityId:this.authorityId,deviceId:op.deviceId,epoch:op.epoch,
      requestId:op.requestId,ownerId:scope.ownerId,
      sessionEpoch:this.wrongScope?randomUUID():scope.sessionEpoch,
      grantGeneration:scope.expectedGeneration,fingerprint:op.fingerprint,capability:op.capability,
      created:!old,sequence};
    this.lastReserve=proof;
    if(this.loseReserveAck){this.loseReserveAck=false;throw Error('UNKNOWN_AFTER_RESERVE')}
    return proof;
  }
  async revokeIfCurrent(op:ExternalRevokeRequest,
    challengeNonce:string):Promise<Challenged<ExternalRevokeReceipt>>{
    this.revokeCalls++;
    if(this.revoked||op.expectedGeneration!==this.generation)throw Error('REVOKED');
    this.revoked=true;this.generation++;
    if(this.loseRevokeAck){this.loseRevokeAck=false;throw Error('UNKNOWN_AFTER_REVOKE')}
    return {challengeNonce,authorityId:this.authorityId,deviceId:op.deviceId,ownerId:op.ownerId,
      deviceEpoch:op.deviceEpoch,sessionEpoch:op.sessionEpoch,previousGeneration:op.expectedGeneration,
      generation:this.generation,revoked:true};
  }
  async rePairIfCurrent(op:ExternalRePairRequest,
    challengeNonce:string):Promise<Challenged<ExternalRePairReceipt>>{
    this.repairCalls++;
    if(this.revoked||op.expectedGeneration!==this.generation)throw Error('REVOKED');
    this.revoked=true;this.generation++;
    return {challengeNonce,authorityId:this.authorityId,deviceId:op.deviceId,ownerId:op.ownerId,
      deviceEpoch:op.deviceEpoch,sessionEpoch:op.sessionEpoch,previousGeneration:op.expectedGeneration,
      generation:this.generation,revoked:true,newOwnerId:op.newOwnerId,
      newDeviceEpoch:op.newDeviceEpoch,newSessionEpoch:op.newSessionEpoch,coreCleared:true};
  }
}

test('grant CAS wire validates scope, challenge and owner transitions',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'nw-grant-handler-'));
  const ca=await isolatedRemoteCas(root);
  const previous=tls.getCACertificates('default');
  tls.setDefaultCACertificates([...previous,await readFile(ca.certificate,'utf8')]);
  const signer=generateKeyPairSync('ed25519'),attacker=generateKeyPairSync('ed25519');
  const publicKey=signer.publicKey.export({type:'spki',format:'pem'}).toString();
  const verify=signedOperatorGrantVerifier(publicKey);
  const authorityId=randomUUID(),ownerId=randomUUID(),deviceId=randomUUID(),
    deviceEpoch=randomUUID(),sessionEpoch=randomUUID(),token=randomUUID()+randomUUID();
  const principal={ownerId,deviceId,deviceEpoch,sessionEpoch};
  const backend=new FixtureAuthority(authorityId);
  const config={authorityId,authority:backend,
    authenticateDevice:async(value:string)=>value===token?principal:undefined,
    verifyOwnerApproval:async(op:ExternalRevokeRequest|ExternalRePairRequest,kind:'revoke'|'re_pair')=>{
      const next=op as ExternalRePairRequest;
      return verify({kind,authorityId,ownerId:op.ownerId,deviceId:op.deviceId,
        epoch:op.deviceEpoch,sessionEpoch:op.sessionEpoch,generation:op.expectedGeneration,
        ...(kind==='re_pair'?{nextOwnerId:next.newOwnerId,nextEpoch:next.newDeviceEpoch,
          nextSessionEpoch:next.newSessionEpoch}:{})},op.signedOwnerApproval);
    }};
  assert.throws(()=>createGrantCasAuthorityHandler({...config,
    authority:undefined as unknown as ChallengedGrantCasAuthority}),/GRANT_HANDLER_CONFIG_INVALID/);
  const key=await readFile(path.join(ca.root,'cas.key'));
  const cert=await readFile(ca.certificate);
  const handler=createGrantCasAuthorityHandler(config),server=createServer({key,cert},handler);
  await new Promise<void>(resolve=>server.listen(0,'localhost',resolve));
  const addr=server.address();assert.ok(addr&&typeof addr!=='string');
  const base='https://localhost:'+addr.port+'/v1/grant-cas';
  const transport=new HttpsExternalGrantCas({endpoint:base+'/reserve',authorityId,
    credentialFor:async()=>token});
  const bound:AuthenticatedGrantScope={...principal,expectedGeneration:7,requiredPrivilege:'CORE'};
  const op=():CasRequest=>({deviceId,epoch:deviceEpoch,requestId:randomUUID(),
    fingerprint:'b'.repeat(64),capability:'shell.exec'});
  const post=(action:string,body:unknown,credential=token)=>fetch(base+'/'+action,{
    method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},
    body:JSON.stringify(body)});
  t.after(async()=>{
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    tls.setDefaultCACertificates(previous);await ca.stop();
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  const approval=(kind:'revoke'|'re_pair',request:ExternalRevokeRequest|ExternalRePairRequest,
    privateKey:KeyObject=signer.privateKey)=>{
    const next=request as ExternalRePairRequest;
    const intent={kind,authorityId,deviceId:request.deviceId,ownerId:request.ownerId,
      epoch:request.deviceEpoch,sessionEpoch:request.sessionEpoch,generation:request.expectedGeneration,
      ...(kind==='re_pair'?{nextOwnerId:next.newOwnerId,nextEpoch:next.newDeviceEpoch,
        nextSessionEpoch:next.newSessionEpoch}:{})};
    return signed({version:1,intent,nonce:randomUUID(),issuedAt:Date.now()-100,
      expiresAt:Date.now()+30000},privateKey);
  };
  const revokeRequest=():ExternalRevokeRequest=>({deviceId,ownerId,deviceEpoch,sessionEpoch,
    expectedGeneration:7,signedOwnerApproval:'x'.repeat(32)});

  await t.test('plaintext, missing credential and cross-session scope are denied',async()=>{
    const plain=createHttpServer(handler);
    await new Promise<void>(resolve=>plain.listen(0,'127.0.0.1',resolve));
    try{
      const a=plain.address();assert.ok(a&&typeof a!=='string');
      assert.equal((await fetch('http://127.0.0.1:'+a.port+'/v1/grant-cas/reserve',{
        method:'POST',headers:{authorization:'Bearer '+token},body:'{}'})).status,403);
    }finally{plain.closeAllConnections();await new Promise<void>(resolve=>plain.close(()=>resolve()))}
    assert.equal((await post('reserve',{},'wrong-credential-12345')).status,403);
    const before=backend.reserveCalls;
    assert.equal((await post('reserve',{request:op(),scope:{...bound,sessionEpoch:randomUUID()},
      challengeNonce:'1'.repeat(64)})).status,403);
    assert.equal(backend.reserveCalls,before);
  });

  await t.test('reserve and duplicate UUID have only one created result',async()=>{
    const request=op();
    const results=await Promise.all([
      transport.reserveIfCurrent(request,bound),transport.reserveIfCurrent(request,bound)]);
    assert.equal(results.filter(r=>r.created).length,1);
    assert.equal(results.filter(r=>!r.created).length,1);
  });

  await t.test('stale nonce, wrong scope and expired ROOT fail closed',async()=>{
    const request=op();
    assert.equal((await transport.reserveIfCurrent(request,bound)).created,true);
    backend.replayReserve=true;
    await assert.rejects(transport.reserveIfCurrent(request,bound),
      {code:'EXTERNAL_GRANT_AUTHORITY_REFUSED'});
    backend.replayReserve=false;backend.wrongScope=true;
    await assert.rejects(transport.reserveIfCurrent(op(),bound),
      {code:'EXTERNAL_GRANT_AUTHORITY_REFUSED'});
    backend.wrongScope=false;backend.rootExpired=true;
    await assert.rejects(transport.reserveIfCurrent(op(),{...bound,requiredPrivilege:'ROOT'}),
      {code:'EXTERNAL_GRANT_AUTHORITY_REFUSED'});
    backend.rootExpired=false;
  });

  await t.test('lost reserve ACK cannot be turned into a new reservation',async()=>{
    const request=op();backend.loseReserveAck=true;
    await assert.rejects(transport.reserveIfCurrent(request,bound),
      {code:'EXTERNAL_GRANT_AUTHORITY_REFUSED'});
    assert.equal((await transport.reserveIfCurrent(request,bound)).created,false);
  });

  await t.test('forged owner approval, lost revoke ACK and revoked grant are denied',async()=>{
    const request=revokeRequest();request.signedOwnerApproval=approval('revoke',request,attacker.privateKey);
    const before=backend.revokeCalls;
    await assert.rejects(transport.revokeIfCurrent(request),{code:'EXTERNAL_REVOKE_AUTHORITY_REFUSED'});
    assert.equal(backend.revokeCalls,before);
    request.signedOwnerApproval=approval('revoke',request);backend.loseRevokeAck=true;
    await assert.rejects(transport.revokeIfCurrent(request),{code:'EXTERNAL_REVOKE_AUTHORITY_REFUSED'});
    assert.equal(backend.revoked,true);
    await assert.rejects(transport.revokeIfCurrent(request),{code:'EXTERNAL_REVOKE_AUTHORITY_REFUSED'});
    await assert.rejects(transport.reserveIfCurrent(op(),bound),{code:'EXTERNAL_GRANT_AUTHORITY_REFUSED'});
  });

  await t.test('re-pair rotates epoch and rejects a reused device/session epoch',async()=>{
    const second=new FixtureAuthority(authorityId);
    const server2=createServer({key,cert},createGrantCasAuthorityHandler({...config,authority:second}));
    await new Promise<void>(resolve=>server2.listen(0,'localhost',resolve));
    try{
      const a=server2.address();assert.ok(a&&typeof a!=='string');
      const client=new HttpsExternalGrantCas({endpoint:'https://localhost:'+a.port+'/v1/grant-cas/reserve',
        authorityId,credentialFor:async()=>token});
      const request:ExternalRePairRequest={...revokeRequest(),newOwnerId:randomUUID(),
        newDeviceEpoch:randomUUID(),newSessionEpoch:randomUUID()};
      request.signedOwnerApproval=approval('re_pair',request);
      const bad={...request,newDeviceEpoch:deviceEpoch};
      assert.equal((await fetch('https://localhost:'+a.port+'/v1/grant-cas/re-pair',{
        method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
        body:JSON.stringify({...bad,challengeNonce:'1'.repeat(64)})})).status,403);
      assert.equal(second.repairCalls,0);
      const result=await client.rePairIfCurrent(request);
      assert.equal(result.coreCleared,true);
      assert.equal(result.newDeviceEpoch,request.newDeviceEpoch);
      await assert.rejects(client.rePairIfCurrent(request),{code:'EXTERNAL_REPAIR_AUTHORITY_REFUSED'});
    }finally{server2.closeAllConnections();await new Promise<void>(resolve=>server2.close(()=>resolve()))}
  });
});
