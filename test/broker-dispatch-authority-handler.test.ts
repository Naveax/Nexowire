/** Source-only wire tests. The backend and Broker readback are TEST FIXTURES,
 * not a durable independent CAS, protected Windows evidence, or production. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign,type KeyObject} from 'node:crypto';
import {createServer} from 'node:https';
import {createServer as createHttpServer} from 'node:http';
import * as tls from 'node:tls';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {BrokerExternalDispatchFence,type BrokerDispatchRequest,type DispatchClaim,
  type DispatchReleaseRequest,type DispatchRevokeRequest,
  type ExternalBrokerDispatchAuthority,type ProtectedBrokerEvidence}
  from '../src/agent/broker-external-dispatch-fence.js';
import {createBrokerDispatchAuthorityHandler}
  from '../src/agent/broker-dispatch-authority-handler.js';
import {HttpsBrokerDispatchAuthority} from '../src/agent/https-broker-dispatch-authority.js';
import {signedOperatorGrantVerifier} from '../src/agent/witness-signed-provenance.js';
import {isolatedRemoteCas} from './fixtures/agent-remote-cas-fixture.js';

function signed(value:unknown,key:KeyObject):DispatchClaim{
  const bytes=Buffer.from(JSON.stringify(value));
  return {payload:bytes.toString('base64url'),
    signature:sign(null,bytes,key).toString('base64url')};
}
const pub=(key:KeyObject)=>key.export({type:'spki',format:'pem'}).toString();

class FixtureAuthority implements ExternalBrokerDispatchAuthority{
  readonly tombstones=new Set<string>();
  readonly active=new Map<string,{request:BrokerDispatchRequest;brokerId:string;committed:boolean}>();
  beginCalls=0;commitCalls=0;releaseCalls=0;revokeCalls=0;
  generation=7;revoked=false;loseBeginAck=false;loseCommitAck=false;
  loseReleaseAck=false;loseRevokeAck=false;wrongNonce=false;
  forged=false;expired=false;
  afterCommit?:()=>void;
  readonly attacker=generateKeyPairSync('ed25519');
  constructor(readonly authorityId:string,readonly key:KeyObject){}
  async beginIfCurrent(op:BrokerDispatchRequest,broker:ProtectedBrokerEvidence,
    nonce:string):Promise<DispatchClaim>{
    this.beginCalls++;
    if(this.revoked||op.scope.expectedGeneration!==this.generation||
       this.tombstones.has(op.requestId))throw Error('FENCED');
    this.tombstones.add(op.requestId);
    const dispatchId=randomUUID();
    this.active.set(dispatchId,{request:structuredClone(op),brokerId:broker.brokerId,committed:false});
    if(this.loseBeginAck){this.loseBeginAck=false;throw Error('UNKNOWN_AFTER_RESERVE')}
    return this.permit('broker_dispatch_permit_v1',op,broker,dispatchId,nonce);
  }
  async commitIfCurrent(op:BrokerDispatchRequest,broker:ProtectedBrokerEvidence,
    dispatchId:string,nonce:string):Promise<DispatchClaim>{
    this.commitCalls++;
    const entry=this.active.get(dispatchId);
    if(this.revoked||op.scope.expectedGeneration!==this.generation||!entry||
       entry.committed||entry.brokerId!==broker.brokerId||
       JSON.stringify(entry.request)!==JSON.stringify(op))throw Error('FENCED');
    entry.committed=true;
    if(this.loseCommitAck){this.loseCommitAck=false;throw Error('UNKNOWN_AFTER_COMMIT')}
    this.afterCommit?.();
    return this.permit('broker_dispatch_commit_v1',op,broker,dispatchId,nonce);
  }
  private permit(kind:string,op:BrokerDispatchRequest,broker:ProtectedBrokerEvidence,
    dispatchId:string,nonce:string):DispatchClaim{
    const s=op.scope,now=Date.now();
    return signed({kind,authorityId:this.authorityId,brokerId:broker.brokerId,
      dispatchId,challengeNonce:this.wrongNonce?'0'.repeat(64):nonce,
      requestId:op.requestId,fingerprint:op.fingerprint,capability:op.capability,
      ownerId:s.ownerId,deviceId:s.deviceId,deviceEpoch:s.deviceEpoch,
      sessionEpoch:s.sessionEpoch,ownerEpoch:s.ownerEpoch,
      generation:s.expectedGeneration,privilege:s.requiredPrivilege,
      issuedAtMs:this.expired?now-5000:now,expiresAtMs:this.expired?now-1:now+2000},
      this.forged?this.attacker.privateKey:this.key);
  }
  async release(value:DispatchReleaseRequest):Promise<void>{
    this.releaseCalls++;
    const entry=this.active.get(value.dispatchId);
    if(!entry||entry.brokerId!==value.brokerId||
       JSON.stringify(entry.request)!==JSON.stringify(value.request))throw Error('FENCED');
    this.active.delete(value.dispatchId);
    if(this.loseReleaseAck){this.loseReleaseAck=false;throw Error('UNKNOWN_AFTER_RELEASE')}
  }
  async revokeAndDrain(op:DispatchRevokeRequest,nonce:string):Promise<DispatchClaim>{
    this.revokeCalls++;
    if(this.revoked||op.expectedGeneration!==this.generation||this.active.size)
      throw Error('UNKNOWN_OR_ACTIVE');
    this.revoked=true;this.generation++;
    if(this.loseRevokeAck){this.loseRevokeAck=false;throw Error('UNKNOWN_AFTER_REVOKE')}
    return signed({kind:'broker_dispatch_revocation_v1',authorityId:this.authorityId,
      deviceId:op.deviceId,ownerId:op.ownerId,deviceEpoch:op.deviceEpoch,
      sessionEpoch:op.sessionEpoch,challengeNonce:this.wrongNonce?'0'.repeat(64):nonce,
      previousGeneration:op.expectedGeneration,generation:this.generation,
      drained:true,revoked:true},this.forged?this.attacker.privateKey:this.key);
  }
}

test('dispatch wire adapter enforces identity, protected readback and signed receipts',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'nw-dispatch-handler-'));
  const ca=await isolatedRemoteCas(root);
  const previous=tls.getCACertificates('default');
  tls.setDefaultCACertificates([...previous,await readFile(ca.certificate,'utf8')]);
  const authorityKey=generateKeyPairSync('ed25519'),ownerKey=generateKeyPairSync('ed25519');
  const authorityId=randomUUID(),brokerId=randomUUID(),ownerId=randomUUID();
  const deviceId=randomUUID(),deviceEpoch=randomUUID(),sessionEpoch=randomUUID();
  const token=randomUUID()+randomUUID(),principal={brokerId,ownerId,deviceId,deviceEpoch,sessionEpoch};
  const backend=new FixtureAuthority(authorityId,authorityKey.privateKey);
  let high=true,credentialCurrent=true,expireAfterNextValidAuth=false;
  let principalSource:()=>typeof principal=()=>principal;
  let evidenceSource:(()=>Promise<ProtectedBrokerEvidence|undefined>)|undefined;
  const effective=():ProtectedBrokerEvidence=>({verified:true,brokerId,ownerEpoch:4,
    grantGeneration:7,highIntegrityToken:high as true,signedProtectedImage:true,
    protectedParentAndImports:true});
  const approval=signedOperatorGrantVerifier(pub(ownerKey.publicKey));
  const settings={authorityId,publicKeyPem:pub(authorityKey.publicKey),authority:backend,
    authenticateBroker:async(credential:string)=>{
      const valid=credential===token&&credentialCurrent;
      const resolved=valid?principalSource():undefined;
      if(valid&&expireAfterNextValidAuth){
        expireAfterNextValidAuth=false;
        credentialCurrent=false;
      }
      return resolved;
    },
    readProtectedBroker:async()=>evidenceSource?evidenceSource():effective(),
    verifyOwnerRevocation:async(r:DispatchRevokeRequest)=>approval({kind:'revoke',
      authorityId,deviceId:r.deviceId,ownerId:r.ownerId,epoch:r.deviceEpoch,
      sessionEpoch:r.sessionEpoch,generation:r.expectedGeneration},r.signedOwnerApproval)};
  assert.throws(()=>createBrokerDispatchAuthorityHandler({...settings,
    authority:undefined as unknown as ExternalBrokerDispatchAuthority}),
    /DISPATCH_HANDLER_CONFIG_INVALID/);
  const handler=createBrokerDispatchAuthorityHandler(settings);
  const server=createServer({key:await readFile(path.join(ca.root,'cas.key')),
    cert:await readFile(ca.certificate)},handler);
  await new Promise<void>(resolve=>server.listen(0,'localhost',resolve));
  const address=server.address();
  assert.ok(address&&typeof address!=='string');
  const base='https://localhost:'+address.port+'/v1/broker-dispatch';
  const remote=new HttpsBrokerDispatchAuthority({endpoint:base,brokerCredential:async()=>token});
  const makeFence=()=>new BrokerExternalDispatchFence({authority:remote,authorityId,
    publicKeyPem:pub(authorityKey.publicKey),verifyIdentity:async()=>true,
    verifyEffectiveBroker:async()=>effective(),verifyOwnerRevocation:async()=>true});
  const operation=():BrokerDispatchRequest=>({requestId:randomUUID(),fingerprint:'a'.repeat(64),
    capability:'shell.exec',scope:{ownerId,deviceId,deviceEpoch,sessionEpoch,ownerEpoch:4,
      expectedGeneration:7,requiredPrivilege:'CORE'}});
  const post=async(action:string,body:unknown,credential=token)=>fetch(base+'/'+action,{
    method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},
    body:JSON.stringify(body)});
  t.after(async()=>{
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    tls.setDefaultCACertificates(previous);await ca.stop();
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });

  await t.test('plaintext listener and missing credentials are denied',async()=>{
    const plain=createHttpServer(handler);
    await new Promise<void>(resolve=>plain.listen(0,'127.0.0.1',resolve));
    try{
      const addr=plain.address();assert.ok(addr&&typeof addr!=='string');
      const response=await fetch('http://127.0.0.1:'+addr.port+'/v1/broker-dispatch/begin',{
        method:'POST',headers:{authorization:'Bearer '+token},body:'{}'});
      assert.equal(response.status,403);
    }finally{
      plain.closeAllConnections();await new Promise<void>(resolve=>plain.close(()=>resolve()));
    }
    assert.equal((await post('begin',{},'wrong-credential-12345')).status,403);
    assert.equal(backend.beginCalls,0);
  });

  await t.test('positive begin, commit and release use independently signed scope',async()=>{
    let effects=0;
    assert.equal(await makeFence().execute(operation(),async()=>++effects),1);
    assert.equal(effects,1);assert.equal(backend.commitCalls,1);
    assert.equal(backend.releaseCalls,1);assert.equal(backend.active.size,0);
  });

  await t.test('wrong owner and stale or unavailable protected readback never reach CAS',async()=>{
    const before=backend.beginCalls,op=operation();
    op.scope.ownerId=randomUUID();
    assert.equal((await post('begin',{request:op,broker:effective(),
      challengeNonce:'1'.repeat(64)})).status,403);
    high=false;
    assert.equal((await post('begin',{request:operation(),broker:{...effective(),highIntegrityToken:true},
      challengeNonce:'1'.repeat(64)})).status,403);
    high=true;
    assert.equal(backend.beginCalls,before);
  });

  await t.test('native Broker readback rejects accessor, inherited and trapping Proxy evidence',async()=>{
    const baseline=backend.beginCalls;
    for(const kind of ['accessor','inherited','proxy'] as const){
      let getterReads=0;
      evidenceSource=async()=>{
        const raw=effective();
        if(kind==='accessor'){
          Object.defineProperty(raw,'brokerId',{enumerable:true,
            get(){getterReads++;return brokerId}});
          return raw;
        }
        if(kind==='inherited')return Object.create(raw) as ProtectedBrokerEvidence;
        return new Proxy(raw,{ownKeys(){throw Error('PROVIDER_TRAP')}});
      };
      try{
        const response=await post('begin',{request:operation(),broker:effective(),
          challengeNonce:'5'.repeat(64)});
        assert.equal(response.status,403,kind+' must fail closed');
        assert.equal(backend.beginCalls,baseline);
        assert.equal(getterReads,0,'never execute provider-controlled getter');
      }finally{evidenceSource=undefined}
    }
  });

  await t.test('protected principal rejects inherited and accessor scope without invoking CAS',async()=>{
    const baseline=backend.beginCalls;
    for(const kind of ['accessor','inherited'] as const){
      let getterReads=0;
      principalSource=()=>{
        if(kind==='inherited')return Object.create(principal) as typeof principal;
        const raw={...principal};
        Object.defineProperty(raw,'ownerId',{enumerable:true,
          get(){getterReads++;return ownerId}});
        return raw;
      };
      try{
        const response=await post('begin',{request:operation(),broker:effective(),
          challengeNonce:'6'.repeat(64)});
        assert.equal(response.status,403);
        assert.equal(backend.beginCalls,baseline);
        assert.equal(getterReads,0);
      }finally{principalSource=()=>principal}
    }
  });

  await t.test('mid-request Broker credential revoke refuses CAS despite HIGH token',async()=>{
    const baseline=backend.beginCalls;
    evidenceSource=async()=>{credentialCurrent=false;return effective()};
    try{
      const response=await post('begin',{request:operation(),broker:effective(),
        challengeNonce:'7'.repeat(64)});
      assert.equal(response.status,403);
      assert.equal(backend.beginCalls,baseline);
    }finally{credentialCurrent=true;evidenceSource=undefined}
  });

  await t.test('concurrent Hubs cannot use one UUID twice',async()=>{
    const op=operation();let effects=0;
    const outcomes=await Promise.allSettled([
      makeFence().execute(op,async()=>++effects),
      makeFence().execute(op,async()=>++effects),
    ]);
    assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
    assert.equal(outcomes.filter(o=>o.status==='rejected').length,1);
    assert.equal(effects,1);
  });

  await t.test('stale HIGH after remote commit blocks the callback',async()=>{
    const op=operation();let effects=0;
    backend.afterCommit=()=>{high=false};
    try{
      await assert.rejects(makeFence().execute(op,async()=>++effects),
        {code:'DISPATCH_HIGH_TOKEN_UNVERIFIED'});
      assert.equal(effects,0);
    }finally{high=true;backend.afterCommit=undefined}
    await assert.rejects(makeFence().execute(op,async()=>++effects),
      {code:'DISPATCH_EXTERNAL_CAS_UNKNOWN'});
    assert.equal(effects,0);
  });

  await t.test('forged, expired or mismatched nonce receipts cannot authorize effects',async()=>{
    for(const flag of ['forged','expired','wrongNonce'] as const){
      const op=operation();backend[flag]=true;let effects=0;
      await assert.rejects(makeFence().execute(op,async()=>++effects),
        {code:'DISPATCH_EXTERNAL_CAS_UNKNOWN'});
      assert.equal(effects,0);backend[flag]=false;
      // Even though the response was rejected, the backend consumed this ID.
      await assert.rejects(makeFence().execute(op,async()=>++effects),
        {code:'DISPATCH_EXTERNAL_CAS_UNKNOWN'});
      assert.equal(effects,0);
    }
    // Disposable fixture reconciliation only, not an actual production drain.
    backend.active.clear();
  });

  await t.test('lost reserve ACK remains UNKNOWN and cannot be replayed',async()=>{
    const op=operation();backend.loseBeginAck=true;let effects=0;
    await assert.rejects(makeFence().execute(op,async()=>++effects),
      {code:'DISPATCH_EXTERNAL_CAS_UNKNOWN'});
    await assert.rejects(makeFence().execute(op,async()=>++effects),
      {code:'DISPATCH_EXTERNAL_CAS_UNKNOWN'});
    assert.equal(effects,0);assert.equal(backend.tombstones.has(op.requestId),true);
    backend.active.clear();
  });

  await t.test('lost commit and release ACK never replay an effect',async()=>{
    let effects=0;
    const uncertain=operation();backend.loseCommitAck=true;
    await assert.rejects(makeFence().execute(uncertain,async()=>++effects),
      {code:'DISPATCH_COMMIT_UNKNOWN'});
    await assert.rejects(makeFence().execute(uncertain,async()=>++effects),
      {code:'DISPATCH_EXTERNAL_CAS_UNKNOWN'});
    assert.equal(effects,0);
    const done=operation(),fence=makeFence();backend.loseReleaseAck=true;
    assert.equal(await fence.execute(done,async()=>++effects),1);
    await assert.rejects(fence.execute(done,async()=>++effects),
      {code:'DISPATCH_REVOKE_PENDING'});
    await assert.rejects(makeFence().execute(done,async()=>++effects),
      {code:'DISPATCH_EXTERNAL_CAS_UNKNOWN'});
    assert.equal(effects,1);
  });

  await t.test('release is bound to immutable original owner and Broker',async()=>{
    const op=operation();
    const receipt=await remote.beginIfCurrent(op,effective(),'1'.repeat(64));
    const parsed=JSON.parse(Buffer.from(receipt.payload,'base64url').toString()) as {dispatchId:string};
    const before=backend.releaseCalls;
    const wrong={...op,scope:{...op.scope,sessionEpoch:randomUUID()}};
    await assert.rejects(remote.release({dispatchId:parsed.dispatchId,brokerId,request:wrong}),
      {code:'BROKER_DISPATCH_REMOTE_REFUSED'});
    assert.equal(backend.releaseCalls,before);
    await remote.release({dispatchId:parsed.dispatchId,brokerId,request:op});
    assert.equal(backend.active.size,0);
  });

  await t.test('release drains exact preexisting claim if live credential expires mid-request',async()=>{
    const op=operation();
    const reservation=await remote.beginIfCurrent(op,effective(),'9'.repeat(64));
    const claim=JSON.parse(Buffer.from(reservation.payload,'base64url').toString('utf8')) as
      {dispatchId:string};
    const before=backend.releaseCalls;
    // First authentication is still valid, and it becomes revoked immediately
    // afterward. Release must not attempt a second fresh-grant admission.
    expireAfterNextValidAuth=true;
    try {
      await remote.release({dispatchId:claim.dispatchId,brokerId,request:op});
      assert.equal(backend.releaseCalls,before+1);
      assert.equal(backend.active.has(claim.dispatchId),false);
      // The same now-revoked credential must NOT authorize a new claim.
      assert.equal((await post('begin',{request:operation(),broker:effective(),
        challengeNonce:'8'.repeat(64)})).status,403);
    } finally {
      expireAfterNextValidAuth=false;
      credentialCurrent=true;
    }
  });

  await t.test('server refuses validly signed noncanonical Broker receipt',async()=>{
    const op=operation();
    const original=backend.beginIfCurrent.bind(backend);
    let dispatchId:string|undefined;
    backend.beginIfCurrent=async(...args)=>{
      const receipt=await original(...args);
      const json=Buffer.from(receipt.payload,'base64url').toString('utf8');
      dispatchId=(JSON.parse(json) as {dispatchId:string}).dispatchId;
      const bytes=Buffer.from(' '+json,'utf8');
      return {payload:bytes.toString('base64url'),
        signature:sign(null,bytes,authorityKey.privateKey).toString('base64url')};
    };
    try{
      const response=await post('begin',{request:op,broker:effective(),
        challengeNonce:'4'.repeat(64)});
      assert.equal(response.status,503);
      assert.ok(dispatchId);
    }finally{
      backend.beginIfCurrent=original;
      if(dispatchId)await remote.release({dispatchId,brokerId,request:op});
    }
  });

  await t.test('owner revoke needs a real signature and a matching drained receipt',async()=>{
    const intent={kind:'revoke',authorityId,deviceId,ownerId,epoch:deviceEpoch,
      sessionEpoch,generation:7};
    const envelope=(key:KeyObject)=>JSON.stringify(signed({version:1,intent,nonce:randomUUID(),
      issuedAt:Date.now()-100,expiresAt:Date.now()+30000},key));
    const req={deviceId,ownerId,deviceEpoch,sessionEpoch,expectedGeneration:7,
      signedOwnerApproval:envelope(backend.attacker.privateKey)};
    const before=backend.revokeCalls;
    await assert.rejects(remote.revokeAndDrain(req,'1'.repeat(64)),
      {code:'BROKER_DISPATCH_REMOTE_REFUSED'});
    assert.equal(backend.revokeCalls,before);
    req.signedOwnerApproval=envelope(ownerKey.privateKey);
    // Owner-signed deny/drain must remain possible when the original Broker
    // credential becomes invalid *after* initial authenticated admission.
    expireAfterNextValidAuth=true;
    const result=await (async()=>{
      try{
        return await remote.revokeAndDrain(req,'2'.repeat(64));
      }finally{
        expireAfterNextValidAuth=false;
        credentialCurrent=true;
      }
    })();
    const proof=JSON.parse(Buffer.from(result.payload,'base64url').toString()) as {drained:boolean};
    assert.equal(proof.drained,true);
    let effects=0;
    await assert.rejects(makeFence().execute(operation(),async()=>++effects),
      {code:'DISPATCH_EXTERNAL_CAS_UNKNOWN'});
    assert.equal(effects,0);
  });

  await t.test('drain with an active claim and lost revoke ACK stay UNKNOWN',async()=>{
    const second=new FixtureAuthority(authorityId,authorityKey.privateKey);
    const handler2=createBrokerDispatchAuthorityHandler({...settings,authority:second});
    const server2=createServer({key:await readFile(path.join(ca.root,'cas.key')),
      cert:await readFile(ca.certificate)},handler2);
    await new Promise<void>(resolve=>server2.listen(0,'localhost',resolve));
    try{
      const addr=server2.address();assert.ok(addr&&typeof addr!=='string');
      const transport=new HttpsBrokerDispatchAuthority({
        endpoint:'https://localhost:'+addr.port+'/v1/broker-dispatch',
        brokerCredential:async()=>token});
      const op=operation();
      const permit=await transport.beginIfCurrent(op,effective(),'3'.repeat(64));
      const claim=JSON.parse(Buffer.from(permit.payload,'base64url').toString()) as {dispatchId:string};
      const intent={kind:'revoke',authorityId,deviceId,ownerId,epoch:deviceEpoch,
        sessionEpoch,generation:7};
      const signedOwnerApproval=JSON.stringify(signed({version:1,intent,nonce:randomUUID(),
        issuedAt:Date.now()-100,expiresAt:Date.now()+30000},ownerKey.privateKey));
      const req={deviceId,ownerId,deviceEpoch,sessionEpoch,expectedGeneration:7,signedOwnerApproval};
      await assert.rejects(transport.revokeAndDrain(req,'4'.repeat(64)),
        {code:'BROKER_DISPATCH_REMOTE_REFUSED'});
      assert.equal(second.revoked,false);
      await transport.release({dispatchId:claim.dispatchId,brokerId,request:op});
      second.loseRevokeAck=true;
      const fence=new BrokerExternalDispatchFence({authority:transport,authorityId,
        publicKeyPem:pub(authorityKey.publicKey),verifyIdentity:async()=>true,
        verifyEffectiveBroker:async()=>effective(),verifyOwnerRevocation:async()=>true});
      await assert.rejects(fence.revoke(req),{code:'DISPATCH_REVOKE_OUTCOME_UNKNOWN'});
      assert.equal(second.revoked,true);
      const calls=second.revokeCalls;
      await assert.rejects(fence.revoke(req),{code:'DISPATCH_REVOKE_PENDING'});
      assert.equal(second.revokeCalls,calls);
      let effects=0;
      await assert.rejects(fence.execute(operation(),async()=>++effects),
        {code:'DISPATCH_REVOKE_PENDING'});
      assert.equal(effects,0);
    }finally{
      server2.closeAllConnections();await new Promise<void>(resolve=>server2.close(()=>resolve()));
    }
  });
});
