import {createHash,verify,type KeyObject} from 'node:crypto';
import type {CoreDelegationCandidate} from './core-admin-delegation.js';

const sha=/^[0-9a-f]{64}$/;
const version=/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
export interface BrokerNativeTokenReceipt {
 kind:'nexowire.broker.high-token.v1';
 deviceId:string;
 ownerAccountId:string;
 credentialHash:string;
 brokerImageSha256:string;
 brokerVersion:string;
 brokerPid:number;
 brokerCreationFiletime:string;
 reportIntegrity:'high'|'system'|'medium'|'unknown';
 administratorsEnabled:boolean;
 taskIdentitySha256:string;
 parentAndImporterAclSha256:string;
 issuedAt:string;
 signature:string;
}
export interface TrustedNativeBrokerInspection {
 deviceId:string;ownerAccountId:string;credentialHash:string;
 brokerImageSha256:string;brokerVersion:string;
 actualPid:number;actualCreationFiletime:string;
 taskIdentitySha256:string;
 parentAndImporterAclSha256:string;
 /** Data MUST come from independent native Windows token/handle inspection. */
 nativeTokenEnabledAdmin:boolean;
 nativeHighIntegrity:boolean;
 independentlyTrustedSourceAcl:boolean;
 independentPublisherAndImageVerified:boolean;
 authenticatedBrokerChannel:boolean;
 now:Date;
 publicKey:KeyObject;
}
export function brokerTokenReceiptSigningBytes(r:Omit<BrokerNativeTokenReceipt,'signature'>):Buffer{
 return Buffer.from(JSON.stringify([
  r.kind,r.deviceId,r.ownerAccountId,r.credentialHash,r.brokerImageSha256,
  r.brokerVersion,r.brokerPid,r.brokerCreationFiletime,r.reportIntegrity,
  r.administratorsEnabled,r.taskIdentitySha256,r.parentAndImporterAclSha256,r.issuedAt,
 ]),'utf8');
}
export function inspectBrokerTokenProofCandidate(
 raw:BrokerNativeTokenReceipt,local:TrustedNativeBrokerInspection,
):Readonly<{status:'BROKER_SOURCE_PROOF_CANDIDATE';effectiveWindowsTokenProven:false;sourceIdentitySha256:string}> {
 const deny=(why:string):never=>{throw new Error('CORE_BROKER_'+why)}
 if(!raw || !local || raw.kind!=='nexowire.broker.high-token.v1' ||
  raw.deviceId!==local.deviceId || raw.ownerAccountId!==local.ownerAccountId ||
  raw.credentialHash!==local.credentialHash || raw.brokerImageSha256!==local.brokerImageSha256 ||
  raw.brokerVersion!==local.brokerVersion || !version.test(raw.brokerVersion) ||
  !sha.test(raw.credentialHash)||!sha.test(raw.brokerImageSha256) ||
  !sha.test(raw.taskIdentitySha256)||!sha.test(raw.parentAndImporterAclSha256)||
  raw.brokerPid!==local.actualPid || raw.brokerCreationFiletime!==local.actualCreationFiletime ||
  raw.taskIdentitySha256!==local.taskIdentitySha256 ||
  raw.parentAndImporterAclSha256!==local.parentAndImporterAclSha256){
  deny('IDENTITY_MISMATCH');
 }
 if(raw.reportIntegrity!=='high' && raw.reportIntegrity!=='system')deny('MEDIUM_OR_UNKNOWN');
 if(!raw.administratorsEnabled || !local.nativeTokenEnabledAdmin ||
  !local.nativeHighIntegrity)deny('ADMIN_TOKEN_NOT_PROVEN');
 if(!local.independentlyTrustedSourceAcl || !local.independentPublisherAndImageVerified ||
  !local.authenticatedBrokerChannel)deny('SOURCE_OR_CHANNEL_UNTRUSTED');
 const now=local.now.getTime(),issued=Date.parse(raw.issuedAt);
 if(!Number.isFinite(now)||!Number.isFinite(issued)||now<issued-3000||
  now-issued>15000)deny('STALE');
 if(local.publicKey.type!=='public' ||local.publicKey.asymmetricKeyType!=='ed25519')deny('KEY');
 const sig=Buffer.from(raw.signature,'base64url');
 const {signature:_ignore,...fields}=raw;
 if(sig.length!==64||sig.toString('base64url')!==raw.signature||
  !verify(null,brokerTokenReceiptSigningBytes(fields),local.publicKey,sig))deny('BAD_SIGNATURE');
 return Object.freeze({
  status:'BROKER_SOURCE_PROOF_CANDIDATE' as const,
  effectiveWindowsTokenProven:false as const,
  sourceIdentitySha256:createHash('sha256').update(brokerTokenReceiptSigningBytes(fields)).digest('hex'),
 });
}

export type NexowireAccessMode='safe'|'full'|'root'|'core';
export type BroadAdminOperation=
 | 'admin.shell'|'admin.powershell'|'admin.filesystem'|'admin.registry'
 | 'admin.service'|'admin.process'|'admin.hyperv';
export interface ElevatedAdmissionSnapshot {
 mode:NexowireAccessMode;
 requestedOperation:BroadAdminOperation;
 currentAccountIsOwner:boolean;
 currentDevicePairingVerified:boolean;
 currentOwnerSessionAuthenticated:boolean;
 currentOwnerSessionRevoked:boolean;
 corePreferenceSelected:boolean;
 /** Durable device-bound candidate obtained from fresh ledger read. */
 currentCoreEnrollment:CoreDelegationCandidate|null;
 rootGrantSessionBound:boolean;
 rootIssuedAt:string|null;
 rootExpiresAt:string|null;
 brokerTokenCandidateValid:boolean;
 brokerAuthenticatedVersionMatched:boolean;
 protectedBrokerAndUpdaterVerified:boolean;
 providerPolicyAllowed:boolean;
 requestAlreadyReserved:boolean;
 priorMutationState:'not-sent'|'unknown'|'resolved';
 now:Date;
}
export type ElevatedAdmissionResult=Readonly<{
 status:'DENIED'|'BLOCKED'|'DELEGATION_CANDIDATE'|'MUTATION_STATE_UNKNOWN';
 reasons:readonly string[];
 mode:NexowireAccessMode;
 broadOperationSupported:boolean;
 /** Candidate means valid scope in a fixture, NOT an executable allow signal. */
 noAdditionalPerCommandUacWhenDelegated:boolean;
 canDispatch:false;
 productionElevationProven:false;
 automaticallyRetryable:false;
}>;
/**
 * Broad Windows administrative scope is intentionally NOT confined to VM IDs.
 * It does not execute commands, grant shell access, waive provider policy or
 * assert local proof from a remote claim.
 */
export function explainBroadAdminDelegation(s:ElevatedAdmissionSnapshot):ElevatedAdmissionResult{
 if(!['safe','full','root','core'].includes(s.mode)||
    !['admin.shell','admin.powershell','admin.filesystem','admin.registry',
      'admin.service','admin.process','admin.hyperv'].includes(s.requestedOperation)){
  throw new Error('CORE_OPERATION_INVALID');
 }
 const reason:string[]=[];
 const time=s.now.getTime();
 if(!Number.isFinite(time))throw new Error('CORE_CLOCK_INVALID');
 if(!s.currentAccountIsOwner||!s.currentDevicePairingVerified)
  reason.push('OWNER_DEVICE_SCOPE_UNVERIFIED');
 if(!s.currentOwnerSessionAuthenticated||s.currentOwnerSessionRevoked)
  reason.push('CURRENT_LOGIN_MISSING_OR_REVOKED');
 if(s.mode==='safe')reason.push('SAFE_ELEVATION_DENIED');
 if(s.mode==='full')reason.push('FULL_STANDARD_TOKEN_ONLY');
 if(s.mode==='root'){
  const issued=Date.parse(s.rootIssuedAt??''),expires=Date.parse(s.rootExpiresAt??'');
  if(!s.rootGrantSessionBound||!Number.isFinite(issued)||!Number.isFinite(expires)||
   issued>time+3000||expires<=time||expires<=issued||
   expires-issued>15*60*1000){
   reason.push('ROOT_15_MINUTE_GRANT_UNVERIFIED');
  }
 }
 if(s.mode==='core' && (!s.corePreferenceSelected||!s.currentCoreEnrollment))
  reason.push('CORE_DURABLE_ENROLLMENT_NOT_VERIFIED');
 if(!s.brokerTokenCandidateValid||!s.brokerAuthenticatedVersionMatched)
  reason.push('BROKER_HIGH_TOKEN_OR_VERSION_UNVERIFIED');
 if(!s.protectedBrokerAndUpdaterVerified)reason.push('PROTECTED_SOURCE_ACL_OR_INSTALLER_BLOCKED');
 if(!s.providerPolicyAllowed)reason.push('PROVIDER_POLICY_DENIED');
 if(s.requestAlreadyReserved)reason.push('REQUEST_REPLAY');
 const unknown=s.priorMutationState==='unknown';
 const status=unknown?'MUTATION_STATE_UNKNOWN':
  s.mode==='safe'||s.mode==='full'||!s.currentAccountIsOwner||
  !s.currentDevicePairingVerified||s.currentOwnerSessionRevoked?'DENIED':
  reason.length?'BLOCKED':'DELEGATION_CANDIDATE';
 return Object.freeze({
  mode:s.mode,status,reasons:Object.freeze(reason),
  broadOperationSupported:true,
  noAdditionalPerCommandUacWhenDelegated:status==='DELEGATION_CANDIDATE'&&
    (s.mode==='root'||s.mode==='core'),
  canDispatch:false,
  productionElevationProven:false,
  automaticallyRetryable:false,
 });
}
