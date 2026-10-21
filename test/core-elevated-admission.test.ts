import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {
 inspectBrokerTokenProofCandidate,brokerTokenReceiptSigningBytes,
 explainBroadAdminDelegation,type BrokerNativeTokenReceipt,
 type ElevatedAdmissionSnapshot,type BroadAdminOperation,
} from '../src/security/core-elevated-admission.js';
import type {CoreDelegationCandidate} from '../src/security/core-admin-delegation.js';

const pair=generateKeyPairSync('ed25519');
const img='b'.repeat(64),cred='a'.repeat(64);
const receipt=():BrokerNativeTokenReceipt=>{
 const input={
  kind:'nexowire.broker.high-token.v1' as const,
  deviceId:'naveax',ownerAccountId:'owner',credentialHash:cred,
  brokerImageSha256:img,brokerVersion:'1.0.5',
  brokerPid:5550,brokerCreationFiletime:'133999100100100100',
  reportIntegrity:'high' as const,administratorsEnabled:true,
  taskIdentitySha256:'c'.repeat(64),
  parentAndImporterAclSha256:'d'.repeat(64),
  issuedAt:'2026-10-21T13:00:00.000Z',
 };
 return {...input,signature:sign(null,brokerTokenReceiptSigningBytes(input),pair.privateKey).toString('base64url')};
};
const trust=(patch:Record<string,unknown>={})=>({
 deviceId:'naveax',ownerAccountId:'owner',credentialHash:cred,
 brokerImageSha256:img,brokerVersion:'1.0.5',
 actualPid:5550,actualCreationFiletime:'133999100100100100',
 taskIdentitySha256:'c'.repeat(64),parentAndImporterAclSha256:'d'.repeat(64),
 nativeTokenEnabledAdmin:true,nativeHighIntegrity:true,
 independentlyTrustedSourceAcl:true,
 independentPublisherAndImageVerified:true,
 authenticatedBrokerChannel:true,
 now:new Date('2026-10-21T13:00:01.000Z'),publicKey:pair.publicKey,...patch,
});
const enrollment:CoreDelegationCandidate={
 enrollmentId:'11111111-1111-4111-8111-111111111111',
 deviceId:'naveax',ownerAccountId:'owner',credentialHash:cred,
 generation:1,brokerImageSha256:img,brokerVersion:'1.0.5',
 signerKeySha256:'e'.repeat(64),localConsentEvidenceSha256:'f'.repeat(64),
 enrolledAt:'2026-10-21T12:00:00.000Z',productionPrivilegeAttested:false,
};
const now=new Date('2026-10-21T13:00:01.000Z');
const candidate=(override:Partial<ElevatedAdmissionSnapshot>={}):ElevatedAdmissionSnapshot=>({
 mode:'core',requestedOperation:'admin.shell',
 currentAccountIsOwner:true,currentDevicePairingVerified:true,
 currentOwnerSessionAuthenticated:true,currentOwnerSessionRevoked:false,
 corePreferenceSelected:true,currentCoreEnrollment:enrollment,
 rootGrantSessionBound:false,rootIssuedAt:null,rootExpiresAt:null,
 brokerTokenCandidateValid:true,brokerAuthenticatedVersionMatched:true,
 protectedBrokerAndUpdaterVerified:true,providerPolicyAllowed:true,
 requestAlreadyReserved:false,priorMutationState:'not-sent',now,...override,
});

test('signed native Broker high token source report is cryptographic candidate, not OS proof',()=>{
 const r=inspectBrokerTokenProofCandidate(receipt(),trust());
 assert.equal(r.status,'BROKER_SOURCE_PROOF_CANDIDATE');
 assert.equal(r.effectiveWindowsTokenProven,false);
 assert.match(r.sourceIdentitySha256,/^[0-9a-f]{64}$/);
});

test('medium, deny-only Administrators, bad image, replaced Broker or unauth health cannot pass',()=>{
 const input=receipt();
 for(const value of [
  {reportIntegrity:'medium' as const},{administratorsEnabled:false},
 ]){
  assert.throws(()=>inspectBrokerTokenProofCandidate({...input,...value} as BrokerNativeTokenReceipt,trust()));
 }
 for(const context of [
  {nativeTokenEnabledAdmin:false},{nativeHighIntegrity:false},
  {independentlyTrustedSourceAcl:false},
  {independentPublisherAndImageVerified:false},
  {authenticatedBrokerChannel:false},
  {brokerVersion:'1.0.4'},{actualPid:9999},
  {actualCreationFiletime:'133999100100100101'},
  {parentAndImporterAclSha256:'e'.repeat(64)},
  {now:new Date('2026-10-21T13:01:00.000Z')},
 ]){
  assert.throws(()=>inspectBrokerTokenProofCandidate(input,trust(context)));
 }
 assert.throws(()=>inspectBrokerTokenProofCandidate({...input,brokerImageSha256:'e'.repeat(64)},trust()));
 assert.throws(()=>inspectBrokerTokenProofCandidate({...input,signature:'A'.repeat(86)},trust()));
});

test('FULL remains standard and SAFE remains bounded regardless of Broker reported readiness',()=>{
 for(const mode of ['full','safe'] as const){
  const r=explainBroadAdminDelegation(candidate({mode}));
  assert.equal(r.status,'DENIED');
  assert.equal(r.canDispatch,false);
  assert.equal(r.noAdditionalPerCommandUacWhenDelegated,false);
 }
});

test('CORE persists in source candidate across reconnect, no per-command UAC, broad admin verbs',()=>{
 const operations:BroadAdminOperation[]=[
  'admin.shell','admin.powershell','admin.filesystem','admin.registry',
  'admin.service','admin.process','admin.hyperv',
 ];
 for(const op of operations){
  const r=explainBroadAdminDelegation(candidate({requestedOperation:op}));
  assert.equal(r.status,'DELEGATION_CANDIDATE',op);
  assert.equal(r.noAdditionalPerCommandUacWhenDelegated,true,op);
  assert.equal(r.broadOperationSupported,true,op);
  assert.equal(r.productionElevationProven,false,op);
  assert.equal(r.canDispatch,false,op); // no installed Broker executor integrated
 }
});

test('ROOT same broad elevation, strictly fifteen-minute owner session grant',()=>{
 const r=explainBroadAdminDelegation(candidate({
  mode:'root',corePreferenceSelected:false,currentCoreEnrollment:null,
  rootGrantSessionBound:true,
  rootIssuedAt:'2026-10-21T12:55:00.000Z',
  rootExpiresAt:'2026-10-21T13:10:00.000Z',
 }));
 assert.equal(r.status,'DELEGATION_CANDIDATE');
 assert.equal(r.noAdditionalPerCommandUacWhenDelegated,true);
 for(const root of [
  {rootExpiresAt:'2026-10-21T13:00:01.000Z'},
  {rootExpiresAt:'2026-10-21T13:12:00.000Z'},
  {rootGrantSessionBound:false},
 ]){
  assert.equal(explainBroadAdminDelegation(candidate({
   mode:'root',rootIssuedAt:'2026-10-21T12:55:00.000Z',
   rootExpiresAt:'2026-10-21T13:10:00.000Z',
   rootGrantSessionBound:true,...root,
  })).status,'BLOCKED');
 }
});

test('CORE revocation, owner/session logout/re-pair, missing installed Broker and ACL independently deny',()=>{
 for(const value of [
  {corePreferenceSelected:false},{currentCoreEnrollment:null},
  {currentOwnerSessionAuthenticated:false},
  {currentOwnerSessionRevoked:true},
  {currentAccountIsOwner:false},{currentDevicePairingVerified:false},
  {brokerTokenCandidateValid:false},{brokerAuthenticatedVersionMatched:false},
  {protectedBrokerAndUpdaterVerified:false},{providerPolicyAllowed:false},
  {requestAlreadyReserved:true},
 ]){
  const r=explainBroadAdminDelegation(candidate(value));
  assert.notEqual(r.status,'DELEGATION_CANDIDATE');
  assert.equal(r.noAdditionalPerCommandUacWhenDelegated,false);
  assert.equal(r.canDispatch,false);
 }
});

test('unknown mutation always reconciles first, never second shell/PowerShell dispatch',()=>{
 for(const op of ['admin.shell','admin.powershell','admin.hyperv'] as const){
  const r=explainBroadAdminDelegation(candidate({
   requestedOperation:op,priorMutationState:'unknown',
   currentAccountIsOwner:false,
  }));
  assert.equal(r.status,'MUTATION_STATE_UNKNOWN');
  assert.equal(r.automaticallyRetryable,false);
  assert.equal(r.canDispatch,false);
 }
});

test('generic elevated permission remains bounded to typed administrative categories',()=>{
 assert.throws(()=>explainBroadAdminDelegation(candidate({
  requestedOperation:'os.disable-uac' as BroadAdminOperation,
 })),/CORE_OPERATION_INVALID/);
});
