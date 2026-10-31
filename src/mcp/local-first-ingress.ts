import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LocalFirstTransportBudgetHook } from './all-ingress-transport-meter-proposal.js';
import type {Duplex} from 'node:stream';
import {bridgeLocalAgentUpgrade} from './local-first-agent-upgrade.js';
const upgradedSockets=new WeakMap<Server,Set<Duplex>>();
export function closeLocalFirstAgentSockets(server:Server){
  for(const socket of upgradedSockets.get(server)??[])socket.destroy();
}

/**
 * An opt-in LOOPBACK-only MCP ingress for a local, already running Nexowire Hub.
 * Intended as an origin behind an outbound authenticated HTTPS tunnel.
 *
 * Never starts an Agent or Hub; never publishes a public hostname; never
 * changes live config, credentials or quota. The upstream Hub MUST enforce
 * authentication/authorization/quota itself. Only POST /mcp and the two
 * protected-resource metadata routes can traverse this proxy.
 */
export interface LocalFirstIngressOptions {
  hubPort: number;
  listenPort: number;
  publicHostname?: string;
  allowAgentWebSocket?: boolean;
  maxConcurrent?: number;
  maxRequestBytes?: number;
  /** DEV only. Operator-supplied trusted tunnel+app scope, NEVER HTTP input. */
  stagingTransportBudget?: LocalFirstTransportBudgetHook;
}

export function validateLocalFirstIngress(input: LocalFirstIngressOptions): Required<
  Pick<LocalFirstIngressOptions, 'hubPort'|'listenPort'|'maxConcurrent'|'maxRequestBytes'>
> & {publicHostname?: string;allowAgentWebSocket?:boolean;stagingTransportBudget?: LocalFirstTransportBudgetHook} {
  for (const [name, value] of [
    ['hubPort', input.hubPort], ['listenPort',input.listenPort],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error(name + ' must be a port from 1 to 65535');
    }
  }
  if (input.hubPort === input.listenPort) {
    throw new Error('Local-first ingress cannot share the existing Hub port');
  }
  const maxConcurrent = input.maxConcurrent ?? 32;
  const maxRequestBytes = input.maxRequestBytes ?? 1024 * 1024;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 256) {
    throw new Error('Invalid bounded ingress concurrency');
  }
  if (!Number.isInteger(maxRequestBytes) || maxRequestBytes < 1024 ||
      maxRequestBytes > 16 * 1024 * 1024) {
    throw new Error('Invalid bounded request body maximum');
  }
  let publicHostname: string | undefined;
  if (input.publicHostname !== undefined) {
    const value = input.publicHostname.toLowerCase().trim();
    if (value.length < 4 || value.length > 253 ||
        !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(value) ||
        value.endsWith('.trycloudflare.com') ||
        value.endsWith('.localhost') || value === 'localhost' ||
        /^[0-9.]+$/.test(value)) {
      throw new Error('Public MCP hostname must be an explicit stable DNS name');
    }
    publicHostname = value;
  }
  return {hubPort:input.hubPort,listenPort:input.listenPort,maxConcurrent,
    maxRequestBytes,...(publicHostname ? {publicHostname}:{}),
    ...(input.allowAgentWebSocket===true?{allowAgentWebSocket:true}:{}),
    ...(input.stagingTransportBudget
      ? {stagingTransportBudget:input.stagingTransportBudget}:{}),
  };
}

/**
 * Read-only public exposure preflight. The credential and quota authority MUST
 * already be running on the SAME local Hub. No tunnel or live service starts
 * until that Hub advertises current remote OAuth configuration and exactly
 * matches the expected first-party OAuth resource.
 *
 * This is a configuration guard, NOT proof of D1 provider guarantees or
 * continuous session authorization. Live public exposure needs separate
 * tunnel, identity and rollback acceptance.
 */
export async function verifyLocalFirstPublicUpstream(input:{
  hubPort:number;
  expectedResourceUrl:string;
  requireRemoteAgentAdmission?:boolean;
  fetchImpl?:typeof fetch;
}):Promise<void>{
  if (!Number.isInteger(input.hubPort) || input.hubPort<1 || input.hubPort>65535) {
    throw new Error('Public local-first Hub port invalid');
  }
  let resource:URL;
  try {resource=new URL(input.expectedResourceUrl)} catch {
    throw new Error('Public local-first OAuth resource invalid');
  }
  if (resource.protocol!=='https:' || resource.pathname!=='/mcp' ||
      resource.username || resource.password || resource.search || resource.hash) {
    throw new Error('Public local-first requires exact HTTPS OAuth /mcp resource');
  }
  const call=input.fetchImpl??fetch;
  const base='http://127.0.0.1:'+input.hubPort;
  let health:unknown, metadata:unknown;
  try {
    const response=await call(base+'/health',{signal:AbortSignal.timeout(2500)});
    if (!response.ok) throw new Error('Hub health unavailable');
    health=await response.json();
    const protectedResource=await call(
      base+'/.well-known/oauth-protected-resource/mcp',
      {signal:AbortSignal.timeout(2500)},
    );
    if (!protectedResource.ok) throw new Error('OAuth resource metadata unavailable');
    metadata=await protectedResource.json();
  } catch {
    throw new Error('Public local-first Hub OAuth configuration could not be verified');
  }
  const identity=health as Record<string,unknown> | null;
  const runtime=identity?.runtime as Record<string,unknown> | null;
  const protectedResource=metadata as Record<string,unknown> | null;
  if(input.requireRemoteAgentAdmission&&runtime?.remoteAgentAdmissionContract!=='device-bound-revalidate-v1')
    throw new Error('Public Agent ingress requires remote-only device-bound revalidation on the actual Hub');
  if(identity?.ok!==true || identity.service!=='nexowire' ||
      runtime?.ownerOauthConfigured!==true ||
      protectedResource?.resource!==resource.toString() ||
      !Array.isArray(protectedResource.authorization_servers) ||
      protectedResource.authorization_servers.length<1) {
    throw new Error('Public local-first refused: Hub OAuth and quota authority not verified');
  }
}

const METADATA = new Set([
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
]);
const HEADERS = [
  'authorization','content-type','accept','mcp-session-id',
  'mcp-protocol-version','last-event-id','content-length',
] as const;

function authorizedHost(host: string | undefined, publicHostname?: string): boolean {
  if (!host || host.includes('@') || host.includes('/') || host.includes('\\') ||
      host.includes(' ') || host.includes(',') || host.includes('#')) return false;
  let parsed: URL;
  try { parsed = new URL('http://' + host); } catch { return false; }
  if (parsed.username || parsed.password || parsed.pathname !== '/' ||
      parsed.search || parsed.hash) return false;
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === '127.0.0.1' || hostname === 'localhost' ||
      hostname === '[::1]') return true;
  return Boolean(publicHostname && hostname === publicHostname && !parsed.port);
}
function authorizedOrigin(origin: string | undefined, publicHostname?: string): boolean {
  if (origin === undefined) return true;
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return false; }
  if (parsed.username || parsed.password || parsed.pathname !== '/' ||
      parsed.search || parsed.hash || parsed.origin === 'null') return false;
  const host = parsed.hostname.toLowerCase();
  return (parsed.protocol === 'https:' && host === publicHostname && !parsed.port) ||
    (parsed.protocol === 'http:' &&
      (host === 'localhost' || host === '127.0.0.1' || host === '[::1]'));
}
function reject(res:import('node:http').ServerResponse, status:number, code:string):void {
  res.writeHead(status,{
    'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store','x-content-type-options':'nosniff',
  });
  res.end(JSON.stringify({error:code}));
}

export function createLocalFirstIngressServer(options:LocalFirstIngressOptions):Server {
  const settings=validateLocalFirstIngress(options);
  let active=0;
  const server=createServer((req,res)=>{
    // STAGING opt-in ONLY. Count before auth, route, method and body checks.
    // This observes requests AFTER provider receipt, so it cannot reclaim or
    // override OpenAI's own shared tunnel allowance.
    if(settings.stagingTransportBudget){
      let allowance;
      try{
        const h=settings.stagingTransportBudget;
        allowance=h.meter.observe(h.trustedScope,h.clock?.()??new Date());
      }catch{
        reject(res,503,'ingress_transport_meter_unavailable');
        return;
      }
      if(!allowance.allowed){
        res.setHeader('retry-after',String(Math.max(1,
          Math.ceil(allowance.retryAfterMs/1000))));
        reject(res,429,'ingress_transport_rate_limited');
        return;
      }
    }
    // No /agent websocket upgrade and no arbitrary URL, query, admin, health,
    // callback, filesystem or proxy CONNECT access through the tunnel.
    const path=req.url ?? '';
    const isMcp=path==='/mcp';
    const isMetadata=METADATA.has(path);
    if (!isMcp && !isMetadata) {
      reject(res,404,'not_found');
      return;
    }
    if (!authorizedHost(req.headers.host,settings.publicHostname) ||
        !authorizedOrigin(req.headers.origin,settings.publicHostname)) {
      reject(res,403,'invalid_origin_or_host');
      return;
    }
    if ((isMcp && req.method!=='POST') ||
        (isMetadata && req.method!=='GET')) {
      reject(res,405,'method_not_allowed');
      return;
    }
    // This does NOT replace the upstream Hub's real token verification.
    // It makes accidental unauthenticated local Hub configurations fail shut.
    if (isMcp && (!req.headers.authorization ||
        !/^Bearer [^\s]{16,512}$/.test(req.headers.authorization))) {
      reject(res,401,'missing_bearer');
      return;
    }
    if (active>=settings.maxConcurrent) {
      reject(res,503,'ingress_busy');
      return;
    }
    const length=req.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) ||
        BigInt(length)>BigInt(settings.maxRequestBytes))) {
      reject(res,413,'request_too_large');
      return;
    }
    const headers:Record<string,string>={host:'127.0.0.1:'+settings.hubPort};
    for(const key of HEADERS) {
      const value=req.headers[key];
      if (typeof value === 'string') headers[key]=value;
    }
    // Do NOT forward forged Cf-Connecting-IP, Forwarded, X-Forwarded-*,
    // Upgrade, Connection, cookie or proxy-authentication headers.
    active++;
    let completed=false;
    const release=()=>{
      if (completed) return;
      completed=true;
      active--;
    };
    const upstream=httpRequest({
      hostname:'127.0.0.1',port:settings.hubPort,
      method:req.method,path,headers,timeout:15_000,
    }, upstreamResponse=>{
      res.statusCode=upstreamResponse.statusCode ?? 502;
      for(const key of [
        'content-type','cache-control','www-authenticate',
        'mcp-session-id','mcp-protocol-version',
      ]) {
        const value=upstreamResponse.headers[key];
        if (value !== undefined) res.setHeader(key,value);
      }
      res.setHeader('x-content-type-options','nosniff');
      upstreamResponse.on('error',()=>res.destroy());
      upstreamResponse.pipe(res);
      upstreamResponse.once('end',release);
    });
    upstream.on('timeout',()=>upstream.destroy(new Error('local_hub_timeout')));
    upstream.on('error',()=>{
      release();
      if (!res.headersSent) reject(res,502,'local_hub_unavailable');
      else res.destroy();
    });
    req.on('aborted',()=>upstream.destroy());
    res.on('close',()=>{
      release();
      if (!upstream.destroyed) upstream.destroy();
    });
    let bytes=0;
    req.on('data',chunk=>{
      bytes+=chunk.length;
      if (bytes>settings.maxRequestBytes) {
        release();
        if (!res.headersSent) reject(res,413,'request_too_large');
        upstream.destroy();
        req.destroy();
      }
    });
    req.pipe(upstream);
  });
  const agentSockets=new Set<Duplex>();upgradedSockets.set(server,agentSockets);
  server.on('upgrade',(req,socket,head)=>{
    // Denied WebSocket upgrades are STILL observed as arrival attempts.
    if(settings.stagingTransportBudget){
      try{
        const h=settings.stagingTransportBudget;
        const allowance=h.meter.observe(h.trustedScope,h.clock?.()??new Date());
        if(!allowance.allowed){socket.destroy();return;}
      }catch{
        // Always destroy even if trusted quota DB is down.
        socket.destroy();return;
      }
    }
    if(settings.allowAgentWebSocket&&req.url==='/agent'&&
        authorizedHost(req.headers.host,settings.publicHostname)&&
        authorizedOrigin(req.headers.origin,settings.publicHostname)&&agentSockets.size<32){
      agentSockets.add(socket);
      bridgeLocalAgentUpgrade(req,socket,head,settings.hubPort,()=>agentSockets.delete(socket));return;
    }
    socket.destroy();
  });
  server.requestTimeout=30_000;
  server.headersTimeout=15_000;
  server.keepAliveTimeout=5_000;
  return server;
}

/** Starts ONLY the opt-in origin proxy, always on loopback. */
export async function runLocalFirstIngress(options:LocalFirstIngressOptions):Promise<void>{
  const safe=validateLocalFirstIngress(options);
  const server=createLocalFirstIngressServer(safe);
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(safe.listenPort,'127.0.0.1',()=>{
      server.removeListener('error',reject);
      resolve();
    });
  });
  // No tunnel token, user credential, IP or account ID appears in logging.
  const address=server.address() as AddressInfo;
  process.stderr.write('Nexowire local-first MCP origin on 127.0.0.1:'+address.port+
    ' (not publicly exposed; tunnel must be configured separately)\n');
}
