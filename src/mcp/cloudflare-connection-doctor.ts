import type {NexowireConfig} from '../config.js';
import {cloudflareConnectionConfig} from './local-first-cloudflare.js';

async function boundedJson(response:Response){
  const reader=response.body?.getReader();
  if(!reader)throw Error('metadata_missing');
  const chunks:Uint8Array[]=[];let size=0;
  try{
    while(true){const next=await reader.read();if(next.done)break;
      size+=next.value.byteLength;if(size>16384)throw Error('metadata_too_large');chunks.push(next.value);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }finally{await reader.cancel().catch(()=>{});}
}
/** Read-only public boundary proof, NOT authenticated tool or reboot proof.
 * No stored bearer/token is read or transmitted by this diagnostic. */
export async function inspectCloudflareConnection(input:unknown,config:NexowireConfig,
  fetchImpl:typeof fetch=fetch){
  cloudflareConnectionConfig(input,config);
  const resource=config.mcpResourceUrl!;
  const metadataUrl=new URL('/.well-known/oauth-protected-resource/mcp',resource).toString();
  const issuer=new URL(config.controlPlaneAgentAuth!.url).toString().replace(/\/$/,'');
  const result=(stage:string)=>({stage,publicBoundaryVerified:stage==='PUBLIC_OAUTH_BOUNDARY_OK',
    authenticatedToolVerified:false as const,transport:'cloudflare-tunnel' as const});
  try{
    const response=await fetchImpl(metadataUrl,{method:'GET',redirect:'error',
      signal:AbortSignal.timeout(5000),headers:{accept:'application/json'}});
    if(response.status!==200){await response.body?.cancel();return result('PUBLIC_METADATA_UNAVAILABLE');}
    const metadata=await boundedJson(response);
    if(metadata.resource!==resource || !Array.isArray(metadata.authorization_servers) ||
        metadata.authorization_servers.length!==1 ||
        typeof metadata.authorization_servers[0]!=='string' ||
        new URL(metadata.authorization_servers[0]).toString().replace(/\/$/,'')!==issuer)
      return result('PUBLIC_OAUTH_RESOURCE_MISMATCH');
    const unauthorized=await fetchImpl(resource,{method:'POST',redirect:'error',
      signal:AbortSignal.timeout(5000),headers:{'content-type':'application/json',accept:'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{
        protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'nexowire-connection-doctor',version:'1'},
      }})});
    await unauthorized.body?.cancel();
    return result(unauthorized.status===401?'PUBLIC_OAUTH_BOUNDARY_OK':'PUBLIC_AUTH_BOUNDARY_FAILED');
  }catch{return result('PUBLIC_CONNECTION_UNAVAILABLE');}
}
