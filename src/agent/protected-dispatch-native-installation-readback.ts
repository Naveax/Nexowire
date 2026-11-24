import {createPublicKey,randomUUID} from 'node:crypto';
import * as z from 'zod';
import {CoreNativeProofSchema,callProtectedCoreNativeAuthority}
  from '../protocol/core-native-consent-transport.js';
import {createCoreNativeMtlsFetch} from '../security/core-native-mtls-fetch.js';
import type {ProtectedDispatchCredentialRecord} from './protected-broker-dispatch-service.js';
import {startBrokerDispatchWithPostgresCredentials} from './postgres-dispatch-credential-store.js';

const uuid=z.string().uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/);
const nativeBinding=CoreNativeProofSchema.pick({ownerAccountId:true,deviceId:true,
  installationId:true,enrollmentId:true,ownerEpoch:true,grantGeneration:true,revokeEpoch:true,
  windowsUserSid:true,windowsSessionId:true,windowsLogonLuid:true,windowsLogonSessionEpoch:true})
  .extend({nativeConsentReceiptId:uuid});
const mapping=z.strictObject({credentialSha256:sha,certificateSha256:sha,brokerId:uuid,
  ownerId:uuid,deviceId:uuid,installationId:uuid,deviceEpoch:uuid,sessionEpoch:uuid,
  nativeBinding});
export type ProtectedDispatchNativeBinding=z.infer<typeof mapping>;
type NativeTls=Parameters<typeof createCoreNativeMtlsFetch>[0];
export interface DispatchNativeReadbackProvisioning {
  readonly binding:ProtectedDispatchNativeBinding;
  readonly verifier:NativeTls&{credential:string;pinnedSpkiBase64:string};
}

const scopeKeys=['credentialSha256','certificateSha256','brokerId','ownerId','deviceId',
  'installationId','deviceEpoch','sessionEpoch'] as const;

/** Read-only connection to the independent enrollment verifier. The mapping is
 * provisioned by the protected operator, not derived from bearer, Agent data,
 * matching-looking UUIDs or the verifier response. Enrollment evidence does
 * NOT prove Broker elevation, authorize a dispatch or prove native drain. */
export function createProtectedDispatchInstallationReadback(
  records:readonly DispatchNativeReadbackProvisioning[],
):(record:ProtectedDispatchCredentialRecord,signal:AbortSignal)=>Promise<boolean>{
  if(!Array.isArray(records)||records.length<1||records.length>4096)
    throw Error('DISPATCH_NATIVE_READBACK_PROVISIONING_REQUIRED');
  type Entry={binding:Readonly<ProtectedDispatchNativeBinding>;
    trust:Readonly<Parameters<typeof callProtectedCoreNativeAuthority>[0]>};
  const byDigest=new Map<string,Entry>();
  for(const item of records){
    const parsed=mapping.safeParse(item.binding);
    if(!parsed.success||parsed.data.installationId!==parsed.data.nativeBinding.installationId||
      byDigest.has(parsed.data.credentialSha256))throw Error('DISPATCH_NATIVE_READBACK_SCOPE_INVALID');
    const binding=Object.freeze({...parsed.data,nativeBinding:Object.freeze(parsed.data.nativeBinding)});
    const {origin,credential,pinnedSpkiBase64,keyPem,certificatePem,serverCaPem,serverSpkiSha256}=item.verifier;
    const timeoutMs=item.verifier.timeoutMs??1000;
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>1500||
      typeof credential!=='string'||!/^[A-Za-z0-9_-]{32,2048}$/.test(credential)||
      typeof pinnedSpkiBase64!=='string')throw Error('DISPATCH_NATIVE_READBACK_TRUST_INVALID');
    const der=Buffer.from(pinnedSpkiBase64,'base64');
    if(der.length!==44||der.toString('base64')!==pinnedSpkiBase64||
      createPublicKey({key:der,format:'der',type:'spki'}).asymmetricKeyType!=='ed25519')
      throw Error('DISPATCH_NATIVE_READBACK_TRUST_INVALID');
    const fetchImpl=createCoreNativeMtlsFetch({origin,keyPem,certificatePem,serverCaPem,
      serverSpkiSha256,timeoutMs});
    byDigest.set(binding.credentialSha256,{binding,trust:Object.freeze({
      origin,credential,pinnedSpkiBase64,timeoutMs,fetchImpl})});
  }
  return async(record,signal)=>{
    if(signal.aborted)return false;
    try{
      const entry=byDigest.get(record.credentialSha256);
      if(!entry||!scopeKeys.every(k=>record[k]===entry.binding[k]))return false;
      const expected=entry.binding.nativeBinding;
      const response=await callProtectedCoreNativeAuthority(entry.trust,{
        version:1,operation:'current-readback',nonce:randomUUID(),expected},signal);
      const proof=CoreNativeProofSchema.safeParse(response.proof);
      if(signal.aborted||!proof.success||proof.data.receiptId!==expected.nativeConsentReceiptId)
        return false;
      const {nativeConsentReceiptId:_,...fields}=expected;
      return (Object.keys(fields) as Array<keyof typeof fields>).every(k=>proof.data[k]===fields[k]);
    }catch{return false}
  };
}

/** Connect the concrete mTLS readback adapter to the concrete credential store.
 * All trust inputs are required explicitly; no default Worker/Agent/Broker
 * startup, no ceremony, no effect provider and no flag promotion. */
export async function startBrokerDispatchWithNativeInstallationReadback(config:
  Omit<Parameters<typeof startBrokerDispatchWithPostgresCredentials>[0],'verifyInstallationBinding'>&{
    nativeReadback:readonly DispatchNativeReadbackProvisioning[];
  }){
  const {nativeReadback,...service}=config;
  const verifyInstallationBinding=createProtectedDispatchInstallationReadback(nativeReadback);
  return startBrokerDispatchWithPostgresCredentials({...service,verifyInstallationBinding});
}
