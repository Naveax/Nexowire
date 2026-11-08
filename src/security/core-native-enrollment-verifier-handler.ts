import {createPublicKey,verify,type KeyObject} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {TLSSocket} from 'node:tls';
import * as z from 'zod';
import {canonicalCoreConsoleEnrollment,type CoreConsoleEnrollmentV1}
  from '../agent/core-console-enrollment-policy.js';
import {CoreNativeProofSchema,CoreNativeWireRequestSchema,coreNativeSignedResponseBytes,
  coreNativeWireRequestHash,snapshotCoreNativeWireRequest,
  type CoreNativeProof,type CoreNativeWireResponse} from '../protocol/core-native-consent-transport.js';
import {CoreApprovalBindingSchema,CoreApprovalLedgerError,
  type PostgresCoreApprovalLedger} from './postgres-core-approval-ledger.js';

const principalSchema=CoreApprovalBindingSchema.pick({ownerAccountId:true,deviceId:true,installationId:true})
  .extend({role:z.literal('independent-enrollment-verifier')});
export type CoreNativeVerifierPrincipal=z.infer<typeof principalSchema>;
const readbackSchema=CoreApprovalBindingSchema.omit({version:true})
  .extend({nativeConsentReceiptId:z.string().uuid()});
const enrollmentSchema=z.strictObject({version:z.literal(1),scope:z.literal('physical-console'),
  ownerAccountId:CoreNativeProofSchema.shape.ownerAccountId,deviceId:CoreNativeProofSchema.shape.deviceId,
  installationId:z.string().uuid(),enrollmentId:z.string().uuid(),
  ownerEpoch:CoreNativeProofSchema.shape.ownerEpoch,grantGeneration:CoreNativeProofSchema.shape.grantGeneration,
  revokeEpoch:CoreNativeProofSchema.shape.revokeEpoch,approvedLocallyAtMs:z.number().int().positive().safe(),
  issuerSpkiSha256:z.string().regex(/^[a-f0-9]{64}$/)});
const consumeSchema=z.strictObject({proof:CoreNativeProofSchema,expected:enrollmentSchema});
type Ledger=Pick<PostgresCoreApprovalLedger,'consumeForEnrollment'|'readEnrollmentProof'>;
const same=(a:CoreNativeProof,b:CoreNativeProof)=>Object.keys(a)
  .every(k=>a[k as keyof CoreNativeProof]===b[k as keyof CoreNativeProof]);

/** Off-host verifier HTTP component, NEVER an installed Windows approval UI.
 * Only verifies an EXISTING provisioned authenticator approval. This handler
 * deliberately refuses approve-and-consume: it cannot manufacture human consent.
 * Authentication, hardware/OS witness, restore gate and signing custody must be
 * supplied by protected deployment; no defaults, in-memory consume or bootstrap.
 * Creating the handler opens no listener and changes no production composition. */
export function createCoreNativeEnrollmentVerifierHandler(config:{
  ledger:Ledger;
  authenticateVerifier:(credential:string,peer:Readonly<{certificateSha256:string}>,
    signal:AbortSignal)=>Promise<CoreNativeVerifierPrincipal|null>;
  signer:{publicSpkiBase64:string;sign:(bytes:Uint8Array,signal:AbortSignal)=>Promise<Uint8Array>};
  timeoutMs?:number;
}):(req:IncomingMessage,res:ServerResponse)=>void{
  const consume=config.ledger?.consumeForEnrollment?.bind(config.ledger);
  const read=config.ledger?.readEnrollmentProof?.bind(config.ledger);
  const authenticate=config.authenticateVerifier,sign=config.signer?.sign?.bind(config.signer);
  const timeout=config.timeoutMs??3500,pin=config.signer?.publicSpkiBase64;
  let key:KeyObject;
  try{
    const der=Buffer.from(pin??'','base64');
    if(der.length!==44||der.toString('base64')!==pin)throw Error();
    key=createPublicKey({key:der,format:'der',type:'spki'});
    if(key.asymmetricKeyType!=='ed25519')throw Error();
  }catch{throw new Error('CORE_NATIVE_VERIFIER_SIGNER_INVALID')}
  if(typeof consume!=='function'||typeof read!=='function'||typeof authenticate!=='function'||
    typeof sign!=='function'||!Number.isInteger(timeout)||timeout<100||timeout>10000)
    throw new Error('CORE_NATIVE_VERIFIER_CONFIGURATION_REQUIRED');
  return(req,res)=>{
    const respond=(status:number,value:unknown)=>{
      if(res.headersSent||res.destroyed)return;
      res.writeHead(status,{'content-type':'application/json','cache-control':'no-store',
        'connection':'close','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));
    };
    const abort=new AbortController(),started=Date.now(),ticks=process.hrtime.bigint();
    const checked=()=>{
      const now=Date.now(),elapsed=process.hrtime.bigint()-ticks;
      if(abort.signal.aborted||req.aborted||res.destroyed||now<started||
        now-started>=timeout||elapsed<0n||elapsed>=BigInt(timeout)*1000000n)
        throw new Error('CORE_NATIVE_VERIFIER_REQUEST_UNKNOWN');
    };
    const timer=setTimeout(()=>{abort.abort();respond(503,{error:'unavailable'})},timeout);
    const disconnected=()=>{if(!res.writableEnded)abort.abort()};
    req.once('aborted',disconnected);res.once('close',disconnected);
    void(async()=>{
      // Direct mutually authenticated TLS only. Neither X-Forwarded-* nor a
      // caller-supplied fingerprint can replace the peer of this actual socket.
      const socket=req.socket as TLSSocket;
      if(socket.encrypted!==true||socket.authorized!==true||socket.getProtocol?.()!=='TLSv1.3'||
        typeof socket.getPeerCertificate!=='function'){
        respond(403,{error:'denied'});return;
      }
      const fingerprint=socket.getPeerCertificate().fingerprint256;
      if(typeof fingerprint!=='string'||!/^([A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/.test(fingerprint)){
        respond(403,{error:'denied'});return;
      }
      if(req.method!=='POST'||req.url!=='/v1/core-native-consent'){
        respond(404,{error:'not_found'});return;
      }
      const auth=req.headers.authorization?.match(/^Bearer ([^\s]{16,2048})$/);
      if(!auth||req.headersDistinct.authorization?.length!==1){respond(403,{error:'denied'});return}
      const resolved=await authenticate(auth[1]!,Object.freeze({
        certificateSha256:fingerprint.replaceAll(':','').toLowerCase()}),abort.signal);
      checked();
      const parsedPrincipal=principalSchema.safeParse(resolved);
      if(!parsedPrincipal.success){respond(403,{error:'denied'});return}
      const principal=Object.freeze(parsedPrincipal.data);
      if(req.headersDistinct['content-type']?.length!==1||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')||
        (req.headers['content-encoding']!==undefined&&req.headers['content-encoding']!=='identity')){
        respond(400,{error:'invalid_request'});return;
      }
      const length=req.headers['content-length'];
      if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>16384)){
        respond(413,{error:'too_large'});return;
      }
      const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req){
        checked();const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=b.length;
        if(size>16384){respond(413,{error:'too_large'});return}chunks.push(b);
      }
      const request=snapshotCoreNativeWireRequest(CoreNativeWireRequestSchema.parse(
        JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))));
      checked();
      if(request.operation==='approve-and-consume'){respond(403,{error:'denied'});return}
      let proof:Readonly<CoreNativeProof>;
      const scoped=(v:{ownerAccountId:string;deviceId:string;installationId:string})=>
        v.ownerAccountId===principal.ownerAccountId&&v.deviceId===principal.deviceId&&
        v.installationId===principal.installationId;
      if(request.operation==='verify-and-consume'){
        const input=consumeSchema.parse(request.expected),p=Object.freeze(input.proof),e=input.expected;
        canonicalCoreConsoleEnrollment(e as CoreConsoleEnrollmentV1);
        if(!scoped(p)||!Object.keys(e).every(k=>['scope','issuerSpkiSha256'].includes(k)||
          (p as Record<string,unknown>)[k==='approvedLocallyAtMs'?'approvedAtMs':k]===(e as Record<string,unknown>)[k])){
          respond(403,{error:'denied'});return;
        }
        proof=Object.freeze(CoreNativeProofSchema.parse(await consume(p,e.issuerSpkiSha256)));
        checked();if(!same(proof,p))throw new Error('CORE_NATIVE_VERIFIER_PROOF_CHANGED');
      }else{
        const expected=readbackSchema.parse(request.expected);
        if(!scoped(expected)){respond(403,{error:'denied'});return}
        const {nativeConsentReceiptId,...b}=expected;
        proof=Object.freeze(CoreNativeProofSchema.parse(await read(nativeConsentReceiptId,{version:1,...b})));
        checked();
        if(proof.receiptId!==nativeConsentReceiptId||!Object.keys(b).every(k=>
          (proof as Record<string,unknown>)[k]===(b as Record<string,unknown>)[k]))
          throw new Error('CORE_NATIVE_VERIFIER_PROOF_CHANGED');
      }
      const unsigned=Object.freeze({version:1 as const,operation:request.operation,nonce:request.nonce,
        requestSha256:coreNativeWireRequestHash(request),observedAtMs:Date.now(),accepted:true,proof});
      const bytes=coreNativeSignedResponseBytes(unsigned);
      // Give an external signer its own byte copy and verify its exact output.
      const signature=Buffer.from(await sign(new Uint8Array(bytes),abort.signal));checked();
      if(signature.length!==64||!verify(null,bytes,key,signature))
        throw new Error('CORE_NATIVE_VERIFIER_SIGNATURE_INVALID');
      // Signing can be asynchronous. A revoke/logon change during HSM latency
      // must suppress the already-signed response; history remains consumed.
      const current=CoreNativeProofSchema.parse(await read(proof.receiptId,
        CoreApprovalBindingSchema.parse(Object.fromEntries(Object.keys(CoreApprovalBindingSchema.shape)
          .map(k=>[k,(proof as Record<string,unknown>)[k]])))));
      checked();if(!same(proof,current))throw new Error('CORE_NATIVE_VERIFIER_PROOF_CHANGED');
      // readEnrollmentProof remains valid for indefinite current-session
      // reconciliation. A NEW enrollment response must still meet its separate
      // approval TTL after every signer and readback await, just before return.
      if(request.operation==='verify-and-consume'){
        const remainingMs=BigInt(proof.approvedAtMs)+120000n-BigInt(started);
        if(Date.now()-proof.approvedAtMs>=120000||remainingMs<=0n||
          process.hrtime.bigint()-ticks>=remainingMs*1000000n)
          throw new CoreApprovalLedgerError('CORE_APPROVAL_ENROLLMENT_ACK_EXPIRED_OR_UNKNOWN');
      }
      const response:CoreNativeWireResponse={...unsigned,signatureBase64:signature.toString('base64')};
      respond(200,response);
    })().catch(error=>{
      if(error instanceof z.ZodError||error instanceof SyntaxError||error instanceof TypeError)
        respond(400,{error:'invalid_request'});
      else if(error instanceof CoreApprovalLedgerError&&!error.code.includes('UNKNOWN')&&
        !error.code.includes('UNAVAILABLE'))respond(403,{error:'denied'});
      else respond(503,{error:'unavailable'});
    }).finally(()=>{
      clearTimeout(timer);abort.abort();req.off('aborted',disconnected);res.off('close',disconnected);
    });
  };
}
