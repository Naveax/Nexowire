import {createHash,createPrivateKey,createPublicKey,sign,verify,type KeyObject} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import type {DatabaseSync} from 'node:sqlite';
import {
  ProposedTrustedOwnerQuotaAuthority,
  type StagingOwnerQuotaDecision,
} from './trusted-owner-quota-authority-proposal.js';

/**
 * S2 DEV/STAGING: loopback-only RPC prototype on the TRUSTED OWNER host.
 * Never publicly listen, start an Agent, write billing, or expose SQLite.
 * A remote PC will eventually require a mutually authenticated TLS/named
 * tunnel to reach this origin: plain HTTP is allowed ONLY on loopback.
 *
 * Device Ed25519 keys are NOT the operator's route-signing private keys.
 * The owner DB pins/revokes each DEVICE public key separately. Device proof
 * does NOT replace the first-party account bearer or command permissions.
 */
const RPC_PATH='/internal/owner-quota/v1/reserve';
const MAX_BODY_BYTES=16*1024;
const MAX_SKEW_MS=30_000;
// Past this 3m window, the original signed request has expired and cannot
// authenticate; bounded nonce retention prevents unbounded disk growth.
const NONCE_RETENTION_MS=180_000;
const ID=/^[A-Za-z0-9_:.@-]{8,128}$/;
export interface SignedOwnerQuotaRpcBody {
  bearerToken:string;
  invocationId:string;
  toolId:string;
}
export interface SignedOwnerQuotaRpcEnvelope {
  version:1;
  deviceId:string;
  nonce:string;
  issuedAtMs:number;
  body:SignedOwnerQuotaRpcBody;
  signatureBase64url:string;
}
export interface TrustedToolDescriptor {
  operationClass:'read'|'write';
  toolFingerprint:string;
}
export interface TrustedOwnerQuotaRpcServerOptions {
  db:DatabaseSync;
  authority:ProposedTrustedOwnerQuotaAuthority;
  /** First-party, server-controlled catalog, not a client-supplied class. */
  trustedToolCatalog:ReadonlyMap<string,TrustedToolDescriptor>;
  now?:()=>Date;
}
function parseKeys(input:object,names:string[]):void {
  if(!input||Array.isArray(input)||Object.keys(input).sort().join('|')!==
    names.slice().sort().join('|')){
    throw new Error('RPC strict schema rejected');
  }
}
function validId(input:unknown):input is string {
  return typeof input==='string'&&ID.test(input);
}
function validTime(d:Date):number {
  if(!(d instanceof Date)||!Number.isSafeInteger(d.getTime())){
    throw new Error('Trusted owner RPC clock invalid');
  }
  return d.getTime();
}
function canonicalBytes(env:Omit<SignedOwnerQuotaRpcEnvelope,'signatureBase64url'>):Buffer{
  parseKeys(env,['version','deviceId','nonce','issuedAtMs','body']);
  parseKeys(env.body,['bearerToken','invocationId','toolId']);
  if(env.version!==1||!validId(env.deviceId)||!validId(env.nonce)||
    !Number.isSafeInteger(env.issuedAtMs)||
    !validId(env.body.invocationId)||
    !validId(env.body.toolId)||
    typeof env.body.bearerToken!=='string'||
    env.body.bearerToken.length<16||env.body.bearerToken.length>8192){
    throw new Error('RPC signed request invalid');
  }
  // Binding includes HTTP method + fixed path and every allowed payload field.
  return Buffer.from(JSON.stringify([
    'nexowire-owner-quota-rpc-v1','POST',RPC_PATH,
    env.version,env.deviceId,env.nonce,env.issuedAtMs,
    createHash('sha256').update(JSON.stringify([
      env.body.bearerToken,env.body.invocationId,env.body.toolId,
    ])).digest('hex'),
  ]));
}
function assertEd25519(key:KeyObject,expectedType:'public'|'private'){
  if(key.type!==expectedType||key.asymmetricKeyType!=='ed25519'){
    throw new Error('RPC device key must be Ed25519');
  }
}
/** DEV/test-side sample signing only, never ships a production key. */
export function signDevOwnerQuotaRpcEnvelope(input:{
  envelope:Omit<SignedOwnerQuotaRpcEnvelope,'signatureBase64url'>;
  devicePrivateKeyPem:string;
}):SignedOwnerQuotaRpcEnvelope {
  const key=createPrivateKey(input.devicePrivateKeyPem);
  assertEd25519(key,'private');
  return {
    ...input.envelope,
    signatureBase64url:sign(null,canonicalBytes(input.envelope),key)
      .toString('base64url'),
  };
}
type RpcReply={status:number;body:{error?:string;decision?:StagingOwnerQuotaDecision}};
function json(res:import('node:http').ServerResponse,result:RpcReply):void{
  res.writeHead(result.status,{
    'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store',
    'x-content-type-options':'nosniff',
  });
  res.end(JSON.stringify(result.body));
}
export async function startProposedOwnerQuotaLoopbackRpc(
  options:TrustedOwnerQuotaRpcServerOptions,
):Promise<{origin:string;close():Promise<void>}> {
  const clock=options.now??(()=>new Date());
  const processRequest=async(raw:unknown):Promise<RpcReply>=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw)){
      return {status:400,body:{error:'invalid_envelope'}};
    }
    const env=raw as SignedOwnerQuotaRpcEnvelope;
    let signedBytes:Buffer;
    try {
      parseKeys(env,['version','deviceId','nonce','issuedAtMs','body','signatureBase64url']);
      const {signatureBase64url:_,...claims}=env;
      signedBytes=canonicalBytes(claims);
      if(typeof env.signatureBase64url!=='string'||
        !/^[A-Za-z0-9_-]{86}$/.test(env.signatureBase64url)){
        throw new Error('RPC signature format invalid');
      }
    }catch {
      return {status:400,body:{error:'invalid_envelope'}};
    }
    let current:number;
    try {current=validTime(clock())}catch{
      return {status:503,body:{error:'trusted_clock_unavailable'}};
    }
    if(Math.abs(current-env.issuedAtMs)>MAX_SKEW_MS){
      return {status:401,body:{error:'stale_device_proof'}};
    }
    let nonceCommitted=false;
    try{
      options.db.exec('BEGIN IMMEDIATE');
      const last=options.db.prepare(
        'SELECT last_seen_ms FROM proposed_owner_rpc_clock WHERE clock_id=1',
      ).get() as {last_seen_ms:number}|undefined;
      if(last&&current<last.last_seen_ms){
        options.db.exec('ROLLBACK');
        return {status:503,body:{error:'owner_rpc_clock_rollback'}};
      }
      const row=options.db.prepare(
        'SELECT public_key_pem,enabled FROM proposed_owner_rpc_device_keys '+
        'WHERE device_id=?',
      ).get(env.deviceId) as {public_key_pem:string;enabled:number}|undefined;
      if(!row||row.enabled!==1){
        options.db.exec('ROLLBACK');
        return {status:401,body:{error:'device_proof_denied'}};
      }
      const pub=createPublicKey(row.public_key_pem);
      assertEd25519(pub,'public');
      if(!verify(null,signedBytes,pub,
        Buffer.from(env.signatureBase64url,'base64url'))){
        options.db.exec('ROLLBACK');
        return {status:401,body:{error:'device_proof_denied'}};
      }
      const prior=options.db.prepare(
        'SELECT 1 FROM proposed_owner_rpc_nonce_ledger '+
        'WHERE device_id=? AND nonce=?',
      ).get(env.deviceId,env.nonce);
      if(prior){
        options.db.exec('ROLLBACK');
        return {status:409,body:{error:'device_nonce_replayed'}};
      }
      options.db.prepare(
        'INSERT INTO proposed_owner_rpc_nonce_ledger '+
        '(device_id,nonce,issued_at_ms,consumed_at_ms) VALUES(?,?,?,?)',
      ).run(env.deviceId,env.nonce,env.issuedAtMs,current);
      options.db.prepare(
        'INSERT INTO proposed_owner_rpc_clock(clock_id,last_seen_ms) VALUES(1,?) '+
        'ON CONFLICT(clock_id) DO UPDATE SET last_seen_ms=excluded.last_seen_ms',
      ).run(current);
      // Retire only nonces whose signed timestamp can no longer be accepted.
      options.db.prepare(
        'DELETE FROM proposed_owner_rpc_nonce_ledger WHERE consumed_at_ms<?',
      ).run(current-NONCE_RETENTION_MS);
      options.db.exec('COMMIT');
      nonceCommitted=true;
    }catch {
      try{options.db.exec('ROLLBACK')}catch{
        // Storage authority cannot be trusted until explicitly recovered.
      }
      return {status:503,body:{error:'owner_device_proof_unavailable'}};
    }
    if(!nonceCommitted){
      return {status:503,body:{error:'owner_device_proof_unavailable'}};
    }
    // The authenticated device nonce is ALREADY consumed. Invalid tool /
    // bearer cannot be replayed later using the same signed request.
    const trustedTool=options.trustedToolCatalog.get(env.body.toolId);
    if(!trustedTool || !/^[a-f0-9]{64}$/.test(trustedTool.toolFingerprint)||
      (trustedTool.operationClass!=='read'&&trustedTool.operationClass!=='write')){
      return {status:403,body:{error:'unavailable_tool'}};
    }
    try{
      const decision=await options.authority.reserveLogicalTool({
        bearerToken:env.body.bearerToken,
        deviceId:env.deviceId,
        invocationId:env.body.invocationId,
        toolFingerprint:trustedTool.toolFingerprint,
        operationClass:trustedTool.operationClass,
      });
      return {status:200,body:{decision}};
    }catch {
      return {status:503,body:{error:'trusted_quota_unavailable'}};
    }
  };
  const server=createServer(async(req,res)=>{
    // RPC is server-local and is NOT a public MCP endpoint. No forwarded IP
    // or Host metadata is used to authenticate a device or choose an account.
    if(req.method!=='POST'||req.url!==RPC_PATH){
      json(res,{status:404,body:{error:'not_found'}});return;
    }
    if(req.headers['content-type']!=='application/json'){
      json(res,{status:415,body:{error:'unsupported_media_type'}});return;
    }
    const hinted=Number(req.headers['content-length']);
    if((req.headers['content-length']!==undefined &&
      (!Number.isSafeInteger(hinted)||hinted>MAX_BODY_BYTES||hinted<0))){
      json(res,{status:413,body:{error:'rpc_body_too_large'}});return;
    }
    let body='';
    let size=0;
    try{
      for await(const c of req){
        const chunk=c as Buffer;
        size+=chunk.length;
        if(size>MAX_BODY_BYTES)throw new Error('max bytes');
        body+=chunk.toString('utf8');
      }
    }catch{
      if(!res.headersSent)json(res,{status:413,body:{error:'rpc_body_too_large'}});
      return;
    }
    let parsed:unknown;
    try{parsed=JSON.parse(body)}catch{
      json(res,{status:400,body:{error:'invalid_json'}});return;
    }
    json(res,await processRequest(parsed));
  });
  server.requestTimeout=5000;
  server.headersTimeout=5000;
  server.maxConnections=32;
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    // Loopback binding INSIDE this API, never caller-selectable 0.0.0.0.
    server.listen(0,'127.0.0.1',()=>{
      server.off('error',reject);resolve();
    });
  });
  const addr=server.address() as AddressInfo;
  return {
    origin:'http://127.0.0.1:'+addr.port+RPC_PATH,
    async close(){
      server.closeAllConnections();
      await new Promise<void>((resolve,reject)=>
        server.close(err=>err?reject(err):resolve()));
    },
  };
}
