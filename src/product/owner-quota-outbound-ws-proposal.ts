import {createServer,type RequestListener} from 'node:http';
import {createServer as createSecureServer} from 'node:https';
import {checkServerIdentity} from 'node:tls';
import {X509Certificate} from 'node:crypto';
import type {AddressInfo,Socket} from 'node:net';
import WebSocket,{WebSocketServer} from 'ws';
import type {SignedOwnerQuotaRpcEnvelope} from './owner-quota-loopback-rpc-proposal.js';
import {verifyOwnerRpcLoopbackDestination,
  resolvePinnedTailscaleInterface,isTailscalePrivateIPv4}
  from './owner-quota-tailscale-proxy-proposal.js';

/**
 * DEV/STAGING only. A remote PC would initiate an OUTBOUND WSS connection
 * to an owner-accessible authenticated endpoint; no inbound customer port.
 * THIS proof listens on OWNER 127.0.0.1 ONLY, with plaintext WS restricted
 * to loopback and no deployed TLS/public tunnel.
 *
 * WS connectivity is NOT authentication. The exact signed device envelope is
 * passed to the existing owner HTTP RPC, which independently verifies pinned
 * device Ed25519 public key, nonce, account epoch, device owner/permissions
 * and subscription quota. A quota reply does not authorize native execution.
 */
const WS_PATH='/internal/owner-quota/v1/outbound';
const MAX_FRAME=16*1024;
const MAX_RESPONSE=16*1024;
const MAX_WS_CLIENTS=16;
const MAX_PENDING_PER_CLIENT=16;
const RPC_TIMEOUT=4000;
const REQUEST_ID=/^[a-zA-Z0-9_.:-]{8,128}$/;

export type OutboundQuotaFrame={
  version:1;
  kind:'reserve';
  requestId:string;
  envelope:SignedOwnerQuotaRpcEnvelope;
};
export type OutboundQuotaReply={
  version:1;
  kind:'decision';
  requestId:string;
  httpStatus:number;
  data:unknown;
};
function exactKeys(value:unknown,keys:readonly string[]):boolean{
  return typeof value==='object'&&value!==null&&!Array.isArray(value)&&
    Object.keys(value).sort().join('|')===keys.slice().sort().join('|');
}
function validFrame(value:unknown):value is OutboundQuotaFrame{
  if(!exactKeys(value,['version','kind','requestId','envelope']))return false;
  const v=value as OutboundQuotaFrame;
  return v.version===1&&v.kind==='reserve'&&
    typeof v.requestId==='string'&&REQUEST_ID.test(v.requestId)&&
    typeof v.envelope==='object'&&v.envelope!==null;
}
function serializeReply(input:OutboundQuotaReply):string{
  const data=JSON.stringify(input);
  if(Buffer.byteLength(data,'utf8')>MAX_RESPONSE){
    throw new Error('Owner quota response too large');
  }
  return data;
}
function wsDecision(socket:WebSocket,reply:OutboundQuotaReply){
  if(socket.readyState!==WebSocket.OPEN)return;
  try{socket.send(serializeReply(reply))}catch{
    socket.terminate();
  }
}
function reject(socket:WebSocket,id:string,status:number,error:string){
  wsDecision(socket,{version:1,kind:'decision',requestId:id,
    httpStatus:status,data:{error}});
}
export type StagingOwnerWssIdentity={
  /** Trusted operator CA certificate (not supplied by an HTTP caller). */
  trustedCaPem:string;
  /** Exact SHA-256 certificate fingerprint pinned by operator enrollment. */
  expectedLeafSha256:string;
  /** DEV private overlay only: operator-pinned server Tailnet IPv4. */
  expectedTailscaleIPv4?:string;
};
export type StagingOwnerWssTlsConfig={
  /** Trusted DEV private key. Never shipped in customer bundle. */
  privateKeyPem:string;
  certificatePem:string;
};
export function verifyStagingQuotaWsUrl(
  value:string,secure=false,expectedTailscaleIPv4?:string,
):string{
  let u:URL;
  try{u=new URL(value)}catch{throw new Error('Invalid staging outbound WS URL')}
  if(expectedTailscaleIPv4 &&
    !isTailscalePrivateIPv4(expectedTailscaleIPv4)){
    throw new Error('Invalid pinned owner Tailnet IPv4');
  }
  if(u.protocol!==(secure?'wss:':'ws:')||
    u.hostname!==(expectedTailscaleIPv4??'127.0.0.1')||
    (expectedTailscaleIPv4 && !secure)||
    !u.port||u.pathname!==WS_PATH||
    u.search||u.hash||u.username||u.password){
    throw new Error('STAGING WS may connect only to exact loopback hub');
  }
  return u.toString();
}
export async function startProposedOwnerQuotaOutboundWsHub(input:{
  trustedOwnerRpcOrigin:string;
  fetchImpl?:typeof fetch;
  /** Optional TLS1.3-only loopback test. Not a production public listener. */
  tls?:StagingOwnerWssTlsConfig;
  /** DEV only: bind WSS to a VERIFIED local Tailscale adapter, never WAN. */
  stagingTailscaleIPv4?:string;
}):Promise<{url:string;close():Promise<void>}> {
  const rpcUrl=verifyOwnerRpcLoopbackDestination(input.trustedOwnerRpcOrigin);
  if(input.stagingTailscaleIPv4 && !input.tls){
    throw new Error('Private overlay owner quota WS requires TLS 1.3');
  }
  // Resolves ONLY the real OS Tailscale adapter; an arbitrary bound
  // 100.64/10 address or X-Forwarded-* HTTP header is not sufficient.
  const tailnet=input.stagingTailscaleIPv4
    ?resolvePinnedTailscaleInterface(input.stagingTailscaleIPv4):undefined;
  const bindIp=tailnet?.address??'127.0.0.1';
  const call=input.fetchImpl??fetch;
  const connections=new Set<WebSocket>();
  const notFound:RequestListener=(_req,res)=>{
    res.writeHead(404,{'cache-control':'no-store'});res.end();
  };
  const httpServer=input.tls
    ?createSecureServer({
      key:input.tls.privateKeyPem,
      cert:input.tls.certificatePem,
      minVersion:'TLSv1.3',maxVersion:'TLSv1.3',
    },notFound)
    :createServer(notFound);
  const server=new WebSocketServer({
    noServer:true,maxPayload:MAX_FRAME,
    clientTracking:true,perMessageDeflate:false,
  });
  httpServer.on('upgrade',(req,socket,head)=>{
    const tcp=socket as Socket;
    const peer=(tcp.remoteAddress??'').replace(/^::ffff:/,'');
    if(tcp.localAddress!==bindIp ||
      (tailnet && !isTailscalePrivateIPv4(peer)) ||
      req.url!==WS_PATH||req.method!=='GET'||connections.size>=MAX_WS_CLIENTS){
      socket.destroy();return;
    }
    server.handleUpgrade(req,socket,head,ws=>{
      connections.add(ws);
      ws.on('close',()=>connections.delete(ws));
      server.emit('connection',ws,req);
    });
  });
  server.on('connection',socket=>{
    const pending=new Set<string>();
    socket.on('message',raw=>{
      if(socket.readyState!==WebSocket.OPEN)return;
      let frame:unknown;
      try{frame=JSON.parse(raw.toString())}catch{
        socket.close(1008,'invalid_json');return;
      }
      if(!validFrame(frame)){
        socket.close(1008,'invalid_frame');return;
      }
      if(pending.has(frame.requestId)){
        reject(socket,frame.requestId,409,'request_pending');return;
      }
      if(pending.size>=MAX_PENDING_PER_CLIENT){
        reject(socket,frame.requestId,429,'ws_inflight_budget');return;
      }
      const request=frame;
      pending.add(request.requestId);
      void (async()=>{
        try{
          const content=JSON.stringify(request.envelope);
          if(Buffer.byteLength(content)>MAX_FRAME){
            reject(socket,request.requestId,413,'signed_envelope_too_large');return;
          }
          let upstream:Response;
          try{
            upstream=await call(rpcUrl,{
              method:'POST',
              headers:{'content-type':'application/json'},
              body:content,
              signal:AbortSignal.timeout(RPC_TIMEOUT),
              redirect:'error',
            });
          }catch{
            reject(socket,request.requestId,503,'owner_rpc_offline');return;
          }
          if(!Number.isInteger(upstream.status)||upstream.status<100||
            upstream.status>599){
            reject(socket,request.requestId,502,'owner_rpc_invalid_status');return;
          }
          const reader=upstream.body?.getReader();
          if(!reader){
            reject(socket,request.requestId,502,'owner_rpc_empty_response');return;
          }
          const chunks:Buffer[]=[];
          let size=0;
          while(true){
            const part=await reader.read();
            if(part.done)break;
            size+=part.value.byteLength;
            if(size>MAX_RESPONSE){
              await reader.cancel();
              reject(socket,request.requestId,502,'owner_rpc_oversized_response');
              return;
            }
            chunks.push(Buffer.from(part.value));
          }
          let data:unknown;
          try{data=JSON.parse(Buffer.concat(chunks,size).toString('utf8'))}catch{
            reject(socket,request.requestId,502,'owner_rpc_bad_json');return;
          }
          wsDecision(socket,{
            version:1,kind:'decision',requestId:request.requestId,
            httpStatus:upstream.status,data,
          });
        }catch{
          reject(socket,request.requestId,503,'owner_rpc_bridge_unavailable');
        }finally{
          pending.delete(request.requestId);
        }
      })();
    });
  });
  httpServer.headersTimeout=5000;
  httpServer.requestTimeout=5000;
  httpServer.maxConnections=MAX_WS_CLIENTS+4;
  await new Promise<void>((resolve,reject)=>{
    httpServer.once('error',reject);
    httpServer.listen(0,bindIp,()=>{
      httpServer.off('error',reject);resolve();
    });
  });
  const addr=httpServer.address() as AddressInfo;
  return {
    url:(input.tls?'wss://':'ws://')+addr.address+':'+addr.port+WS_PATH,
    async close(){
      for(const ws of connections)ws.terminate();
      await new Promise<void>(resolve=>server.close(()=>resolve()));
      httpServer.closeAllConnections();
      await new Promise<void>((resolve,reject)=>
        httpServer.close(err=>err?reject(err):resolve()));
    },
  };
}

/**
 * STAGING client dials outward; it never listens. Caller must create a NEW
 * device-signed nonce for each transport retry while keeping the original
 * logical invocation ID for owner-side exactly-once charging. This client
 * NEVER retries a security-sensitive tool automatically.
 */
export class ProposedOutboundQuotaWsClient {
  private readonly socket:WebSocket;
  private readonly seenRequestIds=new Set<string>();
  private readonly outstanding=new Map<string,{
    resolve:(result:OutboundQuotaReply)=>void;
    reject:(err:Error)=>void;
    timeout:ReturnType<typeof setTimeout>;
  }>();
  private readyPromise:Promise<void>;
  constructor(url:string,identity?:StagingOwnerWssIdentity){
    const secure=!!identity;
    const verifiedUrl=verifyStagingQuotaWsUrl(
      url,secure,identity?.expectedTailscaleIPv4,
    );
    let secureOptions:{}={};
    if(identity){
      const {trustedCaPem,expectedLeafSha256}=identity;
      if(typeof trustedCaPem!=='string'||!trustedCaPem.includes('BEGIN CERTIFICATE')||
        !/^[a-fA-F0-9]{64}$/.test(expectedLeafSha256)){
        throw new Error('Untrusted WSS server identity configuration');
      }
      secureOptions={
        ca:trustedCaPem,rejectUnauthorized:true,
        minVersion:'TLSv1.3' as const,maxVersion:'TLSv1.3' as const,
        checkServerIdentity:(host:string,cert:import('node:tls').PeerCertificate)=>{
          // Never replace standard certificate-chain/hostname validation
          // with a fingerprint comparison alone.
          const identityError=checkServerIdentity(host,cert);
          if(identityError)return identityError;
          const actual=new X509Certificate(cert.raw).fingerprint256
            .replaceAll(':','').toLowerCase();
          if(actual!==expectedLeafSha256.toLowerCase()){
            return new Error('Pinned owner WSS server certificate mismatch');
          }
          return undefined;
        },
      };
    }
    this.socket=new WebSocket(verifiedUrl,{
      perMessageDeflate:false,handshakeTimeout:4000,...secureOptions,
    });
    this.readyPromise=new Promise<void>((resolve,reject)=>{
      this.socket.once('open',()=>resolve());
      this.socket.once('error',err=>reject(err));
      this.socket.once('close',()=>reject(new Error('Owner WS closed')));
    });
    this.socket.on('message',raw=>{
      let msg:unknown;
      try{msg=JSON.parse(raw.toString())}catch{
        this.rejectAll('Invalid owner WS response');this.socket.terminate();return;
      }
      if(!exactKeys(msg,['version','kind','requestId','httpStatus','data'])){
        this.rejectAll('Invalid owner WS response');this.socket.terminate();return;
      }
      const reply=msg as OutboundQuotaReply;
      if(reply.version!==1||reply.kind!=='decision'||
        typeof reply.requestId!=='string'||!REQUEST_ID.test(reply.requestId)||
        !Number.isInteger(reply.httpStatus)||
        reply.httpStatus<100||reply.httpStatus>599){
        this.rejectAll('Invalid owner WS response');this.socket.terminate();return;
      }
      const found=this.outstanding.get(reply.requestId);
      if(!found)return; // Never route an unrelated reply to another request.
      this.outstanding.delete(reply.requestId);
      clearTimeout(found.timeout);
      found.resolve(reply);
    });
    this.socket.on('close',()=>this.rejectAll('Owner WS disconnected'));
    this.socket.on('error',()=>this.rejectAll('Owner WS connection error'));
  }
  private rejectAll(reason:string){
    for(const [id,p] of this.outstanding){
      this.outstanding.delete(id);clearTimeout(p.timeout);
      p.reject(new Error(reason));
    }
  }
  async reserve(input:OutboundQuotaFrame,timeoutMs=5000):Promise<OutboundQuotaReply>{
    if(!validFrame(input))throw new Error('Invalid signed transport frame');
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000){
      throw new Error('Unbounded WS request timeout');
    }
    await this.readyPromise;
    if(this.socket.readyState!==WebSocket.OPEN){
      throw new Error('Owner WS not connected');
    }
    // Never let a late reply from a timed-out request resolve a later call
    // that recycled the same correlation ID on this connection.
    if(this.seenRequestIds.has(input.requestId)||
      this.outstanding.size>=MAX_PENDING_PER_CLIENT){
      throw new Error('Duplicate or excessive pending WS request');
    }
    // Bound correlation-ID memory by requiring a fresh connection instead
    // of silently forgetting old request IDs (which permits stale replies).
    if(this.seenRequestIds.size>=100_000){
      throw new Error('Outbound WS correlation lifetime exhausted');
    }
    this.seenRequestIds.add(input.requestId);
    return new Promise<OutboundQuotaReply>((resolve,reject)=>{
      const timeout=setTimeout(()=>{
        this.outstanding.delete(input.requestId);
        reject(new Error('Owner WS request timed out'));
      },timeoutMs);
      this.outstanding.set(input.requestId,{resolve,reject,timeout});
      try{
        this.socket.send(JSON.stringify(input),err=>{
          if(err){
            const p=this.outstanding.get(input.requestId);
            if(p){
              this.outstanding.delete(input.requestId);
              clearTimeout(p.timeout);
              reject(err);
            }
          }
        });
      }catch(e){
        this.outstanding.delete(input.requestId);
        clearTimeout(timeout);
        reject(e instanceof Error?e:new Error('WS send failure'));
      }
    });
  }
  close(){
    this.rejectAll('Client explicitly closed');
    this.socket.close();
  }
}
