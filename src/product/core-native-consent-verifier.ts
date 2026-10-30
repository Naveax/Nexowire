import {randomUUID} from 'node:crypto';
import {CoreNativeProofSchema,callProtectedCoreNativeAuthority,snapshotCoreNativeWireRequest,
  type CoreNativeProof,type CoreNativeWireRequest} from '../protocol/core-native-consent-transport.js';
import type {TrustedNativeCoreEnrollmentVerifier} from './d1-core-console-authority.js';

type ExpectedConsent=Parameters<TrustedNativeCoreEnrollmentVerifier['verifyAndConsume']>[1];
type NativeBinding=Parameters<TrustedNativeCoreEnrollmentVerifier['currentReadback']>[0];
type IncomingProof=Parameters<TrustedNativeCoreEnrollmentVerifier['verifyAndConsume']>[0];

function sameFields<T extends object>(actual:object,expected:T):boolean {
  const a=actual as Record<string,unknown>,e=expected as Record<string,unknown>;
  return Object.keys(e).every(k=>a[k]===e[k]);
}

/** Independent HTTPS *native verifier* adapter for D1.
 * The service behind this URL MUST resolve the provisioned owner SID,
 * validate the live WTS session and token AuthenticationId LUID, maintain
 * a rollback-resistant one-use CAS, and sign a nonce-bound response using
 * a key not held by the Agent or D1. Merely placing an Agent HTTP service
 * at this URL is a trust-boundary violation.
 *
 * This class is intentionally NOT auto-wired in the production Worker. Until
 * an audited off-host verifier and its pinned key are provisioned, D1's
 * default verifier remains undefined and enrollment fails closed. */
export class RemoteTrustedNativeCoreEnrollmentVerifier implements TrustedNativeCoreEnrollmentVerifier {
  constructor(private readonly trust:{
    origin:string;credential:string;pinnedSpkiBase64:string;
    fetchImpl?:typeof fetch;timeoutMs?:number;
  }){}
  private async check(operation:CoreNativeWireRequest['operation'],expected:unknown,
    match:(proof:CoreNativeProof)=>boolean):Promise<boolean>{
    try {
      const request={version:1 as const,operation,nonce:randomUUID(),expected};
      const response=await callProtectedCoreNativeAuthority(this.trust,request);
      if(!response.proof)return false;
      return match(CoreNativeProofSchema.parse(response.proof));
    }catch{return false;}
  }
  async verifyAndConsume(proof:IncomingProof,expected:ExpectedConsent):Promise<boolean>{
    // All matching is still performed by D1 before this call. Repeat it at the
    // transport boundary so misconfigured direct callers cannot pass a scope.
    const local=CoreNativeProofSchema.safeParse(proof);
    if(!local.success||!sameFields(local.data,{
      ownerAccountId:expected.ownerAccountId,deviceId:expected.deviceId,
      installationId:expected.installationId,enrollmentId:expected.enrollmentId,
      ownerEpoch:expected.ownerEpoch,grantGeneration:expected.grantGeneration,
      revokeEpoch:expected.revokeEpoch,approvedAtMs:expected.approvedLocallyAtMs,
    }))return false;
    return this.check('verify-and-consume',{proof:local.data,expected},
      candidate=>sameFields(candidate,local.data));
  }
  async currentReadback(binding:NativeBinding):Promise<boolean>{
    let original:NativeBinding;
    try{original=snapshotCoreNativeWireRequest({version:1,operation:'current-readback',
      nonce:randomUUID(),expected:binding}).expected as NativeBinding;}
    catch{return false;}
    return this.check('current-readback',original,candidate=>sameFields(candidate,{
      ownerAccountId:original.ownerAccountId,deviceId:original.deviceId,
      installationId:original.installationId,enrollmentId:original.enrollmentId,
      ownerEpoch:original.ownerEpoch,grantGeneration:original.grantGeneration,
      revokeEpoch:original.revokeEpoch,receiptId:original.nativeConsentReceiptId,
      windowsUserSid:original.windowsUserSid,windowsSessionId:original.windowsSessionId,
      windowsLogonLuid:original.windowsLogonLuid,
      windowsLogonSessionEpoch:original.windowsLogonSessionEpoch,
    }));
  }
}
