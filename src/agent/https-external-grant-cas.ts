import * as z from 'zod';
import {types as nodeTypes} from 'node:util';
import type {CasRequest} from './remote-mutation-cas.js';
import type {AuthenticatedGrantScope,ExternalGrantCas,
  ExternalGrantCasReceipt,ExternalRevokeRequest,ExternalRevokeReceipt,
  ExternalRePairRequest,ExternalRePairReceipt} from './postgres-bound-grant-cas.js';

const uuid=z.string().uuid();
const result=z.object({
  authorityId:uuid,deviceId:uuid,epoch:uuid,requestId:uuid,
  ownerId:uuid,sessionEpoch:uuid,
  grantGeneration:z.number().int().positive().safe(),
  fingerprint:z.string().regex(/^[a-f0-9]{64}$/),
  capability:z.string().min(1).max(128),
  created:z.boolean(),sequence:z.number().int().positive().safe(),
}).strict();
const request=z.object({
  deviceId:uuid,epoch:uuid,requestId:uuid,
  fingerprint:z.string().regex(/^[a-f0-9]{64}$/),
  capability:z.string().min(1).max(128),
}).strict();
const revokeRequest=z.object({
  deviceId:uuid,ownerId:uuid,deviceEpoch:uuid,sessionEpoch:uuid,
  expectedGeneration:z.number().int().positive().safe(),
  signedOwnerApproval:z.string().min(32).max(8192),
}).strict();
const repairRequest=revokeRequest.extend({
  newOwnerId:uuid,newDeviceEpoch:uuid,newSessionEpoch:uuid,
}).strict();
const revokeReceipt=z.object({
  authorityId:uuid,deviceId:uuid,ownerId:uuid,deviceEpoch:uuid,
  sessionEpoch:uuid,previousGeneration:z.number().int().positive().safe(),
  generation:z.number().int().positive().safe(),revoked:z.literal(true),
}).strict();
const repairReceipt=revokeReceipt.extend({
  newOwnerId:uuid,newDeviceEpoch:uuid,newSessionEpoch:uuid,
  coreCleared:z.literal(true),
}).strict();
const scope=z.object({
  ownerId:uuid,deviceId:uuid,deviceEpoch:uuid,sessionEpoch:uuid,
  expectedGeneration:z.number().int().positive().safe(),
  requiredPrivilege:z.enum(['NORMAL','CORE','ROOT']),
}).strict();

export class ExternalGrantTransportError extends Error {
  constructor(readonly code:string){
    super('External grant CAS evidence unavailable or untrusted.');
    this.name='ExternalGrantTransportError';
  }
}
const reject=(code:string):never=>{throw new ExternalGrantTransportError(code)};

/**
 * The authority input consists exclusively of primitive scalar fields.
 * Reconstruct it from own enumerable data descriptors BEFORE any asynchronous
 * credential, CAS, or HTTP call. Zod parsing of a borrowed object can execute
 * a getter; a proxy can execute traps even during descriptor inspection.
 *
 * Do not treat this snapshot as authentication: the independently protected
 * external CAS must still check current owner/device/session and one-use UUID.
 */
function plainCasRecordSnapshot(
  raw:unknown,fields:readonly string[],errorCode:string,
):Record<string,unknown>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||nodeTypes.isProxy(raw))
    return reject(errorCode);
  const record=raw as object;
  let descriptors:PropertyDescriptorMap;
  let keys:PropertyKey[];
  let prototype:unknown;
  try{
    descriptors=Object.getOwnPropertyDescriptors(record);
    keys=Reflect.ownKeys(record);
    prototype=Object.getPrototypeOf(record);
  }catch{return reject(errorCode)}
  if((prototype!==Object.prototype&&prototype!==null)||
     keys.length!==fields.length||
     fields.some(field=>!Object.prototype.hasOwnProperty.call(descriptors,field)||
       !('value' in descriptors[field]!)||
       descriptors[field]!.enumerable!==true))
    return reject(errorCode);
  return Object.fromEntries(fields.map(field=>[field,descriptors[field]!.value]));
}



/** Reject Proxy/accessor/symbol/hidden configuration before binding HTTPS. */
function immutableExternalConfig<T extends object>(raw:T):Readonly<T>{
  const invalid=()=>reject('EXTERNAL_GRANT_CONFIG_INVALID');
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||nodeTypes.isProxy(raw))
    return invalid();
  let descriptors:PropertyDescriptorMap;
  let keys:PropertyKey[];
  let proto:unknown;
  try{
    descriptors=Object.getOwnPropertyDescriptors(raw);
    keys=Reflect.ownKeys(raw);
    proto=Object.getPrototypeOf(raw);
  }catch{return invalid()}
  const required=['endpoint','authorityId','credentialFor'];
  const allowed=new Set([...required,'timeoutMs']);
  if((proto!==Object.prototype&&proto!==null)||
     required.some(key=>!keys.includes(key))||
     keys.some(key=>typeof key!=='string'||!allowed.has(key)||
       !Object.prototype.hasOwnProperty.call(descriptors,key)||
       !('value' in descriptors[key]!)||
       descriptors[key]!.enumerable!==true))
    return invalid();
  return Object.freeze(Object.fromEntries((keys as string[]).map(
    key=>[key,descriptors[key]!.value]))) as Readonly<T>;
}

/**
 * A server may commit a one-use CAS mutation and still return a timeout,
 * overload response or 5xx. Such HTTP results MUST NOT be interpreted as a
 * definitive refusal that makes an automatic retry safe.
 *
 * A strict non-ambiguous client error (e.g. 403/409) remains a refusal
 * under the external authority's documented no-side-effect rejection contract.
 */
function httpOutcomeUncertain(status:number):boolean{
  return status===408||status===425||status===429||status>=500;
}

/**
 * Production-wire HTTPS adapter for a separately enrolled monotonic CAS.
 *
 * IMPORTANT: This is a real transport/client implementation, NOT a hosted
 * service or physical-proof claim. The external server MUST implement an
 * atomic, durable reserve-if-current serialized against revoke/re-pair and
 * have independently proven backup/restore custody.
 */
export class HttpsExternalGrantCas implements ExternalGrantCas {
  /** Validated HTTPS authority stored as a non-retargetable URL string. */
  private readonly endpoint:string;
  constructor(private readonly config:{
    endpoint:string;authorityId:string;timeoutMs?:number;
    /** Credential must come from a verified protected enrollment store. */
    credentialFor:(deviceId:string,deviceEpoch:string,sessionEpoch:string)=>
      Promise<string|undefined>;
  }){
    // Do not retain the caller's mutable configuration across async
    // credential acquisition or HTTP response verification.
    const pinned=immutableExternalConfig(config);
    if(typeof pinned.endpoint!=='string'||
       typeof pinned.credentialFor!=='function')
      reject('EXTERNAL_GRANT_CONFIG_INVALID');
    let endpoint:URL;
    try{endpoint=new URL(pinned.endpoint)}
    catch{throw new ExternalGrantTransportError('EXTERNAL_GRANT_URL_INVALID')}
    if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||
       endpoint.hash||endpoint.search||
       endpoint.pathname!=='/v1/grant-cas/reserve'||
       !uuid.safeParse(pinned.authorityId).success)
      reject('EXTERNAL_GRANT_URL_INVALID');
    this.endpoint=endpoint.href;
    this.config=pinned;
    // Prevent post-construction reassignment through runtime JS (TS private
    // and readonly annotations alone do not protect authority bindings).
    Object.defineProperty(this,'endpoint',{writable:false,configurable:false});
    Object.defineProperty(this,'config',{writable:false,configurable:false});
  }
  async reserveIfCurrent(
    input:CasRequest,authorization:AuthenticatedGrantScope,
  ):Promise<ExternalGrantCasReceipt>{
    const operation=Object.freeze(request.parse(plainCasRecordSnapshot(
      input,['deviceId','epoch','requestId','fingerprint','capability'],
      'EXTERNAL_GRANT_INPUT_INVALID',
    )));
    const bound=Object.freeze(scope.parse(plainCasRecordSnapshot(
      authorization,['ownerId','deviceId','deviceEpoch','sessionEpoch',
        'expectedGeneration','requiredPrivilege'],
      'EXTERNAL_GRANT_SCOPE_INVALID',
    )));
    if(operation.deviceId!==bound.deviceId||
       operation.epoch!==bound.deviceEpoch)
      reject('EXTERNAL_GRANT_SCOPE_INVALID');
    let token:string|undefined;
    try{token=await this.config.credentialFor(
      bound.deviceId,bound.deviceEpoch,bound.sessionEpoch)}
    catch{return reject('EXTERNAL_GRANT_CREDENTIAL_UNAVAILABLE')}
    if(!token||token.length<16)return reject('EXTERNAL_GRANT_CREDENTIAL_UNAVAILABLE');
    let response:Response;
    try{
      response=await fetch(this.endpoint,{
        method:'POST',redirect:'error',cache:'no-store',
        headers:{authorization:'Bearer '+token,'content-type':'application/json'},
        body:JSON.stringify({request:operation,scope:bound}),
        signal:AbortSignal.timeout(this.config.timeoutMs??3500),
      });
    }catch{return reject('EXTERNAL_GRANT_TRANSPORT_UNKNOWN')}
    if(!response.ok)return reject(httpOutcomeUncertain(response.status)
      ?'EXTERNAL_GRANT_TRANSPORT_UNKNOWN':'EXTERNAL_GRANT_AUTHORITY_REFUSED');
    let payload:string;
    try{payload=await response.text()}
    catch{return reject('EXTERNAL_GRANT_PROOF_INVALID')}
    if(payload.length>2048)return reject('EXTERNAL_GRANT_PROOF_INVALID');
    let decoded:unknown;
    try{decoded=JSON.parse(payload)}
    catch{return reject('EXTERNAL_GRANT_PROOF_INVALID')}
    const validated=result.safeParse(decoded);
    if(!validated.success)return reject('EXTERNAL_GRANT_PROOF_INVALID');
    const proof=validated.data;
    if(proof.authorityId!==this.config.authorityId||
       proof.deviceId!==operation.deviceId||proof.epoch!==operation.epoch||
       proof.requestId!==operation.requestId||
       proof.fingerprint!==operation.fingerprint||
       proof.capability!==operation.capability||
       proof.ownerId!==bound.ownerId||
       proof.sessionEpoch!==bound.sessionEpoch||
       proof.grantGeneration!==bound.expectedGeneration)
      reject('EXTERNAL_GRANT_PROOF_SCOPE_MISMATCH');
    return proof;
  }
  async revokeIfCurrent(value:ExternalRevokeRequest):Promise<ExternalRevokeReceipt>{
    const operation=Object.freeze(revokeRequest.parse(plainCasRecordSnapshot(
      value,['deviceId','ownerId','deviceEpoch','sessionEpoch',
        'expectedGeneration','signedOwnerApproval'],
      'EXTERNAL_REVOKE_INPUT_INVALID',
    )));
    let token:string|undefined;
    try{token=await this.config.credentialFor(
      operation.deviceId,operation.deviceEpoch,operation.sessionEpoch)}
    catch{return reject('EXTERNAL_GRANT_CREDENTIAL_UNAVAILABLE')}
    if(!token||token.length<16)
      return reject('EXTERNAL_GRANT_CREDENTIAL_UNAVAILABLE');
    let response:Response;
    try{
      response=await fetch(new URL('/v1/grant-cas/revoke',this.endpoint),{
        method:'POST',redirect:'error',cache:'no-store',
        headers:{authorization:'Bearer '+token,'content-type':'application/json'},
        body:JSON.stringify(operation),
        signal:AbortSignal.timeout(this.config.timeoutMs??3500),
      });
    }catch{return reject('EXTERNAL_REVOKE_OUTCOME_UNKNOWN')}
    if(!response.ok)return reject(httpOutcomeUncertain(response.status)
      ?'EXTERNAL_REVOKE_OUTCOME_UNKNOWN':'EXTERNAL_REVOKE_AUTHORITY_REFUSED');
    let payload:string;
    try{payload=await response.text()}
    catch{return reject('EXTERNAL_REVOKE_PROOF_INVALID')}
    if(payload.length>2048)return reject('EXTERNAL_REVOKE_PROOF_INVALID');
    let decoded:unknown;
    try{decoded=JSON.parse(payload)}
    catch{return reject('EXTERNAL_REVOKE_PROOF_INVALID')}
    const parsed=revokeReceipt.safeParse(decoded);
    if(!parsed.success)return reject('EXTERNAL_REVOKE_PROOF_INVALID');
    const data=parsed.data;
    if(data.authorityId!==this.config.authorityId||
       data.deviceId!==operation.deviceId||
       data.ownerId!==operation.ownerId||
       data.deviceEpoch!==operation.deviceEpoch||
       data.sessionEpoch!==operation.sessionEpoch||
       data.previousGeneration!==operation.expectedGeneration||
       data.generation<=operation.expectedGeneration)
      return reject('EXTERNAL_REVOKE_PROOF_SCOPE_MISMATCH');
    return data;
  }
  async rePairIfCurrent(value:ExternalRePairRequest):Promise<ExternalRePairReceipt>{
    const operation=Object.freeze(repairRequest.parse(plainCasRecordSnapshot(
      value,['deviceId','ownerId','deviceEpoch','sessionEpoch',
        'expectedGeneration','signedOwnerApproval','newOwnerId',
        'newDeviceEpoch','newSessionEpoch'],
      'EXTERNAL_REPAIR_INPUT_INVALID',
    )));
    if(operation.newDeviceEpoch===operation.deviceEpoch||
       operation.newSessionEpoch===operation.sessionEpoch)
      return reject('EXTERNAL_REPAIR_EPOCH_REUSE');
    let token:string|undefined;
    try{token=await this.config.credentialFor(
      operation.deviceId,operation.deviceEpoch,operation.sessionEpoch)}
    catch{return reject('EXTERNAL_GRANT_CREDENTIAL_UNAVAILABLE')}
    if(!token||token.length<16)return reject('EXTERNAL_GRANT_CREDENTIAL_UNAVAILABLE');
    let response:Response;
    try{response=await fetch(new URL('/v1/grant-cas/re-pair',this.endpoint),{
      method:'POST',redirect:'error',cache:'no-store',
      headers:{authorization:'Bearer '+token,'content-type':'application/json'},
      body:JSON.stringify(operation),
      signal:AbortSignal.timeout(this.config.timeoutMs??3500),
    })}catch{return reject('EXTERNAL_REPAIR_OUTCOME_UNKNOWN')}
    if(!response.ok)return reject(httpOutcomeUncertain(response.status)
      ?'EXTERNAL_REPAIR_OUTCOME_UNKNOWN':'EXTERNAL_REPAIR_AUTHORITY_REFUSED');
    let payload:string;
    try{payload=await response.text()}
    catch{return reject('EXTERNAL_REPAIR_PROOF_INVALID')}
    if(payload.length>2048)return reject('EXTERNAL_REPAIR_PROOF_INVALID');
    let parsed:unknown;
    try{parsed=JSON.parse(payload)}
    catch{return reject('EXTERNAL_REPAIR_PROOF_INVALID')}
    const validated=repairReceipt.safeParse(parsed);
    if(!validated.success)return reject('EXTERNAL_REPAIR_PROOF_INVALID');
    const data=validated.data;
    if(data.authorityId!==this.config.authorityId||
       data.deviceId!==operation.deviceId||
       data.ownerId!==operation.ownerId||
       data.deviceEpoch!==operation.deviceEpoch||
       data.sessionEpoch!==operation.sessionEpoch||
       data.previousGeneration!==operation.expectedGeneration||
       data.generation!==operation.expectedGeneration+1||
       data.newOwnerId!==operation.newOwnerId||
       data.newDeviceEpoch!==operation.newDeviceEpoch||
       data.newSessionEpoch!==operation.newSessionEpoch)
      return reject('EXTERNAL_REPAIR_PROOF_SCOPE_MISMATCH');
    return data;
  }
}
