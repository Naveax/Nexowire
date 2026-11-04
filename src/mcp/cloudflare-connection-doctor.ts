import type {NexowireConfig} from '../config.js';
import {cloudflareConnectionConfig} from './local-first-cloudflare.js';

type DoctorStage=
  |'PUBLIC_CONNECTION_UNAVAILABLE'
  |'PUBLIC_METADATA_UNAVAILABLE'
  |'PUBLIC_METADATA_HTTP_401'
  |'PUBLIC_METADATA_HTTP_403'
  |'PUBLIC_METADATA_HTTP_5XX'
  |'PUBLIC_METADATA_TIMEOUT'
  |'PUBLIC_METADATA_INVALID'
  |'PUBLIC_OAUTH_RESOURCE_MISMATCH'
  |'PUBLIC_AUTH_BOUNDARY_FAILED'
  |'PUBLIC_AUTH_HTTP_403'
  |'PUBLIC_AUTH_HTTP_5XX'
  |'PUBLIC_AUTH_TIMEOUT'
  |'PUBLIC_OAUTH_BOUNDARY_OK';

async function boundedJson(response:Response):Promise<unknown>{
  const reader=response.body?.getReader();
  if(!reader)throw Error('metadata_missing');
  const chunks:Uint8Array[]=[];let size=0;
  try{
    while(true){
      const next=await reader.read();
      if(next.done)break;
      size+=next.value.byteLength;
      if(size>16384)throw Error('metadata_too_large');
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }finally{await reader.cancel().catch(()=>{});}
}
function doctorResult(stage:DoctorStage){
  const verified=stage==='PUBLIC_OAUTH_BOUNDARY_OK';
  return {
    stage,
    readiness:verified?'PUBLIC_OAUTH_BOUNDARY_OK':
      stage==='PUBLIC_CONNECTION_UNAVAILABLE'?'UNAVAILABLE':'DEGRADED',
    publicBoundaryVerified:verified,
    authenticatedToolVerified:false as const,
    agentAuthenticated:false as const,
    transport:'cloudflare-tunnel' as const,
  };
}
function httpStage(status:number,step:'metadata'|'authorization'):DoctorStage{
  if(step==='metadata'){
    if(status===401)return 'PUBLIC_METADATA_HTTP_401';
    if(status===403)return 'PUBLIC_METADATA_HTTP_403';
    if(status>=500)return 'PUBLIC_METADATA_HTTP_5XX';
    return 'PUBLIC_METADATA_UNAVAILABLE';
  }
  if(status===403)return 'PUBLIC_AUTH_HTTP_403';
  if(status>=500)return 'PUBLIC_AUTH_HTTP_5XX';
  return 'PUBLIC_AUTH_BOUNDARY_FAILED';
}
function isTimeout(error:unknown):boolean{
  return error instanceof Error && (error.name==='TimeoutError'||error.name==='AbortError');
}
/** Public boundary preflight ONLY. A 401 without a matching OAuth challenge
 * must never be confused with an authenticated MCP initialize/tool call.
 * No owner/service/device token is read from disk or sent to the public URL. */
export async function inspectCloudflareConnection(input:unknown,config:NexowireConfig,
  fetchImpl:typeof fetch=fetch){
  cloudflareConnectionConfig(input,config);
  const resource=config.mcpResourceUrl!;
  const metadataUrl=new URL('/.well-known/oauth-protected-resource/mcp',resource).toString();
  const issuer=new URL(config.controlPlaneAgentAuth!.url).toString().replace(/\/$/,'');
  let metadataResponse:Response;
  try{
    metadataResponse=await fetchImpl(metadataUrl,{method:'GET',redirect:'error',
      signal:AbortSignal.timeout(5000),headers:{accept:'application/json'}});
  }catch(error){
    return doctorResult(isTimeout(error)?'PUBLIC_METADATA_TIMEOUT':'PUBLIC_CONNECTION_UNAVAILABLE');
  }
  if(metadataResponse.status!==200){
    await metadataResponse.body?.cancel().catch(()=>{});
    return doctorResult(httpStage(metadataResponse.status,'metadata'));
  }
  let raw:unknown;
  try{raw=await boundedJson(metadataResponse);}
  catch(error){return doctorResult(isTimeout(error)?'PUBLIC_METADATA_TIMEOUT':'PUBLIC_METADATA_INVALID');}
  const metadata=raw as Record<string,unknown>|null;
  let authority:string|undefined;
  try{
    if(!metadata||typeof metadata!=='object'||
       !Array.isArray(metadata.authorization_servers)||
       metadata.authorization_servers.length!==1||
       typeof metadata.authorization_servers[0]!=='string')
      return doctorResult('PUBLIC_OAUTH_RESOURCE_MISMATCH');
    authority=new URL(metadata.authorization_servers[0]).toString().replace(/\/$/,'');
  }catch{return doctorResult('PUBLIC_OAUTH_RESOURCE_MISMATCH');}
  if(metadata?.resource!==resource||authority!==issuer)
    return doctorResult('PUBLIC_OAUTH_RESOURCE_MISMATCH');
  let unauthorized:Response;
  try{
    unauthorized=await fetchImpl(resource,{method:'POST',redirect:'error',
      signal:AbortSignal.timeout(5000),
      headers:{'content-type':'application/json',accept:'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{
        protocolVersion:'2025-03-26',capabilities:{},
        clientInfo:{name:'nexowire-connection-doctor',version:'1'},
      }})});
  }catch(error){
    return doctorResult(isTimeout(error)?'PUBLIC_AUTH_TIMEOUT':'PUBLIC_CONNECTION_UNAVAILABLE');
  }
  const challenge=unauthorized.headers.get('www-authenticate')??'';
  const challengeValid=challenge.startsWith('Bearer ') &&
    challenge.includes('resource_metadata="'+metadataUrl+'"');
  await unauthorized.body?.cancel().catch(()=>{});
  return doctorResult(unauthorized.status===401&&challengeValid?
    'PUBLIC_OAUTH_BOUNDARY_OK':httpStage(unauthorized.status,'authorization'));
}