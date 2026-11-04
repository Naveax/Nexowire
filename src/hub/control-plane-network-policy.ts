import {lookup as dnsLookup} from 'node:dns/promises';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {isIP} from 'node:net';

type ResolvedAddress = {address:string;family:4|6};
export type ControlPlaneResolver = (hostname:string)=>Promise<readonly ResolvedAddress[]>;

/** A URL allowlist is not a network admission gate. This policy checks every
 * A/AAAA answer and pins the checked IP to the actual socket lookup. */
function ipv4Global(address:string):boolean{
  const bytes=address.split('.').map(Number);
  if(bytes.length!==4||bytes.some(x=>!Number.isInteger(x)||x<0||x>255))return false;
  const [a,b,c]=bytes as [number,number,number];
  return !(a===0||a===10||a===127||a>=224||
    (a===100&&b>=64&&b<=127)||
    (a===169&&b===254)||
    (a===172&&b>=16&&b<=31)||
    (a===192&&b===0&&c===0)||
    (a===192&&b===0&&c===2)||
    (a===192&&b===88&&c===99)||
    (a===192&&b===168)||
    (a===198&&(b===18||b===19))||
    (a===198&&b===51&&c===100)||
    (a===203&&b===0&&c===113));
}

function ipv6Global(address:string):boolean{
  const value=address.toLowerCase().replace(/^\[|\]$/g,'');
  if(value.includes('%')||!isIP(value)||isIP(value)!==6)return false;
  // Reject mapped/translated, ULA, link-local, multicast, unspecified, 6to4,
  // documentation and other special-purpose space. Allow only global 2000::/3.
  const first=value.split(':',1)[0]!;
  const word=Number.parseInt(first||'0',16);
  if(!Number.isFinite(word)||(word&0xe000)!==0x2000)return false;
  if(word===0x2002)return false;
  if(word===0x2001){
    const second=Number.parseInt(value.split(':')[1]||'0',16);
    if(second<0x0200||second===0x0db8)return false;
  }
  return true;
}

function loopbackAddress(address:string):boolean{
  return address==='127.0.0.1'||address==='::1';
}

/** The connected peer, not a second DNS lookup, must match the vetted IP.
 * IPv6 is compared in canonical form so equivalent compressed spelling works. */
function sameNetworkAddress(actual:string|undefined,expected:string):boolean{
  if(!actual||isIP(actual)!==isIP(expected))return false;
  const canonical=(value:string)=>isIP(value)===6
    ? new URL('http://['+value+']/').hostname.toLowerCase()
    : value;
  return canonical(actual)===canonical(expected);
}
function forbiddenHost(hostname:string):boolean{
  const host=hostname.toLowerCase().replace(/^\[|\]$/g,'');
  return host==='metadata'||host==='instance-data'||
    host==='metadata.google.internal'||host==='metadata.azure.internal'||
    host==='169.254.169.254'||host.endsWith('.localhost')||
    host.endsWith('.local')||host.endsWith('.internal')||
    host.endsWith('.home.arpa')||host.endsWith('.onion');
}

export function normalizeControlPlaneBase(input:string):string{
  const raw=input.trim();
  if(raw!==input||/[\u0000-\u0020\u007f\\]/.test(raw))throw new Error('CONTROL_PLANE_URL_INVALID');
  let url:URL;
  try{url=new URL(raw);}catch{throw new Error('CONTROL_PLANE_URL_INVALID');}
  if(url.protocol!=='https:'&&url.protocol!=='http:')throw new Error('CONTROL_PLANE_URL_INVALID');
  if(url.username||url.password||url.search||url.hash||
     !url.hostname||url.hostname.endsWith('.')||
     /%(?:2e|2f|5c|00)/i.test(raw)||
     /\/(?:\.|\.\.)(?:\/|$)/.test(raw))throw new Error('CONTROL_PLANE_URL_INVALID');
  const rawAuthority=/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(raw)?.[1];
  if(!rawAuthority||rawAuthority.includes('@')||
     !/^[\x21-\x7e]+$/.test(rawAuthority)||rawAuthority.includes('%'))
    throw new Error('CONTROL_PLANE_URL_INVALID');
  const rawHost=rawAuthority.startsWith('[')
    ? rawAuthority.slice(0,rawAuthority.indexOf(']')+1)
    : rawAuthority.replace(/:\d+$/,'');
  const parsedHost=url.hostname.replace(/^\[|\]$/g,'');
  const numeric=isIP(parsedHost)!==0;
  // URL() canonicalizes octal, hexadecimal and shortened IPv4. Reject
  // noncanonical numeric aliases even if they resolve to a public address.
  if(numeric&&rawHost.toLowerCase()!==url.hostname.toLowerCase())
    throw new Error('CONTROL_PLANE_NONCANONICAL_ADDRESS');
  if(forbiddenHost(url.hostname))throw new Error('CONTROL_PLANE_UNSAFE_DESTINATION');
  if(!numeric&&(!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(url.hostname)||
      url.hostname.length>253||
      url.hostname.split('.').some(label=>!label||label.length>63||
        label.startsWith('-')||label.endsWith('-')||label.startsWith('xn--'))))
    throw new Error('CONTROL_PLANE_URL_INVALID');
  const local=loopbackAddress(parsedHost)||url.hostname==='localhost';
  if(url.protocol==='http:'&&!local)throw new Error('CONTROL_PLANE_HTTPS_REQUIRED');
  if(url.protocol==='https:'&&local)throw new Error('CONTROL_PLANE_UNSAFE_DESTINATION');
  if(numeric&&!local&&!(isIP(parsedHost)===4?ipv4Global(parsedHost):ipv6Global(parsedHost)))
    throw new Error('CONTROL_PLANE_UNSAFE_DESTINATION');
  if(url.port&&url.protocol==='https:'&&url.port!=='443'&&!local)
    throw new Error('CONTROL_PLANE_UNSAFE_PORT');
  if(/\/\//.test(url.pathname)||url.pathname.split('/').some(part=>part==='.'||part==='..'))
    throw new Error('CONTROL_PLANE_URL_INVALID');
  url.pathname=url.pathname.replace(/\/+$/,'');
  return url.toString().replace(/\/$/,'');
}


/** Public Cloudflare publication is a separate trust boundary from local-only
 * HTTP loopback development. Only a single canonical HTTPS authority may
 * control authentication for an Internet-exposed connector.
 *
 * Synchronous form is intended for cloudflareConnectionConfig(), before
 * admission. The outbound native transport must still resolve and pin the
 * actual peer IP for every secret request; a one-time DNS preflight alone
 * cannot close a later DNS rebinding race.
 */
export function normalizePublicControlPlaneAuthority(input:string):string{
  const normalized=normalizeControlPlaneBase(input);
  const url=new URL(normalized);
  if(url.protocol!=='https:'||url.pathname!=='/'||
     url.port||normalized!==input||
     url.username||url.password||url.search||url.hash)
    throw new Error('CONTROL_PLANE_PUBLIC_AUTHORITY_INVALID');
  // Public DNS names are checked again on resolution, including every
  // A/AAAA answer. Literal numeric hosts already passed global-IP policy.
  return normalized;
}

/** Optional pre-publication DNS evidence; it cannot replace per-request
 * pinned socket admission when the DNS mapping changes afterward. */
export async function resolvePublicControlPlaneAuthority(
  input:string,
  resolver?:ControlPlaneResolver,
  signal?:AbortSignal,
):Promise<ResolvedAddress>{
  const canonical=normalizePublicControlPlaneAuthority(input);
  return resolveControlPlaneAddress(new URL(canonical).hostname,
    resolver??realResolver,signal);
}

const realResolver:ControlPlaneResolver=async hostname=>
  (await dnsLookup(hostname,{all:true,verbatim:true})).map(item=>({
    address:item.address,family:item.family as 4|6,
  }));

export async function resolveControlPlaneAddress(
  hostname:string,
  resolver:ControlPlaneResolver=realResolver,
  signal?:AbortSignal,
):Promise<ResolvedAddress>{
  if(signal?.aborted)throw new Error('CONTROL_PLANE_ABORTED');
  const normalized=hostname.replace(/^\[|\]$/g,'').toLowerCase();
  const local=normalized==='localhost'||loopbackAddress(normalized);
  if(forbiddenHost(normalized))throw new Error('CONTROL_PLANE_UNSAFE_DESTINATION');
  const literalFamily=isIP(normalized);
  if(literalFamily&&!local&&!(literalFamily===4?ipv4Global(normalized):ipv6Global(normalized)))
    throw new Error('CONTROL_PLANE_UNSAFE_DESTINATION');
  let abortHandler:()=>void=()=>{};
  const aborted=new Promise<never>((_,reject)=>{
    abortHandler=()=>reject(new Error('CONTROL_PLANE_ABORTED'));
    signal?.addEventListener('abort',abortHandler,{once:true});
  });
  try{
    const candidates=literalFamily
      ? [{address:normalized,family:literalFamily as 4|6}]
      : await Promise.race([resolver(normalized),aborted]);
    if(!candidates.length)throw new Error('CONTROL_PLANE_DNS_EMPTY');
    for(const candidate of candidates){
      if((candidate.family!==4&&candidate.family!==6)||
         isIP(candidate.address)!==candidate.family||
         (local?!loopbackAddress(candidate.address):
          !(candidate.family===4?ipv4Global(candidate.address):ipv6Global(candidate.address))))
        throw new Error('CONTROL_PLANE_DNS_UNSAFE');
    }
    if(signal?.aborted)throw new Error('CONTROL_PLANE_ABORTED');
    return {...candidates[0]!};
  }finally{signal?.removeEventListener('abort',abortHandler);}
}

/** Native production transport. Node's request() never follows 3xx; its
 * socket lookup is pinned to the vetted IP while TLS validates the original
 * hostname/SNI. Caller-injected fetch is for disposable test fixtures only. */
export async function controlPlaneSecretPost(
  input:string,
  init:RequestInit,
  injectedFetch?:typeof fetch,
  resolver:ControlPlaneResolver=realResolver,
):Promise<Response>{
  if(init.method!=='POST'||init.redirect!=='error'||typeof init.body!=='string')
    throw new Error('CONTROL_PLANE_REQUEST_INVALID');
  // Validate the ENTIRE destination, not merely URL.origin, which discards
  // userinfo, query and fragment before admission can reject them.
  const url=new URL(normalizeControlPlaneBase(input));
  if(injectedFetch){
    const response=await injectedFetch(input,init);
    if(response.status>=300&&response.status<400)throw new Error('CONTROL_PLANE_REDIRECT_DENIED');
    return response;
  }
  const pinned=await resolveControlPlaneAddress(url.hostname,resolver,init.signal??undefined);
  if(init.signal?.aborted)throw new Error('CONTROL_PLANE_ABORTED');
  return await new Promise<Response>((resolve,reject)=>{
    const request=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{
      method:'POST',headers:Object.fromEntries(new Headers(init.headers)),
      agent:false,
      signal:init.signal??undefined,
      family:pinned.family,
      lookup:(_hostname,_options,callback)=>callback(null,pinned.address,pinned.family),
    },response=>{
      const status=response.statusCode??502;
      if(status>=300&&status<400){response.destroy();reject(new Error('CONTROL_PLANE_REDIRECT_DENIED'));return;}
      const chunks:Buffer[]=[];let length=0;
      response.on('data',(chunk:Buffer)=>{
        length+=chunk.length;
        if(length>1024*1024){request.destroy(new Error('CONTROL_PLANE_RESPONSE_TOO_LARGE'));return;}
        chunks.push(chunk);
      });
      response.once('error',reject);
      response.once('end',()=>{
        try{resolve(new Response(status===204||status===205||status===304?null:Buffer.concat(chunks),{
          status:status>=200&&status<=599?status:502,
          headers:{'content-type':String(response.headers['content-type']??'application/json')},
        }));}catch{reject(new Error('CONTROL_PLANE_RESPONSE_INVALID'));}
      });
    });
    request.once('error',reject);
    // End() is deliberately delayed: neither Authorization nor the POST body
    // may leave the process before the connected peer and TLS are verified.
    request.once('socket',socket=>{
      socket.once(url.protocol==='https:'?'secureConnect':'connect',()=>{
        if(!sameNetworkAddress(socket.remoteAddress,pinned.address)||
           (url.protocol==='https:'&&
             (!('authorized' in socket)||socket.authorized!==true))){
          request.destroy(new Error('CONTROL_PLANE_PEER_UNVERIFIED'));
          return;
        }
        request.end(init.body);
      });
    });
  });
}
