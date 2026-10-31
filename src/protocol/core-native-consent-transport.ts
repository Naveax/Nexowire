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

function canonical(value:unknown,depth=0):string{
  if(depth>32)throw new Error('CORE_NATIVE_WIRE_NESTING_LIMIT');
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(v=>canonical(v,depth+1)).join(',')+']';
  if(typeof value==='object'){
    const obj=value as Record<string,unknown>;
    return '{'+Object.keys(obj).sort().map(key=>{
      if(obj[key]===undefined)throw new Error('CORE_NATIVE_UNDEFINED_WIRE_VALUE');
      return JSON.stringify(key)+':'+canonical(obj[key],depth+1);
    }).join(',')+'}';
  }
  throw new Error('CORE_NATIVE_INVALID_WIRE_VALUE');
}
/** Detach all nested scope values before the first asynchronous trust call. */
export function snapshotCoreNativeWireRequest(value:CoreNativeWireRequest):CoreNativeWireRequest{
  const wire=canonical(CoreNativeWireRequestSchema.parse(value));
  if(Buffer.byteLength(wire,'utf8')>16384)throw new Error('CORE_NATIVE_REQUEST_TOO_LARGE');
  const detached=JSON.parse(wire) as CoreNativeWireRequest;
  const freeze=(v:unknown):void=>{
    if(v&&typeof v==='object'){
      for(const child of Object.values(v))freeze(child);
      Object.freeze(v);
    }
  };
  freeze(detached);
  return detached;
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
  // Configuration and request aliases may be retained by callers. Neither
  // the signing pin nor the scope compared after await may follow those aliases.
  const {origin,credential,pinnedSpkiBase64,fetchImpl,timeoutMs,loopbackOnly}=options;
  const original=snapshotCoreNativeWireRequest(request);
  const url=new URL(origin);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||
    (loopbackOnly&&url.hostname!=='127.0.0.1'&&url.hostname!=='[::1]'))
    throw new Error('CORE_NATIVE_AUTHORITY_ORIGIN_INVALID');
  if(!credential||credential.length>2048||/[\r\n]/.test(credential)||
    !pinnedSpkiBase64)throw new Error('CORE_NATIVE_TRUST_BOOTSTRAP_REQUIRED');
  const max=timeoutMs??3500;
  if(!Number.isInteger(max)||max<100||max>10000)throw new Error('CORE_NATIVE_TIMEOUT_INVALID');
  const abort=AbortSignal.any([AbortSignal.timeout(max),...(signal?[signal]:[])]);
  if(abort.aborted)throw new Error('CORE_NATIVE_CALL_ABORTED');
  // Reject bad trust bootstrap BEFORE any credential is sent to a server.
  const signerDer=Buffer.from(pinnedSpkiBase64,'base64');
  if(signerDer.length!==44||signerDer.toString('base64')!==pinnedSpkiBase64||
    createPublicKey({key:signerDer,format:'der',type:'spki'}).asymmetricKeyType!=='ed25519')
    throw new Error('CORE_NATIVE_SIGNER_NOT_PINNED');
  // Never fall back to global fetch: it cannot prove client-certificate custody,
  // server CA/hostname verification *and* the exact server SPKI pin. In particular,
  // an accidental omission must not send a protected bearer to an unpinned host.
  if(typeof fetchImpl!=='function')throw new Error('CORE_NATIVE_PROTECTED_TRANSPORT_REQUIRED');
  const response=await fetchImpl(url.origin+'/v1/core-native-consent',{
    method:'POST',cache:'no-store',redirect:'error',
    headers:{'content-type':'application/json','authorization':'Bearer '+credential},
    body:JSON.stringify(original),signal:abort,
  });
  if(!response.ok||response.redirected)throw new Error('CORE_NATIVE_AUTHORITY_UNAVAILABLE');
  // Defense in depth: reject malformed media type/encoding even if a custom
  // transport wrongly treats that HTTP 200 as trusted. Headers normalizes repeated
  // fields to comma-separated values, which must also fail this exact match.
  const contentType=response.headers.get('content-type');
  const contentEncoding=response.headers.get('content-encoding');
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType??'')||
    (contentEncoding!==null&&contentEncoding.toLowerCase()!=='identity'))
    throw new Error('CORE_NATIVE_RESPONSE_NOT_JSON');
  const reader=response.body?.getReader();
  if(!reader)throw new Error('CORE_NATIVE_RESPONSE_EMPTY');
  const chunks:Uint8Array[]=[];let bytes=0;
  try{
    for(;;){
      const part=await reader.read();
      if(part.done)break;
      bytes+=part.value.byteLength;
      if(bytes>8192){await reader.cancel();throw new Error('CORE_NATIVE_RESPONSE_TOO_LARGE');}
      chunks.push(part.value);
    }
  }finally{reader.releaseLock();}
  if(abort.aborted)throw new Error('CORE_NATIVE_CALL_ABORTED');
  const merged=new Uint8Array(bytes);let offset=0;
  for(const part of chunks){merged.set(part,offset);offset+=part.length;}
  return parseTrustedCoreNativeResponse(
    JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(merged)) as unknown,
    original,pinnedSpkiBase64);
}
