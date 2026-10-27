import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {ProtectedWindowsCoreConsentClient} from '../src/agent/windows-core-consent-transport.js';
import {RemoteTrustedNativeCoreEnrollmentVerifier} from '../src/product/core-native-consent-verifier.js';
import {coreNativeSignedResponseBytes,coreNativeWireRequestHash,
  type CoreNativeProof,type CoreNativeWireRequest} from '../src/protocol/core-native-consent-transport.js';

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
  const signatureBase64=sign(null,coreNativeSignedResponseBytes(data as ReturnType<typeof typedReply>),
    signer.privateKey).toString('base64');
  return {...data,signatureBase64};
}
function typedReply(){
  return {version:1 as const,operation:'current-readback' as const,nonce:'',
    requestSha256:'',observedAtMs:0,accepted:false,proof:null as CoreNativeProof|null};
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
