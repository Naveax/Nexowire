import {createServer,type IncomingMessage,type ServerResponse,type Server} from 'node:http';
import {isIP, type AddressInfo} from 'node:net';
import {networkInterfaces,type NetworkInterfaceInfo} from 'node:os';

const RPC_PATH='/internal/owner-quota/v1/reserve';
const MAX_BODY_BYTES=16*1024;
const RPC_TIMEOUT_MS=5000;
const MAX_CONCURRENT=32;
type Interfaces=Record<string,NetworkInterfaceInfo[]|undefined>;
export interface OverlayBinding {
  interfaceName:string;
  address:string;
}
function ipv4Int(ip:string):number{
  if(isIP(ip)!==4)throw new Error('Expected IPv4');
  return ip.split('.').reduce((v,octet)=>(v*256+Number(octet))>>>0,0);
}
export function isTailscalePrivateIPv4(ip:string):boolean {
  try{return (ipv4Int(ip) & 0xffc00000)===0x64400000;}catch{return false}
}
export function resolvePinnedTailscaleInterface(
  expectedIp:string,
  adapters:Interfaces=networkInterfaces(),
):OverlayBinding {
  if(!isTailscalePrivateIPv4(expectedIp)){
    throw new Error('Tailscale private 100.64.0.0/10 IP required');
  }
  const matches:OverlayBinding[]=[];
  for(const [name,items] of Object.entries(adapters)){
    for(const info of items??[]){
      if(info.family==='IPv4' && info.address===expectedIp &&
        !info.internal && /^tailscale(?:\s|$)/i.test(name)){
        matches.push({interfaceName:name,address:expectedIp});
      }
    }
  }
  if(matches.length!==1)throw new Error('Trusted Tailscale adapter missing or ambiguous');
  return matches[0]!;
}
function error(res:ServerResponse,status:number,message:string):void {
  res.writeHead(status,{
    'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store',
    'x-content-type-options':'nosniff',
  });
  res.end(JSON.stringify({error:message}));
}
export interface OwnerQuotaOverlayProxySettings{
  expectedTailscaleIPv4:string;
  /** The LOCAL loopback RPC origin; raw customer provided upstreams forbidden. */
  trustedOwnerRpcOrigin:string;
}
export function verifyOwnerRpcLoopbackDestination(value:string):string{
  let url:URL;
  try{url=new URL(value)}catch{
    throw new Error('Invalid owner RPC loopback destination');
  }
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||
    !url.port||!Number.isInteger(Number(url.port))||
    Number(url.port)<1||Number(url.port)>65535||
    url.pathname!==RPC_PATH||url.search||url.hash||url.username||
    url.password){
    throw new Error('Only the exact 127.0.0.1 owner quota RPC is allowed');
  }
  return url.toString();
}
export function makeOwnerQuotaOverlayRequestHandler(input:{
  trustedOwnerRpcOrigin:string;
  /** Bound socket IP from the server; never read forwarded client headers. */
  expectedSocketLocalIPv4:string;
  fetchImpl?:typeof fetch;
}): (req:IncomingMessage,res:ServerResponse)=>Promise<void> {
  const upstream=verifyOwnerRpcLoopbackDestination(input.trustedOwnerRpcOrigin);
  const call=input.fetchImpl??fetch;
  let inFlight=0;
  return async(req,res)=>{
    if(req.socket.localAddress!==input.expectedSocketLocalIPv4){
      error(res,403,'unexpected_overlay_socket');return;
    }
    // Routing hard stop. WebSocket /agent is NOT forwarded and cannot be
    // upgraded by this handler. Host is not a routing or auth authority.
    if(req.method!=='POST'||req.url!==RPC_PATH){
      error(res,404,'not_found');return;
    }
    if(req.headers['content-type']!=='application/json'){
      error(res,415,'unsupported_media_type');return;
    }
    const remote=(req.socket.remoteAddress??'').replace(/^::ffff:/,'');
    if(!isTailscalePrivateIPv4(remote) &&
      remote!=='127.0.0.1' &&
      remote!==input.expectedSocketLocalIPv4){
      error(res,403,'peer_not_in_tailscale_overlay');return;
    }
    const hint=req.headers['content-length'];
    const number=hint===undefined?NaN:Number(hint);
    if(hint!==undefined&&(!Number.isSafeInteger(number)||number<0||
      number>MAX_BODY_BYTES)){
      error(res,413,'body_too_large');return;
    }
    if(inFlight>=MAX_CONCURRENT){
      error(res,503,'owner_quota_gateway_busy');return;
    }
    inFlight++;
    try{
      const chunks:Buffer[]=[];
      let size=0;
      try{
        for await(const raw of req){
          const chunk=raw as Buffer;
          size+=chunk.length;
          if(size>MAX_BODY_BYTES)throw new Error('Body too large');
          chunks.push(chunk);
        }
      }catch{
        error(res,413,'body_too_large');return;
      }
      const outgoing=Buffer.concat(chunks,size);
      let upstreamResponse:Response;
      try {
        // No client supplied URL, method, Host, Authorization, Cookie, or
        // Forwarded headers are propagated. The signed body is relayed as-is.
        upstreamResponse=await call(upstream,{
          method:'POST',
          headers:{'content-type':'application/json'},
          body:outgoing,
          redirect:'error',
          signal:AbortSignal.timeout(RPC_TIMEOUT_MS),
        });
      }catch{
        error(res,503,'owner_quota_rpc_unavailable');return;
      }
      const reader=upstreamResponse.body?.getReader();
      if(!reader){error(res,502,'upstream_response_missing');return}
      const output:Buffer[]=[];
      let total=0;
      while(true){
        const part=await reader.read();
        if(part.done)break;
        total+=part.value.byteLength;
        if(total>MAX_BODY_BYTES){
          await reader.cancel();
          error(res,502,'upstream_response_oversized');return;
        }
        output.push(Buffer.from(part.value));
      }
      const body=Buffer.concat(output,total);
      res.writeHead(upstreamResponse.status,{
        'content-type':'application/json; charset=utf-8',
        'cache-control':'no-store',
        'x-content-type-options':'nosniff',
      });
      res.end(body);
    }catch{
      if(!res.headersSent)error(res,503,'owner_quota_gateway_unavailable');
    }finally{inFlight--;}
  };
}
/**
 * The listener binds ONLY to an existing, pinned IPv4 address on the real
 * Tailscale virtual network adapter. Actual internet carrier encryption
 * is provided by the Tailscale private overlay, not this plain HTTP hop.
 * Dev-only, not connected to deployed Hub or native Agent CLI.
 */
export async function startProposedOwnerQuotaTailscaleProxy(
  settings:OwnerQuotaOverlayProxySettings,
):Promise<{origin:string;close:()=>Promise<void>}>{
  const resolved=resolvePinnedTailscaleInterface(settings.expectedTailscaleIPv4);
  const handle=makeOwnerQuotaOverlayRequestHandler({
    trustedOwnerRpcOrigin:settings.trustedOwnerRpcOrigin,
    expectedSocketLocalIPv4:resolved.address,
  });
  const server=createServer((req,res)=>{void handle(req,res)});
  // WebSocket and arbitrary upgrade protocols are never forwarded.
  server.on('upgrade',(_req,socket)=>socket.destroy());
  server.requestTimeout=5000;
  server.headersTimeout=5000;
  server.maxConnections=32;
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen({host:resolved.address,port:0},()=>{
      server.off('error',reject);
      resolve();
    });
  });
  const addr=server.address() as AddressInfo;
  return {
    origin:'http://'+addr.address+':'+addr.port+RPC_PATH,
    async close(){
      server.closeAllConnections();
      await new Promise<void>((resolve,reject)=>{
        server.close(err=>err?reject(err):resolve());
      });
    },
  };
}
