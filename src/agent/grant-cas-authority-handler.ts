import type {IncomingMessage,ServerResponse} from 'node:http';
import type {TLSSocket} from 'node:tls';
import * as z from 'zod';
import type {CasRequest} from './remote-mutation-cas.js';
import type {AuthenticatedGrantScope,ExternalGrantCasReceipt,
  ExternalRevokeRequest,ExternalRevokeReceipt,ExternalRePairRequest,
  ExternalRePairReceipt} from './postgres-bound-grant-cas.js';

const id=z.string().uuid();
const nonce=z.string().regex(/^[0-9a-f]{64}$/);
const principal=z.object({ownerId:id,deviceId:id,deviceEpoch:id,sessionEpoch:id}).strict();
const request=z.object({deviceId:id,epoch:id,requestId:id,
  fingerprint:z.string().regex(/^[0-9a-f]{64}$/),
  capability:z.string().min(1).max(128)}).strict();
const scope=z.object({ownerId:id,deviceId:id,deviceEpoch:id,sessionEpoch:id,
  expectedGeneration:z.number().int().positive().safe(),
  requiredPrivilege:z.enum(['NORMAL','CORE','ROOT'])}).strict();
const reserve=z.object({request,scope,challengeNonce:nonce}).strict();
const revoke=z.object({deviceId:id,ownerId:id,deviceEpoch:id,sessionEpoch:id,
  expectedGeneration:z.number().int().positive().safe(),
  signedOwnerApproval:z.string().min(32).max(8192),challengeNonce:nonce}).strict();
const repair=revoke.extend({newOwnerId:id,newDeviceEpoch:id,newSessionEpoch:id}).strict();
const reserved=z.object({challengeNonce:nonce,authorityId:id,deviceId:id,epoch:id,
  requestId:id,ownerId:id,sessionEpoch:id,grantGeneration:z.number().int().positive().safe(),
  fingerprint:z.string().regex(/^[0-9a-f]{64}$/),capability:z.string().min(1).max(128),
  created:z.boolean(),sequence:z.number().int().positive().safe()}).strict();
const revoked=z.object({challengeNonce:nonce,authorityId:id,deviceId:id,ownerId:id,
  deviceEpoch:id,sessionEpoch:id,previousGeneration:z.number().int().positive().safe(),
  generation:z.number().int().positive().safe(),revoked:z.literal(true)}).strict();
const repaired=revoked.extend({newOwnerId:id,newDeviceEpoch:id,newSessionEpoch:id,
  coreCleared:z.literal(true)}).strict();
type GrantPrincipal=z.infer<typeof principal>;
type Challenged<T>=T&{challengeNonce:string};

/**
 * The backend must atomically perform each operation against independently
 * durable current grant state and request tombstones. The original challenge
 * MUST reach that authority; this handler must never add it to a cached result.
 * This interface and its return type do not prove a backend is independent.
 */
export interface ChallengedGrantCasAuthority {
  reserveIfCurrent(op:CasRequest,scope:AuthenticatedGrantScope,
    challengeNonce:string):Promise<Challenged<ExternalGrantCasReceipt>>;
  revokeIfCurrent(op:ExternalRevokeRequest,
    challengeNonce:string):Promise<Challenged<ExternalRevokeReceipt>>;
  rePairIfCurrent(op:ExternalRePairRequest,
    challengeNonce:string):Promise<Challenged<ExternalRePairReceipt>>;
}

/**
 * Wire adapter only, with no built-in authority, key, listener or credentials.
 * The TLS endpoint authenticates a separately enrolled principal, not a scope
 * supplied by the caller. A real backend must check current grant and expiry
 * atomically with the reservation/revoke/re-pair and preserve all tombstones
 * across restores. Neither TLS nor a challenge proves that physical property.
 */
export function createGrantCasAuthorityHandler(config:{
  authorityId:string;authority:ChallengedGrantCasAuthority;
  authenticateDevice:(credential:string)=>Promise<GrantPrincipal|undefined>;
  verifyOwnerApproval:(op:ExternalRevokeRequest|ExternalRePairRequest,
    kind:'revoke'|'re_pair')=>Promise<boolean>;
}):(req:IncomingMessage,res:ServerResponse)=>void{
  if(!id.safeParse(config.authorityId).success||!config.authority||
     typeof config.authority.reserveIfCurrent!=='function'||
     typeof config.authority.revokeIfCurrent!=='function'||
     typeof config.authority.rePairIfCurrent!=='function'||
     typeof config.authenticateDevice!=='function'||
     typeof config.verifyOwnerApproval!=='function')
    throw new Error('GRANT_HANDLER_CONFIG_INVALID');
  const authority=config.authority,authorityId=config.authorityId;
  const authenticateDevice=config.authenticateDevice,verifyOwnerApproval=config.verifyOwnerApproval;
  const scoped=(p:GrantPrincipal,s:{ownerId:string;deviceId:string;
    deviceEpoch:string;sessionEpoch:string})=>p.ownerId===s.ownerId&&
    p.deviceId===s.deviceId&&p.deviceEpoch===s.deviceEpoch&&p.sessionEpoch===s.sessionEpoch;
  const respond=(res:ServerResponse,status:number,value:unknown)=>{
    if(res.headersSent||res.destroyed)return;
    res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify(value));
  };
  return (req,res)=>{
    void(async()=>{
      if(!(req.socket as TLSSocket).encrypted){respond(res,403,{error:'denied'});return}
      const action=req.url?.match(/^\/v1\/grant-cas\/(reserve|revoke|re-pair)$/)?.[1];
      if(req.method!=='POST'||!action){respond(res,404,{error:'not_found'});return}
      const auth=req.headers.authorization?.match(/^Bearer ([^\s]{16,4096})$/);
      if(!auth){respond(res,403,{error:'denied'});return}
      let found:GrantPrincipal|undefined;
      try{found=await authenticateDevice(auth[1]!)}catch{}
      const parsedPrincipal=principal.safeParse(found);
      if(!parsedPrincipal.success){respond(res,403,{error:'denied'});return}
      const p=Object.freeze(parsedPrincipal.data),limit=16384;
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
      if(action==='reserve'){
        const parsed=reserve.safeParse(body);
        if(!parsed.success){respond(res,400,{error:'invalid_request'});return}
        const {request:op,scope:bound,challengeNonce}=parsed.data;
        if(!scoped(p,bound)||op.deviceId!==bound.deviceId||op.epoch!==bound.deviceEpoch){
          respond(res,403,{error:'denied'});return;
        }
        Object.freeze(op);Object.freeze(bound);
        const proof=reserved.safeParse(await authority.reserveIfCurrent(op,bound,challengeNonce));
        if(!proof.success){respond(res,503,{error:'unavailable'});return}
        const r=proof.data;
        if(r.challengeNonce!==challengeNonce||r.authorityId!==authorityId||
           r.deviceId!==op.deviceId||r.epoch!==op.epoch||r.requestId!==op.requestId||
           r.fingerprint!==op.fingerprint||r.capability!==op.capability||
           r.ownerId!==bound.ownerId||r.sessionEpoch!==bound.sessionEpoch||
           r.grantGeneration!==bound.expectedGeneration){
          respond(res,503,{error:'unavailable'});return;
        }
        respond(res,200,r);return;
      }
      const parsed=(action==='revoke'?revoke:repair).safeParse(body);
      if(!parsed.success){respond(res,400,{error:'invalid_request'});return}
      const {challengeNonce,...op}=parsed.data;
      if(!scoped(p,op)){respond(res,403,{error:'denied'});return}
      const kind=action==='revoke'?'revoke':'re_pair';
      if(kind==='re_pair'){
        const repairOp=op as ExternalRePairRequest;
        if(repairOp.newDeviceEpoch===repairOp.deviceEpoch||
           repairOp.newSessionEpoch===repairOp.sessionEpoch){
          respond(res,403,{error:'denied'});return;
        }
      }
      Object.freeze(op);
      if(await verifyOwnerApproval(op,kind)!==true){respond(res,403,{error:'denied'});return}
      const raw=kind==='revoke'?await authority.revokeIfCurrent(op,challengeNonce):
        await authority.rePairIfCurrent(op as ExternalRePairRequest,challengeNonce);
      const proof=(kind==='revoke'?revoked:repaired).safeParse(raw);
      if(!proof.success){respond(res,503,{error:'unavailable'});return}
      const r=proof.data;
      if(r.challengeNonce!==challengeNonce||r.authorityId!==authorityId||
         r.deviceId!==op.deviceId||r.ownerId!==op.ownerId||
         r.deviceEpoch!==op.deviceEpoch||r.sessionEpoch!==op.sessionEpoch||
         r.previousGeneration!==op.expectedGeneration||r.generation!==op.expectedGeneration+1){
        respond(res,503,{error:'unavailable'});return;
      }
      if(kind==='re_pair'){
        const result=r as z.infer<typeof repaired>,requested=op as ExternalRePairRequest;
        if(result.newOwnerId!==requested.newOwnerId||
           result.newDeviceEpoch!==requested.newDeviceEpoch||
           result.newSessionEpoch!==requested.newSessionEpoch){
          respond(res,503,{error:'unavailable'});return;
        }
      }
      respond(res,200,r);
    })().catch(()=>respond(res,503,{error:'unavailable'}));
  };
}
