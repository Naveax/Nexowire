import {createHash,createPublicKey,verify} from 'node:crypto';
import * as z from 'zod';

/** Wire-only. An authenticated response does not independently establish
 * physical user presence unless its protected issuer does that OS work. */
export const CoreNativeProofSchema=z.strictObject({
  version:z.literal(1),challengeId:z.string().uuid(),receiptId:z.string().uuid(),
  ownerAccountId:z.string().min(8).max(128),deviceId:z.string().min(8).max(128),
  installationId:z.string().uuid(),enrollmentId:z.string().uuid(),
  ownerEpoch:z.number().int().positive().safe(),
  grantGeneration:z.number().int().positive().safe(),
  revokeEpoch:z.number().int().nonnegative().safe(),
  windowsSessionId:z.number().int().positive().safe(),
  windowsUserSid:z.string().regex(/^S-\d-\d+(?:-\d+)+$/i),
  windowsLogonLuid:z.string().regex(/^[0-9a-f]{16}$/i).refine(v=>!/^0+$/.test(v)),
  windowsLogonSessionEpoch:z.string().uuid(),
  approvedAtMs:z.number().int().positive().safe(),consumed:z.literal(true),
});
export type CoreNativeProof=z.infer<typeof CoreNativeProofSchema>;
export const CoreNativeOperationSchema=z.enum(['approve-and-consume','current-readback','verify-and-consume']);
export type CoreNativeOperation=z.infer<typeof CoreNativeOperationSchema>;
export const CoreNativeWireRequestSchema=z.strictObject({
  version:z.literal(1),operation:CoreNativeOperationSchema,
  nonce:z.string().uuid(),expected:z.unknown(),
});
export type CoreNativeWireRequest=z.infer<typeof CoreNativeWireRequestSchema>;
export const CoreNativeWireResponseSchema=z.strictObject({
  version:z.literal(1),operation:CoreNativeOperationSchema,
  nonce:z.string().uuid(),requestSha256:z.string().regex(/^[a-f0-9]{64}$/),
  observedAtMs:z.number().int().positive().safe(),accepted:z.boolean(),
  proof:CoreNativeProofSchema.nullable(),
  signatureBase64:z.string().length(88),
});
export type CoreNativeWireResponse=z.infer<typeof CoreNativeWireResponseSchema>;

function canonical(value:unknown):string{
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(typeof value==='object'){
    const obj=value as Record<string,unknown>;
    return '{'+Object.keys(obj).sort().map(key=>{
      if(obj[key]===undefined)throw new Error('CORE_NATIVE_UNDEFINED_WIRE_VALUE');
      return JSON.stringify(key)+':'+canonical(obj[key]);
    }).join(',')+'}';
  }
  throw new Error('CORE_NATIVE_INVALID_WIRE_VALUE');
}
export function coreNativeWireRequestHash(value:CoreNativeWireRequest):string{
  return createHash('sha256').update('nexowire.native.consent.request.v1\0')
    .update(canonical(CoreNativeWireRequestSchema.parse(value))).digest('hex');
}
export function coreNativeSignedResponseBytes(
  value:Omit<CoreNativeWireResponse,'signatureBase64'>,
):Buffer{
  return Buffer.from('nexowire.native.consent.response.v1\0'+canonical(value));
}
export function parseTrustedCoreNativeResponse(
  raw:unknown,request:CoreNativeWireRequest,pinnedSpkiBase64:string,
  nowMs=Date.now(),
):CoreNativeWireResponse{
  const parsed=CoreNativeWireResponseSchema.parse(raw);
  if(parsed.version!==1||parsed.operation!==request.operation||parsed.nonce!==request.nonce||
    parsed.requestSha256!==coreNativeWireRequestHash(request)||
    parsed.observedAtMs>nowMs+2000||parsed.observedAtMs<nowMs-5000)
    throw new Error('CORE_NATIVE_RESPONSE_STALE_OR_UNBOUND');
  const der=Buffer.from(pinnedSpkiBase64,'base64');
  if(der.length!==44||der.toString('base64')!==pinnedSpkiBase64)
    throw new Error('CORE_NATIVE_SIGNER_NOT_PINNED');
  const key=createPublicKey({key:der,format:'der',type:'spki'});
  if(key.asymmetricKeyType!=='ed25519')throw new Error('CORE_NATIVE_SIGNER_KEY_INVALID');
  const sig=Buffer.from(parsed.signatureBase64,'base64');
  if(sig.length!==64||sig.toString('base64')!==parsed.signatureBase64||
    !verify(null,coreNativeSignedResponseBytes({
      version:parsed.version,operation:parsed.operation,nonce:parsed.nonce,
      requestSha256:parsed.requestSha256,observedAtMs:parsed.observedAtMs,
      accepted:parsed.accepted,proof:parsed.proof,
    }),key,sig))throw new Error('CORE_NATIVE_SIGNED_RESPONSE_REQUIRED');
  if(!parsed.accepted||!parsed.proof)throw new Error('CORE_NATIVE_AUTHORITY_DENIED');
  return parsed;
}
export async function callProtectedCoreNativeAuthority(
  options:{origin:string;credential:string;pinnedSpkiBase64:string;fetchImpl?:typeof fetch;
    timeoutMs?:number;loopbackOnly?:boolean},request:CoreNativeWireRequest,
  signal?:AbortSignal,
):Promise<CoreNativeWireResponse>{
  const url=new URL(options.origin);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||
    (options.loopbackOnly&&url.hostname!=='127.0.0.1'&&url.hostname!=='[::1]'))
    throw new Error('CORE_NATIVE_AUTHORITY_ORIGIN_INVALID');
  if(!options.credential||options.credential.length>2048||/[\r\n]/.test(options.credential)||
    !options.pinnedSpkiBase64)throw new Error('CORE_NATIVE_TRUST_BOOTSTRAP_REQUIRED');
  const max=options.timeoutMs??3500;
  if(!Number.isInteger(max)||max<100||max>10000)throw new Error('CORE_NATIVE_TIMEOUT_INVALID');
  const abort=AbortSignal.any([AbortSignal.timeout(max),...(signal?[signal]:[])]);
  if(abort.aborted)throw new Error('CORE_NATIVE_CALL_ABORTED');
  const response=await (options.fetchImpl??fetch)(url.origin+'/v1/core-native-consent',{
    method:'POST',cache:'no-store',redirect:'error',
    headers:{'content-type':'application/json','authorization':'Bearer '+options.credential},
    body:JSON.stringify(CoreNativeWireRequestSchema.parse(request)),signal:abort,
  });
  if(!response.ok||response.redirected)throw new Error('CORE_NATIVE_AUTHORITY_UNAVAILABLE');
  if(!response.headers.get('content-type')?.toLowerCase().includes('application/json'))
    throw new Error('CORE_NATIVE_RESPONSE_NOT_JSON');
  const body=await response.text();
  if(Buffer.byteLength(body,'utf8')>8192)throw new Error('CORE_NATIVE_RESPONSE_TOO_LARGE');
  if(abort.aborted)throw new Error('CORE_NATIVE_CALL_ABORTED');
  return parseTrustedCoreNativeResponse(JSON.parse(body) as unknown,request,options.pinnedSpkiBase64);
}
