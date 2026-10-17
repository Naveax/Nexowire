import {createHash,X509Certificate} from 'node:crypto';
import {Agent as HttpsAgent} from 'node:https';
import {isIP} from 'node:net';
import {checkServerIdentity,type PeerCertificate} from 'node:tls';
import type WebSocket from 'ws';

/**
 * DEV/STAGING. The profile must originate from independent, authenticated
 * operator enrollment. NEVER from MCP tool args, headers, redirects, or a
 * remote-supplied account setting. No production listener is started here.
 */
export interface OwnerPublicWssTrustProfile {
  endpoint:string;
  expectedHostname:string;
  /** One or two SHA-256 DER SubjectPublicKeyInfo pins for rotation. */
  trustedSpkiSha256:readonly string[];
  caMode:'system'|'custom';
  trustedCaPem?:string;
}
export interface ValidatedPublicWssProfile {
  endpoint:string;
  hostname:string;
  trustedSpkiSha256:readonly string[];
  caMode:'system'|'custom';
  trustedCaPem?:string;
}
const ROUTE='/internal/owner-quota/v1/outbound';
const SHA256=/^[a-f0-9]{64}$/;
const DNS=/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/;
const UNSAFE_SUFFIX=/(?:^|\.)(?:localhost|local|lan|home|internal|invalid|test)$/;

export function validateOwnerPublicWssTrustProfile(
  input:OwnerPublicWssTrustProfile,
):ValidatedPublicWssProfile {
  if(!input||typeof input!=='object'||Array.isArray(input)||
    Object.keys(input).some(key=>![
      'endpoint','expectedHostname','trustedSpkiSha256','caMode','trustedCaPem',
    ].includes(key))){
    throw new Error('Owner public WSS trust profile rejected');
  }
  if(typeof input.endpoint!=='string'||typeof input.expectedHostname!=='string'){
    throw new Error('Invalid owner WSS endpoint or expected hostname');
  }
  let u:URL;
  try{u=new URL(input.endpoint)}catch{throw new Error('Malformed public owner WSS URL')}
  const host=u.hostname;
  if(u.protocol!=='wss:'||u.port!==''||u.pathname!==ROUTE||
    u.username||u.password||u.search||u.hash||
    host!==input.expectedHostname||isIP(host)!==0||!DNS.test(host)||
    UNSAFE_SUFFIX.test(host)||input.endpoint!=='wss://'+host+ROUTE){
    throw new Error('Expected exact operator-owned public WSS DNS hostname and route');
  }
  if(!Array.isArray(input.trustedSpkiSha256)||
    input.trustedSpkiSha256.length<1||input.trustedSpkiSha256.length>2||
    input.trustedSpkiSha256.some(x=>typeof x!=='string'||!SHA256.test(x))||
    new Set(input.trustedSpkiSha256).size!==input.trustedSpkiSha256.length){
    throw new Error('Trusted owner WSS requires one or two distinct SPKI pins');
  }
  if(input.caMode==='custom'){
    if(typeof input.trustedCaPem!=='string'||
      input.trustedCaPem.length>100_000||
      !/^-----BEGIN CERTIFICATE-----\r?\n/.test(input.trustedCaPem)){
      throw new Error('Custom operator CA is invalid');
    }
  }else if(input.caMode==='system'){
    if(input.trustedCaPem!==undefined){
      throw new Error('System CA mode may not replace trust roots');
    }
  }else{
    throw new Error('Unsupported CA trust mode');
  }
  return {
    endpoint:u.toString(),hostname:host,
    trustedSpkiSha256:Object.freeze([...input.trustedSpkiSha256]),
    caMode:input.caMode,
    ...(input.caMode==='custom'?{trustedCaPem:input.trustedCaPem}:{}),
  };
}

export function ownerPublicWssPeerVerifier(
  trusted:ValidatedPublicWssProfile,
):(host:string,peer:PeerCertificate)=>Error|undefined {
  const pins=new Set(trusted.trustedSpkiSha256);
  return (host,peer)=>{
    if(host!==trusted.hostname){
      return new Error('Unexpected owner WSS TLS SNI hostname');
    }
    // The NODE TLS engine must also verify chain trust before this callback.
    const normal=checkServerIdentity(host,peer);
    if(normal)return normal;
    if(!peer.raw)return new Error('Missing owner TLS certificate');
    try{
      const key=new X509Certificate(peer.raw).publicKey.export({
        format:'der',type:'spki',
      });
      const digest=createHash('sha256').update(key).digest('hex');
      if(!pins.has(digest)){
        return new Error('Public owner WSS SPKI pin mismatch');
      }
      return undefined;
    }catch{
      return new Error('Failed to validate owner public WSS SPKI pin');
    }
  };
}
/** TLS options for a future operator-approved WSS dial; NOT a deployed dial. */
export function createOwnerPublicWssClientOptions(
  input:OwnerPublicWssTrustProfile,
):WebSocket.ClientOptions {
  const trusted=validateOwnerPublicWssTrustProfile(input);
  // @types/ws models checkServerIdentity differently from Node TLS. Put
  // the actual standard Node identity callback inside a Node HTTPS Agent.
  const agent=new HttpsAgent({
    rejectUnauthorized:true,
    minVersion:'TLSv1.3',maxVersion:'TLSv1.3',
    checkServerIdentity:ownerPublicWssPeerVerifier(trusted),
    ...(trusted.caMode==='custom'?{ca:trusted.trustedCaPem}:{}),
  });
  return {
    agent,
    rejectUnauthorized:true,
    followRedirects:false,
    perMessageDeflate:false,
    handshakeTimeout:4000,
  };
}
