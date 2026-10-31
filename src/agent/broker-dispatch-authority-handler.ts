import {createPublicKey,verify,type KeyObject} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {TLSSocket} from 'node:tls';
import * as z from 'zod';
import type {BrokerDispatchRequest,DispatchClaim,DispatchReleaseRequest,
  DispatchRevokeRequest,ExternalBrokerDispatchAuthority,ProtectedBrokerEvidence}
  from './broker-external-dispatch-fence.js';

const id=z.string().uuid();
const challenge=z.string().regex(/^[0-9a-f]{64}$/);
const scope=z.object({ownerId:id,deviceId:id,deviceEpoch:id,sessionEpoch:id,
  ownerEpoch:z.number().int().positive().safe(),
  expectedGeneration:z.number().int().positive().safe(),
  requiredPrivilege:z.enum(['CORE','ROOT'])}).strict();
const request=z.object({requestId:id,
  fingerprint:z.string().regex(/^[0-9a-f]{64}$/),
  capability:z.string().min(1).max(128),scope}).strict();
const evidence=z.object({verified:z.literal(true),brokerId:id,
  ownerEpoch:z.number().int().positive().safe(),
  grantGeneration:z.number().int().positive().safe(),
  highIntegrityToken:z.literal(true),signedProtectedImage:z.literal(true),
  protectedParentAndImports:z.literal(true)}).strict();
const principal=z.object({brokerId:id,ownerId:id,deviceId:id,
  deviceEpoch:id,sessionEpoch:id}).strict();
const begin=z.object({request,broker:evidence,challengeNonce:challenge}).strict();
const commit=begin.extend({dispatchId:id}).strict();
const release=z.object({dispatchId:id,brokerId:id,request}).strict();
const revoke=z.object({deviceId:id,ownerId:id,deviceEpoch:id,sessionEpoch:id,
  expectedGeneration:z.number().int().positive().safe(),
  signedOwnerApproval:z.string().min(32).max(8192),
  challengeNonce:challenge}).strict();
const claim=z.object({payload:z.string().min(1).max(4096),
  signature:z.string().min(1).max(1024)}).strict();
const permit=z.object({kind:z.enum(['broker_dispatch_permit_v1',
  'broker_dispatch_commit_v1']),authorityId:id,brokerId:id,dispatchId:id,
  challengeNonce:challenge,requestId:id,
  fingerprint:z.string().regex(/^[0-9a-f]{64}$/),
  capability:z.string().min(1).max(128),ownerId:id,deviceId:id,
  deviceEpoch:id,sessionEpoch:id,ownerEpoch:z.number().int().positive().safe(),
  generation:z.number().int().positive().safe(),privilege:z.enum(['CORE','ROOT']),
  issuedAtMs:z.number().int().positive().safe(),
  expiresAtMs:z.number().int().positive().safe()}).strict();
// Provider-owned objects are not trusted as live JS references: Zod's parse
// copies values, but accessor fields can be read with different values between
// checks. Require every security field to be its own plain DATA descriptor.
// This is a source-only TOCTOU guard, NOT protected OS evidence.
const nativePrincipalFields=['brokerId','ownerId','deviceId','deviceEpoch','sessionEpoch'] as const;
const nativeEvidenceFields=['verified','brokerId','ownerEpoch','grantGeneration',
  'highIntegrityToken','signedProtectedImage','protectedParentAndImports'] as const;
function snapshotOwnData(raw:unknown,fields:readonly string[]):Record<string,unknown>|undefined {
  if(!raw || typeof raw!=='object' || Array.isArray(raw))return undefined;
  try {
    const prototype=Object.getPrototypeOf(raw);
    if(prototype!==Object.prototype&&prototype!==null)return undefined;
    const descriptors=Object.getOwnPropertyDescriptors(raw);
    // Preserve strict-schema rejection of extra/hidden/symbol keys.
    if(Reflect.ownKeys(descriptors).length!==fields.length)return undefined;
    const snapshot:Record<string,unknown>=Object.create(null);
    for(const field of fields){
      const d=descriptors[field];
      if(!d||!Object.hasOwn(d,'value')||d.enumerable!==true)return undefined;
      snapshot[field]=d.value;
    }
    return Object.freeze(snapshot);
  }catch{return undefined}
}
const revoked=z.object({kind:z.literal('broker_dispatch_revocation_v1'),
  authorityId:id,deviceId:id,ownerId:id,deviceEpoch:id,sessionEpoch:id,
  challengeNonce:challenge,previousGeneration:z.number().int().positive().safe(),
  generation:z.number().int().positive().safe(),drained:z.literal(true),
  revoked:z.literal(true)}).strict();

export type DispatchBrokerPrincipal=z.infer<typeof principal>;
type Action='begin'|'commit'|'revoke-and-drain'|'release';

/**
 * Wire adapter only; it is neither an authority nor an atomic store. The
 * supplied authority MUST be an independently operated, durable, linearizable
 * provider, with immutable request tombstones and atomic grant/revoke/drain.
 * No in-memory, SQLite or development fallback is installed by this module.
 * Callbacks must resolve protected credentials and independently read the
 * actual Broker; the boolean evidence received over HTTP is never proof.
 * A valid signature does not attest storage independence or physical drain.
 */
export function createBrokerDispatchAuthorityHandler(config:{
  authorityId:string;publicKeyPem:string;
  authority:ExternalBrokerDispatchAuthority;
  authenticateBroker:(credential:string)=>Promise<DispatchBrokerPrincipal|undefined>;
  readProtectedBroker:(principal:DispatchBrokerPrincipal,
    operation:BrokerDispatchRequest)=>Promise<ProtectedBrokerEvidence|undefined>;
  verifyOwnerRevocation:(request:DispatchRevokeRequest)=>Promise<boolean>;
  now?:()=>number;
}):(req:IncomingMessage,res:ServerResponse)=>void {
  if(!id.safeParse(config.authorityId).success||!config.authority||
     typeof config.authority.beginIfCurrent!=='function'||
     typeof config.authority.commitIfCurrent!=='function'||
     typeof config.authority.revokeAndDrain!=='function'||
     typeof config.authority.release!=='function'||
     typeof config.authenticateBroker!=='function'||
     typeof config.readProtectedBroker!=='function'||
     typeof config.verifyOwnerRevocation!=='function')
    throw new Error('DISPATCH_HANDLER_CONFIG_INVALID');
  let key:KeyObject;
  try{key=createPublicKey(config.publicKeyPem)}
  catch{throw new Error('DISPATCH_HANDLER_KEY_INVALID')}
  if(key.asymmetricKeyType!=='ed25519')throw new Error('DISPATCH_HANDLER_KEY_INVALID');
  const authority=config.authority,authorityId=config.authorityId;
  const authenticateBroker=config.authenticateBroker;
  const readProtectedBroker=config.readProtectedBroker;
  const verifyOwnerRevocation=config.verifyOwnerRevocation;
  const now=config.now??Date.now;
  const respond=(res:ServerResponse,status:number,value?:unknown)=>{
    if(res.headersSent||res.destroyed)return;
    res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});
    res.end(value===undefined?undefined:JSON.stringify(value));
  };
  const fail=()=>{throw new Error('DISPATCH_HANDLER_DENIED')};
  const decode=(raw:DispatchClaim):{raw:DispatchClaim;value:unknown}=>{
    const parsed=claim.safeParse(raw);
    if(!parsed.success)return fail();
    const envelope=parsed.data;
    const bytes=Buffer.from(envelope.payload,'base64url');
    const signature=Buffer.from(envelope.signature,'base64url');
    if(bytes.toString('base64url')!==envelope.payload||
       signature.toString('base64url')!==envelope.signature||signature.length!==64||
       !verify(null,bytes,key,signature))return fail();
    let value:unknown;
    try{value=JSON.parse(bytes.toString('utf8'))}catch{return fail()}
    // Verify the exact signed UTF-8 wire form, not merely parsed values.
    // This protocol requires compact JSON.stringify bytes, not arbitrary
    // JSON spelling or RFC 8785 canonicalization.
    const canonical=JSON.stringify(value);
    if(!canonical || !Buffer.from(canonical,'utf8').equals(bytes))
      return fail();
    return {raw:envelope,value};
  };
  const scoped=(p:DispatchBrokerPrincipal,s:{ownerId:string;deviceId:string;
    deviceEpoch:string;sessionEpoch:string})=>p.ownerId===s.ownerId&&
    p.deviceId===s.deviceId&&p.deviceEpoch===s.deviceEpoch&&
    p.sessionEpoch===s.sessionEpoch;
  const checkedPermit=(raw:DispatchClaim,op:BrokerDispatchRequest,
    broker:ProtectedBrokerEvidence,nonce:string,kind:'begin'|'commit',
    dispatchId?:string):DispatchClaim=>{
    const decoded=decode(raw),parsed=permit.safeParse(decoded.value);
    if(!parsed.success)return fail();
    const p=parsed.data,s=op.scope,time=now();
    if(!Number.isSafeInteger(time)||time<=0||
       p.kind!==(kind==='begin'?'broker_dispatch_permit_v1':'broker_dispatch_commit_v1')||
       p.authorityId!==authorityId||p.brokerId!==broker.brokerId||
       p.challengeNonce!==nonce||(dispatchId!==undefined&&p.dispatchId!==dispatchId)||
       p.requestId!==op.requestId||p.fingerprint!==op.fingerprint||
       p.capability!==op.capability||p.ownerId!==s.ownerId||p.deviceId!==s.deviceId||
       p.deviceEpoch!==s.deviceEpoch||p.sessionEpoch!==s.sessionEpoch||
       p.ownerEpoch!==s.ownerEpoch||p.generation!==s.expectedGeneration||
       p.privilege!==s.requiredPrivilege||p.issuedAtMs>time+1000||
       p.expiresAtMs<=time||p.expiresAtMs<=p.issuedAtMs||
       p.expiresAtMs-p.issuedAtMs>5000)return fail();
    return decoded.raw;
  };
  const checkedRevoke=(raw:DispatchClaim,op:DispatchRevokeRequest,
    nonce:string):DispatchClaim=>{
    const decoded=decode(raw),parsed=revoked.safeParse(decoded.value);
    if(!parsed.success)return fail();
    const p=parsed.data;
    if(p.authorityId!==authorityId||p.deviceId!==op.deviceId||
       p.ownerId!==op.ownerId||p.deviceEpoch!==op.deviceEpoch||
       p.sessionEpoch!==op.sessionEpoch||p.challengeNonce!==nonce||
       p.previousGeneration!==op.expectedGeneration||
       p.generation!==op.expectedGeneration+1)return fail();
    return decoded.raw;
  };
  return (req,res)=>{
    void (async()=>{
      // Do not allow an accidental plaintext listener or forwarded TLS claim.
      if(!(req.socket as TLSSocket).encrypted){respond(res,403,{error:'denied'});return}
      const action=req.url?.match(/^\/v1\/broker-dispatch\/(begin|commit|revoke-and-drain|release)$/)?.[1] as Action|undefined;
      if(req.method!=='POST'||!action){respond(res,404,{error:'not_found'});return}
      const auth=req.headers.authorization?.match(/^Bearer ([^\s]{16,4096})$/);
      if(!auth){respond(res,403,{error:'denied'});return}
      let resolved:DispatchBrokerPrincipal|undefined;
      try{resolved=await authenticateBroker(auth[1]!)}catch{}
      const parsedPrincipal=principal.safeParse(snapshotOwnData(resolved,nativePrincipalFields));
      if(!parsedPrincipal.success){respond(res,403,{error:'denied'});return}
      const p=Object.freeze(parsedPrincipal.data);
      // Re-authenticate the exact Broker principal AFTER pending network body
      // or native readback awaits. A once-valid bearer can be revoked mid-flight.
      const principalStillCurrent=async():Promise<boolean>=>{
        let current:DispatchBrokerPrincipal|undefined;
        try{current=await authenticateBroker(auth[1]!)}catch{return false}
        const parsed=principal.safeParse(snapshotOwnData(current,nativePrincipalFields));
        return parsed.success&&parsed.data.brokerId===p.brokerId&&
          scoped(p,parsed.data);
      };
      const limit=16384;
      if(Number(req.headers['content-length'])>limit){respond(res,413,{error:'too_large'});return}
      const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req){
        const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
        size+=bytes.length;
        if(size>limit){respond(res,413,{error:'too_large'});return}
        chunks.push(bytes);
      }
      let body:unknown;
      try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'))}
      catch{respond(res,400,{error:'invalid_request'});return}
      if(action==='release'){
        if(!await principalStillCurrent()){respond(res,403,{error:'denied'});return}
        const parsed=release.safeParse(body);
        if(!parsed.success||parsed.data.brokerId!==p.brokerId||
           !scoped(p,parsed.data.request.scope)){
          respond(res,403,{error:'denied'});return;
        }
        const op:DispatchReleaseRequest=parsed.data;
        Object.freeze(op.request.scope);Object.freeze(op.request);Object.freeze(op);
        await authority.release(op);
        respond(res,204);return;
      }
      if(action==='revoke-and-drain'){
        if(!await principalStillCurrent()){respond(res,403,{error:'denied'});return}
        const parsed=revoke.safeParse(body);
        if(!parsed.success||!scoped(p,parsed.data)){
          respond(res,403,{error:'denied'});return;
        }
        const {challengeNonce,...op}=parsed.data;
        Object.freeze(op);
        if(await verifyOwnerRevocation(op)!==true){
          respond(res,403,{error:'denied'});return;
        }
        const receipt=await authority.revokeAndDrain(op,challengeNonce);
        respond(res,200,checkedRevoke(receipt,op,challengeNonce));return;
      }
      const parsed=(action==='begin'?begin:commit).safeParse(body);
      if(!parsed.success){respond(res,400,{error:'invalid_request'});return}
      const input=parsed.data,op=input.request;
      if(!scoped(p,op.scope)||input.broker.brokerId!==p.brokerId){
        respond(res,403,{error:'denied'});return;
      }
      Object.freeze(op.scope);Object.freeze(op);
      // Evidence comes from the server's protected provider, not from the HTTP body.
      const observed=evidence.safeParse(snapshotOwnData(
        await readProtectedBroker(p,op),nativeEvidenceFields));
      if(!observed.success||observed.data.brokerId!==p.brokerId||
         observed.data.ownerEpoch!==op.scope.ownerEpoch||
         observed.data.grantGeneration!==op.scope.expectedGeneration){
        respond(res,403,{error:'denied'});return;
      }
      const broker=Object.freeze(observed.data);
      if(!await principalStillCurrent()){
        respond(res,403,{error:'denied'});return;
      }
      if(action==='begin'){
        const receipt=await authority.beginIfCurrent(op,broker,input.challengeNonce);
        respond(res,200,checkedPermit(receipt,op,broker,input.challengeNonce,'begin'));
      }else{
        const dispatchId=(input as z.infer<typeof commit>).dispatchId;
        const receipt=await authority.commitIfCurrent(op,broker,dispatchId,input.challengeNonce);
        respond(res,200,checkedPermit(receipt,op,broker,input.challengeNonce,'commit',dispatchId));
      }
    })().catch(()=>respond(res,503,{error:'unavailable'}));
  };
}
