import * as z from 'zod';
import type {ExternalBrokerDispatchAuthority,BrokerDispatchRequest,
  ProtectedBrokerEvidence,DispatchRevokeRequest,DispatchReleaseRequest,
  DispatchClaim}
  from './broker-external-dispatch-fence.js';

const id=z.string().uuid();
const claim=z.object({
  payload:z.string().min(1).max(4096).regex(/^[A-Za-z0-9_-]+$/),
  signature:z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/),
}).strict();
const op=z.object({
  requestId:id,fingerprint:z.string().regex(/^[0-9a-f]{64}$/),
  capability:z.string().min(1).max(128),
  scope:z.object({
    ownerId:id,deviceId:id,deviceEpoch:id,sessionEpoch:id,
    ownerEpoch:z.number().int().positive().safe(),
    expectedGeneration:z.number().int().positive().safe(),
    requiredPrivilege:z.enum(['CORE','ROOT']),
  }).strict(),
}).strict();
const evidence=z.object({
  verified:z.literal(true),brokerId:id,ownerEpoch:z.number().int().positive().safe(),
  grantGeneration:z.number().int().positive().safe(),highIntegrityToken:z.literal(true),
  signedProtectedImage:z.literal(true),protectedParentAndImports:z.literal(true),
}).strict();
const releaseScope=z.object({
  dispatchId:id,brokerId:id,request:op,
}).strict();
const revocation=z.object({
  deviceId:id,ownerId:id,deviceEpoch:id,sessionEpoch:id,
  expectedGeneration:z.number().int().positive().safe(),
  signedOwnerApproval:z.string().min(32).max(8192),
}).strict();

export class BrokerDispatchTransportError extends Error {
  constructor(readonly code:string){
    super('Authenticated external Broker dispatch endpoint unavailable or denied.');
    this.name='BrokerDispatchTransportError';
  }
}
function deny(code:string):never{throw new BrokerDispatchTransportError(code)}
/**
 * Real TLS-only transport. The REMOTE service (not provided by this PR)
 * must atomically begin dispatch against current owner/CORE/ROOT grant,
 * revoke-and-drain all admitted claims, and persist monotonic history.
 * This client does not establish an independent physical trust domain.
 */
export class HttpsBrokerDispatchAuthority implements ExternalBrokerDispatchAuthority {
  private readonly base:URL;
  private readonly timeoutMs:number;
  private readonly brokerCredential:()=>Promise<string|undefined>;
  constructor(config:{
    endpoint:string;timeoutMs?:number;
    /** Resolve only from authenticated protected Broker enrollment. */
    brokerCredential:()=>Promise<string|undefined>;
  }){
    let url:URL;
    try{url=new URL(config.endpoint)}
    catch{throw new BrokerDispatchTransportError('BROKER_DISPATCH_ENDPOINT_INVALID')}
    if(url.protocol!=='https:'||url.username||url.password||
       url.search||url.hash||url.pathname!=='/v1/broker-dispatch')
      deny('BROKER_DISPATCH_ENDPOINT_INVALID');
    const timeout=config.timeoutMs??3500;
    if(!Number.isSafeInteger(timeout)||timeout<100||timeout>10000||
       typeof config.brokerCredential!=='function')
      deny('BROKER_DISPATCH_TRANSPORT_CONFIGURATION_INVALID');
    this.base=url;
    this.timeoutMs=timeout;
    this.brokerCredential=config.brokerCredential;
  }
  private async send(
    action:'begin'|'commit'|'revoke-and-drain'|'release',
    payload:unknown,expectsReceipt:boolean,
  ):Promise<DispatchClaim|undefined>{
    // Capture wire bytes before any asynchronous credential lookup.
    const body=JSON.stringify(payload);
    if(Buffer.byteLength(body,'utf8')>16384)deny('BROKER_DISPATCH_REQUEST_TOO_LARGE');
    const controller=new AbortController(),started=process.hrtime.bigint();
    let timer:ReturnType<typeof setTimeout>|undefined;
    const deadline=new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>{
        controller.abort();
        reject(new BrokerDispatchTransportError('BROKER_DISPATCH_TRANSPORT_UNKNOWN'));
      },this.timeoutMs);
    });
    const checked=()=>{
      const elapsed=process.hrtime.bigint()-started;
      if(controller.signal.aborted||elapsed<0n||elapsed>=BigInt(this.timeoutMs)*1000000n)
        deny('BROKER_DISPATCH_TRANSPORT_UNKNOWN');
    };
    try{
      let token:string|undefined;
      try{token=await Promise.race([Promise.resolve().then(()=>this.brokerCredential()),deadline])}
      catch(e){if(e instanceof BrokerDispatchTransportError)throw e;
        return deny('BROKER_DISPATCH_CREDENTIAL_MISSING')}
      checked();
      if(typeof token!=='string'||!/^[^\s,\x00-\x1f\x7f]{16,4096}$/.test(token))
        return deny('BROKER_DISPATCH_CREDENTIAL_MISSING');
      const response=await Promise.race([fetch(new URL('/v1/broker-dispatch/'+action,this.base),{
        method:'POST',redirect:'error',cache:'no-store',
        headers:{authorization:'Bearer '+token,'content-type':'application/json'},
        body,signal:controller.signal,
      }),deadline]);
      checked();
      if(response.redirected||response.status!==(expectsReceipt?200:204))
        return deny('BROKER_DISPATCH_REMOTE_REFUSED');
      if(!expectsReceipt)return undefined;
      const type=response.headers.get('content-type'),encoding=response.headers.get('content-encoding');
      if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type??'')||
         (encoding!==null&&encoding.toLowerCase()!=='identity'))
        return deny('BROKER_DISPATCH_RECEIPT_INVALID');
      const reader=response.body?.getReader();
      if(!reader)return deny('BROKER_DISPATCH_RECEIPT_INVALID');
      const chunks:Uint8Array[]=[];let size=0;
      try{
        for(;;){
          const part=await Promise.race([reader.read(),deadline]);checked();
          if(part.done)break;
          size+=part.value.byteLength;
          if(size>8192)return deny('BROKER_DISPATCH_RECEIPT_INVALID');
          chunks.push(part.value);
        }
      }finally{
        void reader.cancel().catch(()=>undefined);reader.releaseLock();
      }
      checked();
      let data:unknown;
      try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))}
      catch{return deny('BROKER_DISPATCH_RECEIPT_INVALID')}
      const parsed=claim.safeParse(data);
      if(!parsed.success)return deny('BROKER_DISPATCH_RECEIPT_INVALID');
      return Object.freeze(parsed.data);
    }catch(error){
      if(error instanceof BrokerDispatchTransportError)throw error;
      return deny('BROKER_DISPATCH_TRANSPORT_UNKNOWN');
    }finally{
      if(timer!==undefined)clearTimeout(timer);
      controller.abort();
    }
  }
  async beginIfCurrent(request:BrokerDispatchRequest,
    broker:ProtectedBrokerEvidence,challengeNonce:string):Promise<DispatchClaim>{
    const input=op.parse(request),snapshot=evidence.safeParse(broker);
    if(!snapshot.success)return deny('BROKER_DISPATCH_ELEVATION_UNVERIFIED');
    broker=snapshot.data;
    if(!/^[0-9a-f]{64}$/.test(challengeNonce))
      deny('BROKER_DISPATCH_CHALLENGE_INVALID');
    if(broker.verified!==true||!id.safeParse(broker.brokerId).success||
       broker.highIntegrityToken!==true||
       broker.ownerEpoch!==input.scope.ownerEpoch||
       broker.grantGeneration!==input.scope.expectedGeneration||
       broker.signedProtectedImage!==true||
       broker.protectedParentAndImports!==true)
      deny('BROKER_DISPATCH_ELEVATION_UNVERIFIED');
    const result=await this.send('begin',{
      request:input,broker,challengeNonce},true);
    if(!result)return deny('BROKER_DISPATCH_RECEIPT_MISSING');
    return result;
  }
  async commitIfCurrent(request:BrokerDispatchRequest,
    broker:ProtectedBrokerEvidence,dispatchId:string,
    challengeNonce:string):Promise<DispatchClaim>{
    const input=op.parse(request),snapshot=evidence.safeParse(broker);
    if(!snapshot.success)return deny('BROKER_COMMIT_EFFECTIVE_TOKEN_UNVERIFIED');
    broker=snapshot.data;
    if(!id.safeParse(dispatchId).success||
       !/^[0-9a-f]{64}$/.test(challengeNonce))
      deny('BROKER_COMMIT_SCOPE_INVALID');
    if(broker.verified!==true||
       broker.highIntegrityToken!==true||
       broker.signedProtectedImage!==true||
       broker.protectedParentAndImports!==true||
       broker.ownerEpoch!==input.scope.ownerEpoch||
       broker.grantGeneration!==input.scope.expectedGeneration)
      deny('BROKER_COMMIT_EFFECTIVE_TOKEN_UNVERIFIED');
    const proof=await this.send('commit',{
      request:input,broker,dispatchId,challengeNonce},true);
    if(!proof)deny('BROKER_COMMIT_RECEIPT_MISSING');
    return proof;
  }
  async revokeAndDrain(request:DispatchRevokeRequest,
    challengeNonce:string):Promise<DispatchClaim>{
    const input=revocation.parse(request);
    if(!/^[0-9a-f]{64}$/.test(challengeNonce))
      deny('BROKER_DISPATCH_CHALLENGE_INVALID');
    const result=await this.send('revoke-and-drain',{...input,challengeNonce},true);
    if(!result)return deny('BROKER_REVOKE_RECEIPT_MISSING');
    return result;
  }
  async release(value:DispatchReleaseRequest):Promise<void>{
    const input=releaseScope.parse(value);
    await this.send('release',input,false);
  }
}
