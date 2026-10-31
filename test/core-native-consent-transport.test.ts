import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {ProtectedWindowsCoreConsentClient} from '../src/agent/windows-core-consent-transport.js';
import {RemoteTrustedNativeCoreEnrollmentVerifier} from '../src/product/core-native-consent-verifier.js';
import {coreNativeSignedResponseBytes,coreNativeWireRequestHash,
  callProtectedCoreNativeAuthority,snapshotCoreNativeWireRequest,
  type CoreNativeProof,type CoreNativeWireRequest,type CoreNativeWireResponse} from '../src/protocol/core-native-consent-transport.js';

const owner='owner-account-0001',deviceId='device-core-0001';
const signer=generateKeyPairSync('ed25519');
const pin=signer.publicKey.export({type:'spki',format:'der'}).toString('base64');
const challenge=()=>({version:1 as const,challengeId:randomUUID(),ownerAccountId:owner,
  deviceId,installationId:randomUUID(),enrollmentId:randomUUID(),
  ownerEpoch:1,grantGeneration:1,revokeEpoch:0});
function proofFor(c:ReturnType<typeof challenge>):CoreNativeProof{return {...c,
  receiptId:randomUUID(),windowsUserSid:'S-1-5-21-101-202-303-1001',
  windowsSessionId:2,windowsLogonLuid:'000000000000a101',
  windowsLogonSessionEpoch:randomUUID(),approvedAtMs:Date.now(),consumed:true};}
function signed(request:CoreNativeWireRequest,proof:CoreNativeProof|null,override:Record<string,unknown>={}){
  const data={version:1 as const,operation:request.operation,nonce:request.nonce,
    requestSha256:coreNativeWireRequestHash(request),observedAtMs:Date.now(),
    accepted:!!proof,proof,...override};
  const signatureBase64=sign(null,coreNativeSignedResponseBytes(
    data as Omit<CoreNativeWireResponse,'signatureBase64'>),signer.privateKey).toString('base64');
  return {...data,signatureBase64};
}
const http=(receive:(r:CoreNativeWireRequest)=>unknown):typeof fetch=>
  (async(_input,init)=>Response.json(receive(JSON.parse(String(init?.body)) as CoreNativeWireRequest))) as typeof fetch;
function local(fetchImpl:typeof fetch,pinnedSpkiBase64=pin){
  return new ProtectedWindowsCoreConsentClient({
    origin:'https://127.0.0.1:18764',credential:'fixture-not-a-native-credential',
    pinnedSpkiBase64,fetchImpl});
}
function remote(fetchImpl:typeof fetch,pinnedSpkiBase64=pin){
  return new RemoteTrustedNativeCoreEnrollmentVerifier({
    origin:'https://protected-native-verifier.example',credential:'fixture-not-a-native-credential',
    pinnedSpkiBase64,fetchImpl});
}
function enrollment(p:CoreNativeProof){
  return {version:1 as const,scope:'physical-console' as const,
    ownerAccountId:p.ownerAccountId,deviceId:p.deviceId,installationId:p.installationId,
    enrollmentId:p.enrollmentId,ownerEpoch:p.ownerEpoch,grantGeneration:p.grantGeneration,
    revokeEpoch:p.revokeEpoch,approvedLocallyAtMs:p.approvedAtMs,
    issuerSpkiSha256:'a'.repeat(64)};
}
function binding(p:CoreNativeProof){return {ownerAccountId:p.ownerAccountId,
  deviceId:p.deviceId,installationId:p.installationId,enrollmentId:p.enrollmentId,
  ownerEpoch:p.ownerEpoch,grantGeneration:p.grantGeneration,revokeEpoch:p.revokeEpoch,
  nativeConsentReceiptId:p.receiptId,windowsUserSid:p.windowsUserSid,
  windowsSessionId:p.windowsSessionId,windowsLogonLuid:p.windowsLogonLuid,
  windowsLogonSessionEpoch:p.windowsLogonSessionEpoch};}

test('signed native client requires protected issuer pin and session-bound one-use receipt',async()=>{
  const c=challenge(),p=proofFor(c);
  const consumed=new Set<string>();
  const fetcher=http(r=>{
    if(r.operation==='approve-and-consume'){
      if(consumed.has(p.receiptId))return signed(r,null);
      consumed.add(p.receiptId);return signed(r,p);
    }
    if(r.operation==='current-readback')return signed(r,p);
    return signed(r,null);
  });
  const client=local(fetcher);
  assert.deepEqual(await client.approveAndConsume(c,new AbortController().signal),p);
  assert.deepEqual(await client.currentReadback(p.receiptId,new AbortController().signal),p);
  await assert.rejects(client.approveAndConsume(c,new AbortController().signal),/CORE_NATIVE_AUTHORITY_DENIED/);
  await assert.rejects(local(fetcher,generateKeyPairSync('ed25519').publicKey
    .export({type:'spki',format:'der'}).toString('base64'))
    .currentReadback(p.receiptId,new AbortController().signal),/CORE_NATIVE_SIGNED_RESPONSE_REQUIRED/);
});

test('independent D1 verifier consumes receipt once and checks owner Windows logon SID/session/LUID/epoch',async()=>{
  const p=proofFor(challenge());let current=p;
  const consumed=new Set<string>();
  const fetcher=http(r=>{
    if(r.operation==='verify-and-consume'){
      const requested=(r.expected as {proof:CoreNativeProof}).proof;
      if(consumed.has(requested.receiptId)||requested.receiptId!==current.receiptId)return signed(r,null);
      consumed.add(requested.receiptId);return signed(r,current);
    }
    if(r.operation==='current-readback'){
      const expected=r.expected as ReturnType<typeof binding>;
      return signed(r,expected.windowsLogonSessionEpoch===current.windowsLogonSessionEpoch?current:null);
    }
    return signed(r,null);
  });
  const verifier=remote(fetcher);
  assert.equal(await verifier.verifyAndConsume(p,enrollment(p)),true);
  assert.equal(await verifier.verifyAndConsume(p,enrollment(p)),false,'one-use CAS cannot replay');
  assert.equal(await verifier.currentReadback(binding(p)),true);
  current={...current,windowsLogonSessionEpoch:randomUUID()};
  assert.equal(await verifier.currentReadback(binding(p)),false,'logon session changed');
  assert.equal(await verifier.currentReadback({...binding(p),windowsLogonSessionEpoch:current.windowsLogonSessionEpoch,
    windowsUserSid:'S-1-5-18'}),false,'owner SID changed');
});

test('response tampering, nonce swaps, wrong receipt and stale signed readback always fail closed',async()=>{
  const p=proofFor(challenge()),c=challenge();
  const variants=[
    (r:CoreNativeWireRequest)=>({...signed(r,p),nonce:randomUUID()}),
    (r:CoreNativeWireRequest)=>({...signed(r,p),observedAtMs:Date.now()-60000}),
    (r:CoreNativeWireRequest)=>({...signed(r,p),proof:{...p,windowsSessionId:33}}),
    (r:CoreNativeWireRequest)=>signed(r,{...p,receiptId:randomUUID()}),
  ];
  for(const response of variants){
    await assert.rejects(local(http(response)).currentReadback(p.receiptId,
      new AbortController().signal));
  }
  await assert.rejects(local(http(r=>signed(r,p))).approveAndConsume(c,
    new AbortController().signal),/CORE_NATIVE_APPROVAL_SCOPE_MISMATCH/);
  assert.equal(await remote(http(r=>({...signed(r,p),nonce:randomUUID()})))
    .currentReadback(binding(p)),false);
  assert.equal(await remote(http(r=>signed(r,p)))
    .verifyAndConsume({...p,windowsLogonLuid:'0000000000000000'},enrollment(p)),false);
});

test('insecure origin, absent trust bootstrap and unresponsive verifier never authorize',async()=>{
  const p=proofFor(challenge());
  const fake=http(r=>signed(r,p));
  const abort=new AbortController();abort.abort();
  await assert.rejects(local(fake).currentReadback(p.receiptId,abort.signal));
  const bad=new ProtectedWindowsCoreConsentClient({
    origin:'https://native-verifier.example',credential:'fixture',pinnedSpkiBase64:pin,fetchImpl:fake});
  await assert.rejects(bad.currentReadback(p.receiptId,new AbortController().signal),
    /CORE_NATIVE_AUTHORITY_ORIGIN_INVALID/);
  assert.equal(await new RemoteTrustedNativeCoreEnrollmentVerifier({
    origin:'http://protected-native-verifier.example',credential:'fixture',pinnedSpkiBase64:pin,
    fetchImpl:fake}).currentReadback(binding(p)),false);
  assert.equal(await remote((async()=>{throw new Error('service unreachable');}) as typeof fetch)
    .currentReadback(binding(p)),false);
});

test('omitted protected transport refuses global fetch fallback before exposing bearer',async()=>{
  const p=proofFor(challenge()),wire:CoreNativeWireRequest={version:1,operation:'current-readback',
    nonce:randomUUID(),expected:{receiptId:p.receiptId}};
  const trust={origin:'https://protected-native-verifier.example',
    credential:'fixture-valid-bearer-only',pinnedSpkiBase64:pin};
  await assert.rejects(callProtectedCoreNativeAuthority(trust,wire),
    /CORE_NATIVE_PROTECTED_TRANSPORT_REQUIRED/);
  const verifier=new RemoteTrustedNativeCoreEnrollmentVerifier(trust);
  assert.equal(await verifier.currentReadback(binding(p)),false,
    'missing transport must fail closed, not silently use global fetch');
});

test('shared authority transport rejects ambiguous HTTP media metadata even with a valid signature',async()=>{
  const p=proofFor(challenge()),wire:CoreNativeWireRequest={version:1,
    operation:'current-readback',nonce:randomUUID(),expected:{receiptId:p.receiptId}};
  const trust={origin:'https://127.0.0.1:18764',credential:'fixture-valid-bearer-only',
    pinnedSpkiBase64:pin};
  const response=(contentType:string,contentEncoding?:string):typeof fetch=>
    (async(_url,init)=>{
      const incoming=JSON.parse(String(init?.body)) as CoreNativeWireRequest;
      return new Response(JSON.stringify(signed(incoming,p)),{status:200,headers:{
        'content-type':contentType,...(contentEncoding?{'content-encoding':contentEncoding}:{})
      }});
    }) as typeof fetch;
  for(const [kind,contentType,contentEncoding] of [
    ['html', 'text/html',undefined],
    ['json-substring', 'text/plain; application/json',undefined],
    ['duplicate', 'application/json, application/json',undefined],
    ['wrong-charset','application/json; charset=iso-8859-1',undefined],
    ['gzip','application/json','gzip'],
    ['duplicate-encoding','application/json','identity, identity'],
  ] as const){
    await assert.rejects(callProtectedCoreNativeAuthority({...trust,
      fetchImpl:response(contentType,contentEncoding)},wire),/CORE_NATIVE_RESPONSE_NOT_JSON/,
    kind);
  }
  for(const [contentType,contentEncoding] of [
    ['application/json',undefined],
    ['application/json; charset=UTF-8','identity'],
  ] as const){
    const value=await callProtectedCoreNativeAuthority({...trust,
      fetchImpl:response(contentType,contentEncoding)},wire);
    assert.deepEqual(value.proof,p);
  }
});

test('signed non-200 success responses are terminal and never accepted as verifier ACK',async()=>{
  const p=proofFor(challenge());
  const wire:CoreNativeWireRequest={version:1,operation:'current-readback',nonce:randomUUID(),
    expected:{receiptId:p.receiptId}};
  const trust={origin:'https://127.0.0.1:18764',
    credential:'fixture-valid-bearer-only',pinnedSpkiBase64:pin};
  for(const status of [201,202,206] as const){
    let dispatched=0;
    const fake=(async(_url,init)=>{
      dispatched++;
      const request=JSON.parse(String(init?.body)) as CoreNativeWireRequest;
      return Response.json(signed(request,p),{status});
    }) as typeof fetch;
    await assert.rejects(callProtectedCoreNativeAuthority({...trust,fetchImpl:fake},wire),
      /CORE_NATIVE_AUTHORITY_UNAVAILABLE/,String(status));
    assert.equal(dispatched,1,'non-200 response never permits a retry');
  }
  const ok=(async(_url,init)=>{
    const request=JSON.parse(String(init?.body)) as CoreNativeWireRequest;
    return Response.json(signed(request,p),{status:200});
  }) as typeof fetch;
  assert.deepEqual((await callProtectedCoreNativeAuthority({...trust,fetchImpl:ok},wire)).proof,p);
});

test('native authority deadline is absolute when injected transport, body or cancel ignores abort',async()=>{
  const p=proofFor(challenge()),request:CoreNativeWireRequest={
    version:1,operation:'current-readback',nonce:randomUUID(),expected:{receiptId:p.receiptId}};
  const trust={origin:'https://127.0.0.1:18764',
    credential:'fixture-valid-bearer-only',pinnedSpkiBase64:pin,timeoutMs:120};
  const bounded=async(work:Promise<unknown>,expected:RegExp)=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      await assert.rejects(Promise.race([work,new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(Error('TEST_NATIVE_AUTHORITY_WATCHDOG_EXPIRED')),900);
      })]),expected);
    }finally{if(timer)clearTimeout(timer)}
  };

  // The first promise ignores both the passed signal and the timeout clock.
  const ignoredFetch=(async()=>new Promise<Response>(()=>{})) as typeof fetch;
  await bounded(callProtectedCoreNativeAuthority({...trust,fetchImpl:ignoredFetch},request),
    /CORE_NATIVE_CALL_ABORTED/);

  // Valid HTTP metadata does not make an unresponsive response body acceptable.
  const stuckBody=new ReadableStream<Uint8Array>({start(){}});
  const ignoredBody=(async()=>new Response(stuckBody,{status:200,
    headers:{'content-type':'application/json'}})) as typeof fetch;
  await bounded(callProtectedCoreNativeAuthority({...trust,fetchImpl:ignoredBody},request),
    /CORE_NATIVE_CALL_ABORTED/);

  // Even stream.cancel() can intentionally never resolve. Bounded rejection
  // must not wait for a remote peer to cooperate with cleanup.
  let cancelCalled=0;
  const oversizedBody=new ReadableStream<Uint8Array>({
    start(c){c.enqueue(new Uint8Array(8193))},
    cancel(){cancelCalled++;return new Promise<void>(()=>{})},
  });
  const ignoredCancel=(async()=>new Response(oversizedBody,{status:200,
    headers:{'content-type':'application/json'}})) as typeof fetch;
  await bounded(callProtectedCoreNativeAuthority({...trust,fetchImpl:ignoredCancel},request),
    /CORE_NATIVE_RESPONSE_TOO_LARGE/);
  assert.equal(cancelCalled,1);
});

test('approval response cannot follow a caller owner/session change during transport await',async()=>{
  const c=challenge(),original={...c};
  const forged=proofFor({...c,ownerAccountId:'other-owner-account',grantGeneration:22});
  const client=local(http(r=>{
    c.ownerAccountId=forged.ownerAccountId;c.grantGeneration=forged.grantGeneration;
    assert.deepEqual(r.expected,original);
    return signed(r,forged);
  }));
  await assert.rejects(client.approveAndConsume(c,new AbortController().signal),
    /CORE_NATIVE_(APPROVAL_SCOPE_MISMATCH|RESPONSE_STALE_OR_UNBOUND)/);
});

test('independent readback cannot match a caller-mutated SID, LUID or receipt',async()=>{
  const p=proofFor(challenge()),expected=binding(p);
  const changed={...p,windowsUserSid:'S-1-5-18',windowsLogonLuid:'000000000000b202',
    receiptId:randomUUID()};
  const verifier=remote(http(r=>{
    expected.windowsUserSid=changed.windowsUserSid;
    expected.windowsLogonLuid=changed.windowsLogonLuid;
    expected.nativeConsentReceiptId=changed.receiptId;
    return signed(r,changed);
  }));
  assert.equal(await verifier.currentReadback(expected),false);
});

test('in-flight signing pin replacement cannot authenticate another issuer',async()=>{
  const p=proofFor(challenge()),replacement=generateKeyPairSync('ed25519');
  const trust={origin:'https://127.0.0.1:18764',credential:'fixture-test-only',
    pinnedSpkiBase64:pin,fetchImpl:undefined as typeof fetch|undefined};
  trust.fetchImpl=http(r=>{
    trust.pinnedSpkiBase64=replacement.publicKey.export({type:'spki',format:'der'}).toString('base64');
    const data={version:1 as const,operation:r.operation,nonce:r.nonce,
      requestSha256:coreNativeWireRequestHash(r),observedAtMs:Date.now(),accepted:true,proof:p};
    return {...data,signatureBase64:sign(null,coreNativeSignedResponseBytes(data),
      replacement.privateKey).toString('base64')};
  });
  await assert.rejects(callProtectedCoreNativeAuthority(trust,
    {version:1,operation:'current-readback',nonce:randomUUID(),expected:{receiptId:p.receiptId}}),
    /CORE_NATIVE_SIGNED_RESPONSE_REQUIRED/);
});

test('valid original signed response survives later mutation of caller-owned nested request',async()=>{
  const p=proofFor(challenge());
  const request:CoreNativeWireRequest={version:1,operation:'current-readback',nonce:randomUUID(),
    expected:{receiptId:p.receiptId,nested:{generation:1},list:[1,2]}};
  const fetcher=http(r=>{
    const expected=request.expected as {receiptId:string;nested:{generation:number};list:number[]};
    expected.receiptId=randomUUID();expected.nested.generation=99;expected.list.push(3);
    request.nonce=randomUUID();
    return signed(r,p);
  });
  const response=await callProtectedCoreNativeAuthority({origin:'https://127.0.0.1:18764',
    credential:'fixture-test-only',pinnedSpkiBase64:pin,fetchImpl:fetcher},request);
  assert.deepEqual(response.proof,p);
});

test('native request snapshot is detached, deeply immutable, bounded and rejects cycles',()=>{
  const value:CoreNativeWireRequest={version:1,operation:'current-readback',nonce:randomUUID(),
    expected:{nested:{items:[1,2]}}};
  const frozen=snapshotCoreNativeWireRequest(value);
  assert.notEqual(frozen,value);assert.notEqual(frozen.expected,value.expected);
  assert.equal(Object.isFrozen(frozen),true);
  const nested=(frozen.expected as {nested:{items:number[]}}).nested;
  assert.equal(Object.isFrozen(nested.items),true);
  assert.throws(()=>nested.items.push(3),TypeError);
  assert.throws(()=>snapshotCoreNativeWireRequest({...value,expected:'x'.repeat(16384)}),
    /CORE_NATIVE_REQUEST_TOO_LARGE/);
  const cycle:{self?:unknown}={};cycle.self=cycle;
  assert.throws(()=>snapshotCoreNativeWireRequest({...value,expected:cycle}),
    /CORE_NATIVE_WIRE_NESTING_LIMIT/);
});
