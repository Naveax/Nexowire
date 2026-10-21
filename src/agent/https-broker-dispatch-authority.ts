import * as z from 'zod';
import type {ExternalBrokerDispatchAuthority,BrokerDispatchRequest,
  ProtectedBrokerEvidence,DispatchRevokeRequest,DispatchClaim}
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
  constructor(private readonly config:{
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
    this.base=url;
  }
  private async send<T>(
    action:'begin'|'revoke-and-drain'|'release',
    payload:unknown,expectsReceipt:boolean,
  ):Promise<DispatchClaim|undefined>{
    let token:string|undefined;
    try{token=await this.config.brokerCredential()}
    catch{return deny('BROKER_DISPATCH_CREDENTIAL_MISSING')}
    if(!token||token.length<16)return deny('BROKER_DISPATCH_CREDENTIAL_MISSING');
    let response:Response;
    try{
      response=await fetch(new URL('/v1/broker-dispatch/'+action,this.base),{
        method:'POST',redirect:'error',cache:'no-store',
        headers:{authorization:'Bearer '+token,'content-type':'application/json'},
        body:JSON.stringify(payload),
        signal:AbortSignal.timeout(this.config.timeoutMs??3500),
      });
    }catch{return deny('BROKER_DISPATCH_TRANSPORT_UNKNOWN')}
    if(!response.ok)return deny('BROKER_DISPATCH_REMOTE_REFUSED');
    if(!expectsReceipt)return undefined;
    let body:string;
    try{body=await response.text()}
    catch{return deny('BROKER_DISPATCH_RECEIPT_INVALID')}
    if(body.length>8192)return deny('BROKER_DISPATCH_RECEIPT_INVALID');
    let data:unknown;
    try{data=JSON.parse(body)}
    catch{return deny('BROKER_DISPATCH_RECEIPT_INVALID')}
    const parsed=claim.safeParse(data);
    if(!parsed.success)return deny('BROKER_DISPATCH_RECEIPT_INVALID');
    return parsed.data;
  }
  async beginIfCurrent(request:BrokerDispatchRequest,
    broker:ProtectedBrokerEvidence,challengeNonce:string):Promise<DispatchClaim>{
    const input=op.parse(request);
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
  async revokeAndDrain(request:DispatchRevokeRequest):Promise<DispatchClaim>{
    const input=revocation.parse(request);
    const result=await this.send('revoke-and-drain',input,true);
    if(!result)return deny('BROKER_REVOKE_RECEIPT_MISSING');
    return result;
  }
  async release(claimId:string):Promise<void>{
    await this.send('release',{dispatchId:id.parse(claimId)},false);
  }
}
