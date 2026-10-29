import * as z from 'zod';
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
 * Production-wire HTTPS adapter for a separately enrolled monotonic CAS.
 *
 * IMPORTANT: This is a real transport/client implementation, NOT a hosted
 * service or physical-proof claim. The external server MUST implement an
 * atomic, durable reserve-if-current serialized against revoke/re-pair and
 * have independently proven backup/restore custody.
 */
export class HttpsExternalGrantCas implements ExternalGrantCas {
  private readonly endpoint:URL;
  constructor(private readonly config:{
    endpoint:string;authorityId:string;timeoutMs?:number;
    /** Credential must come from a verified protected enrollment store. */
    credentialFor:(deviceId:string,deviceEpoch:string,sessionEpoch:string)=>
      Promise<string|undefined>;
  }){
    let endpoint:URL;
    try{endpoint=new URL(config.endpoint)}
    catch{throw new ExternalGrantTransportError('EXTERNAL_GRANT_URL_INVALID')}
    if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||
       endpoint.hash||endpoint.search||
       endpoint.pathname!=='/v1/grant-cas/reserve'||
       !uuid.safeParse(config.authorityId).success)
      reject('EXTERNAL_GRANT_URL_INVALID');
    this.endpoint=endpoint;
  }
  async reserveIfCurrent(
    input:CasRequest,authorization:AuthenticatedGrantScope,
  ):Promise<ExternalGrantCasReceipt>{
    const operation=request.parse(input);
    const bound=scope.parse(authorization);
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
    if(!response.ok)return reject('EXTERNAL_GRANT_AUTHORITY_REFUSED');
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
    const operation=revokeRequest.parse(value);
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
    if(!response.ok)return reject('EXTERNAL_REVOKE_AUTHORITY_REFUSED');
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
    const operation=repairRequest.parse(value);
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
    if(!response.ok)return reject('EXTERNAL_REPAIR_AUTHORITY_REFUSED');
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
