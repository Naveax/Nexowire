import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {
  localApprovalSigningBytes,verifyScopedLocalApproval,explainScopedHypervAuthority,
  type LocalApprovalFields,type HypervAuthorityFacts,
} from '../src/security/hyperv-local-approval-authority.js';

const keys=generateKeyPairSync('ed25519');
const other=generateKeyPairSync('ed25519');
const VM='3a4b5c6d-7e8f-4091-a2b3-4c5d6e7f8090';
const REQUEST='11111111-1111-4111-8111-111111111111';
const now=new Date('2026-10-21T12:00:25.000Z');
const facts:LocalApprovalFields={
  kind:'nexowire.hyperv.local-approval.v1',
  requestId:REQUEST,deviceId:'naveax-fixture',ownerAccountId:'owner-a',
  vmId:VM,capability:'hyperv.vm.start',
  policySha256:'a'.repeat(64),pairedCredentialSha256:'b'.repeat(64),
  brokerVersion:'1.0.5',localUserSid:'S-1-5-21-100-200-300-1001',
  nonce:randomBytes(32).toString('base64url'),
  issuedAt:'2026-10-21T12:00:00.000Z',
  expiresAt:'2026-10-21T12:01:00.000Z',
  claimedLocalConsent:'visible-user-consent',
};
const trusted=(patch:Record<string,unknown>={})=>({
  requestId:facts.requestId,deviceId:facts.deviceId,
  ownerAccountId:facts.ownerAccountId,vmId:facts.vmId,
  capability:facts.capability,policySha256:facts.policySha256,
  pairedCredentialSha256:facts.pairedCredentialSha256,
  brokerVersion:facts.brokerVersion,localUserSid:facts.localUserSid,
  registeredLocalPublicKey:keys.publicKey,
  now,wasRequestConsumed:()=>false,
  ...patch,
});
const signed=(f:LocalApprovalFields=facts,otherSigner=keys.privateKey)=>({
  ...f,signature:sign(null,localApprovalSigningBytes(f),otherSigner).toString('base64url'),
});

test('Ed25519 signed exact owner/device/VM GUID policy binds scope but never proves UAC/elevation',()=>{
  const result=verifyScopedLocalApproval(signed(),trusted());
  assert.equal(result.signatureAndScopeVerified,true);
  assert.equal(result.requestId,REQUEST);
  assert.match(result.publicKeySha256,/^[a-f0-9]{64}$/);
  assert.equal(result.physicalUacVerified,false);
  assert.equal(result.WindowsTokenAttested,false);
  assert.equal(result.productionExecutionAllowed,false);
  assert.equal(Object.isFrozen(result),true);
});

test('independently changed VM GUID, device, owner, operation, policy, credential and version fail closed',()=>{
  const proof=signed();
  for(const entry of [
    {vmId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'},
    {deviceId:'work-pc'}, {ownerAccountId:'different-owner'},
    {capability:'hyperv.vm.stop'}, {policySha256:'c'.repeat(64)},
    {pairedCredentialSha256:'c'.repeat(64)},
    {brokerVersion:'1.0.4'}, {requestId:'22222222-2222-4222-8222-222222222222'},
    {localUserSid:'S-1-5-21-100-200-300-1002'},
  ])assert.throws(()=>verifyScopedLocalApproval(proof,trusted(entry)),/LOCAL_APPROVAL_SCOPE_MISMATCH/);
});

test('signed wrong VM operation and altered nonce cannot replay approval for another target',()=>{
  const proof=signed();
  for(const tamper of [
    {vmId:'22222222-2222-4222-8222-222222222222'},
    {capability:'hyperv.vm.stop'},
    {nonce:randomBytes(32).toString('base64url')},
    {claimedLocalConsent:'silent-network-consent'},
    {requestId:'22222222-2222-4222-8222-222222222222'},
  ])assert.throws(()=>verifyScopedLocalApproval({...proof,...tamper},trusted()));
});

test('untrusted local signing key and key rotation fail; no inbound key enrollment',()=>{
  assert.throws(()=>verifyScopedLocalApproval(signed(),trusted({
    registeredLocalPublicKey:other.publicKey,
  })),/LOCAL_APPROVAL_BAD_SIGNATURE/);
  assert.throws(()=>verifyScopedLocalApproval(signed(facts,other.privateKey),trusted()),
    /LOCAL_APPROVAL_BAD_SIGNATURE/);
  assert.throws(()=>verifyScopedLocalApproval(signed(),trusted({
    registeredLocalPublicKey:keys.privateKey,
  })),/LOCAL_APPROVAL_SIGNER_UNTRUSTED/);
});

test('replayed and expired local approvals reject; time rollback and long-lived approval reject',()=>{
  const proof=signed();
  assert.throws(()=>verifyScopedLocalApproval(proof,trusted({wasRequestConsumed:()=>true})),
    /LOCAL_APPROVAL_REPLAY/);
  for(const at of ['2026-10-21T12:01:00.000Z','2026-10-21T11:59:54.000Z']){
    assert.throws(()=>verifyScopedLocalApproval(proof,trusted({now:new Date(at)})),
      /LOCAL_APPROVAL_EXPIRED_OR_UNTRUSTED_CLOCK/);
  }
  const extended={...facts,expiresAt:'2026-10-21T12:05:00.000Z'};
  assert.throws(()=>verifyScopedLocalApproval(signed(extended),trusted()),
    /LOCAL_APPROVAL_EXPIRED_OR_UNTRUSTED_CLOCK/);
});

test('extra fields, noncanonical VM guid, wildcard, shell targets and zero nonce are denied',()=>{
  const proof=signed();
  assert.throws(()=>verifyScopedLocalApproval({...proof,canBypassUac:true},trusted()));
  for(const vmId of ['*','ReVoltVPN-Ubuntu-Lab',VM.toUpperCase(),VM+';Stop-VM','C:\\VM']){
    assert.throws(()=>verifyScopedLocalApproval(signed({...facts,vmId}),trusted()));
  }
  assert.throws(()=>verifyScopedLocalApproval(
    signed({...facts,nonce:Buffer.alloc(32).toString('base64url')}),trusted()),
    /LOCAL_APPROVAL_NONCE_INVALID/);
});

const candidate=():HypervAuthorityFacts=>({
  capability:'hyperv.vm.start',
  ownerPolicyExactVmGuid:true,
  ownerDevicePairingCurrent:true,
  scopedApprovalCryptographicallyMatched:true,
  localUacConsent:'physically-verified',
  windowsToken:'high-enabled-admin',
  brokerHealth:'authenticated-pinned',
  brokerVersion:'matched-pinned',
  protectedAcl:'verified-by-independent-observer',
  guardian:'independently-attested',
  providerPolicy:'allowed-independently',
  dispatch:'not-sent',
});

test('even all synthetic truth flags never authorize dispatch or verified VM effect',()=>{
  const r=explainScopedHypervAuthority(candidate());
  assert.equal(r.state,'CANDIDATE_ONLY');
  assert.equal(r.canExecute,false);
  assert.equal(r.effectVerified,false);
  assert.equal(r.automaticallyRetryable,false);
  assert.equal(r.windowsElevationProvenByPreference,false);
  assert.equal(r.health401ProvesElevation,false);
});

test('medium integrity admin deny-only, 401 health and unpinned version independently deny',()=>{
  const base=candidate();
  for(const patch of [
    {windowsToken:'medium-deny-only'},
    {brokerHealth:'unauthenticated-401'},
    {brokerVersion:'mismatch'},
    {protectedAcl:'unsafe-inherited-modify'},
    {localUacConsent:'pending'},
    {ownerPolicyExactVmGuid:false},
    {ownerDevicePairingCurrent:false},
    {scopedApprovalCryptographicallyMatched:false},
    {guardian:'unknown'}, {providerPolicy:'unverified'},
  ]){
    const result=explainScopedHypervAuthority({...base,...patch} as HypervAuthorityFacts);
    assert.equal(result.state,'BLOCKED');
    assert.ok(result.reasons.length>0);
    assert.equal(result.canExecute,false);
  }
});

test('401 Broker health is unauthenticated even while Hyper-V services are Running',()=>{
  const r=explainScopedHypervAuthority({
    ...candidate(),windowsToken:'medium-deny-only',
    brokerHealth:'unauthenticated-401',protectedAcl:'unsafe-inherited-modify',
  });
  assert.ok(r.reasons.includes('WINDOWS_ADMIN_ENABLED_TOKEN_UNVERIFIED'));
  assert.ok(r.reasons.includes('BROKER_HEALTH_NOT_AUTHENTICATED'));
  assert.ok(r.reasons.includes('PROTECTED_SOURCE_ACL_UNVERIFIED'));
  assert.equal(r.canExecute,false);
});

test('UNKNOWN mutation/ACK beats denied policy; never replay a potentially dispatched VM command',()=>{
  for(const dispatch of ['lost-confirmation','ack-unverified'] as const){
    const r=explainScopedHypervAuthority({
      ...candidate(),ownerDevicePairingCurrent:false,
      brokerHealth:'unauthenticated-401',dispatch,
    });
    assert.equal(r.state,'MUTATION_STATE_UNKNOWN');
    assert.equal(r.effectVerified,false);
    assert.equal(r.automaticallyRetryable,false);
  }
});
