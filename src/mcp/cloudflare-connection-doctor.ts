import type {NexowireConfig} from '../config.js';
import {cloudflareConnectionConfig} from './local-first-cloudflare.js';

/** Evidence stages are NOT interchangeable. Only trusted runtime checks may
 * set these booleans; a running process or anonymous 401 is never MCP-ready. */
export type ConnectionV2State=
  |'LOCAL_PROCESS_RUNNING'
  |'PUBLIC_OAUTH_BOUNDARY_OK'
  |'AUTHENTICATED_MCP_READY'
  |'AGENT_AUTHENTICATED'
  |'DEGRADED'
  |'UNAVAILABLE';

export interface ConnectionV2ProofEvidence {
  localProcessRunning:boolean;
  publicOauthBoundaryOk:boolean;
  /** True only after actual OAuth-bound MCP initialize AND read-only tool completion. */
  authenticatedMcpToolComplete:boolean;
  /** True only after real Hub-bound device auth and Agent handshake. */
  agentAuthenticated:boolean;
  /** Health/revalidation failure after establishment. */
  dependencyFailure?:boolean;
}
export function deriveConnectionV2State(proof:ConnectionV2ProofEvidence):ConnectionV2State{
  if(!proof.localProcessRunning)return 'UNAVAILABLE';
  if(proof.dependencyFailure===true ||
     (!proof.publicOauthBoundaryOk &&
       (proof.authenticatedMcpToolComplete||proof.agentAuthenticated)))return 'DEGRADED';
  if(proof.publicOauthBoundaryOk&&proof.agentAuthenticated)return 'AGENT_AUTHENTICATED';
  if(proof.publicOauthBoundaryOk&&proof.authenticatedMcpToolComplete)return 'AUTHENTICATED_MCP_READY';
  if(proof.publicOauthBoundaryOk)return 'PUBLIC_OAUTH_BOUNDARY_OK';
  return 'LOCAL_PROCESS_RUNNING';
}

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

/** Only non-mutating, explicitly reviewed acceptance tools may be invoked.
 * The tool response must contain a caller-supplied, non-secret expected marker.
 * This probe NEVER performs OAuth consent or exchanges authorization codes. */
export type StagingReadOnlyTool='nexowire_surface_info'|'machine_health'|'machine_snapshot';
export interface ConnectionV2AuthenticatedProbe {
  resourceUrl:string;
  issuerUrl:string;
  bearerToken:string;
  expectedOutputContains:string;
  toolName?:StagingReadOnlyTool;
  toolArguments?:Record<string,unknown>;
  fetchImpl?:typeof fetch;
  timeoutMs?:number;
  /** Disposable loopback HTTP fixtures only. Never enable for public acceptance. */
  allowLoopbackHttpFixture?:boolean;
}
export interface ConnectionV2AuthenticatedResult {
  stage:'AUTHENTICATED_MCP_READY'|'DEGRADED'|'UNAVAILABLE';
  code:string;
  publicBoundaryVerified:boolean;
  authenticatedToolVerified:boolean;
  sessionIdObserved:boolean;
  completedSteps:readonly string[];
}

function exactHttpsMcpResource(raw:string,allowLoopback:boolean):URL {
  const url=new URL(raw);
  const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.toString()!==raw || url.username||url.password||url.search||url.hash||
     url.pathname!=='/mcp'||!url.hostname||
     !(url.protocol==='https:' || (allowLoopback&&loopback&&url.protocol==='http:')))
    throw new Error('STAGING_RESOURCE_INVALID');
  return url;
}
function expectedIssuer(raw:string):string{
  const url=new URL(raw);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||
     url.port||url.toString().replace(/\/$/,'')!==raw.replace(/\/$/,'')||
     /%(?:2e|2f|5c|00)/i.test(raw))
    throw new Error('STAGING_ISSUER_INVALID');
  return url.toString().replace(/\/$/,'');
}
async function boundedMcpRpc(response:Response,requestId:number):Promise<Record<string,unknown>>{
  const reader=response.body?.getReader();
  if(!reader)throw new Error('MCP_EMPTY_RESPONSE');
  const chunks:Uint8Array[]=[];
  let total=0;
  try{
    while(true){
      const result=await reader.read();
      if(result.done)break;
      total+=result.value.byteLength;
      if(total>1024*1024)throw new Error('MCP_OUTPUT_LIMIT');
      chunks.push(result.value);
    }
  }finally{await reader.cancel().catch(()=>{});}
  const text=Buffer.concat(chunks).toString('utf8');
  const contentType=response.headers.get('content-type')?.toLowerCase()??'';
  let candidates:string[]=[];
  if(contentType.includes('text/event-stream')){
    const events=text.split(/\r?\n\r?\n/);
    candidates=events.map(event=>event.split(/\r?\n/).filter(line=>line.startsWith('data:'))
      .map(line=>line.slice(5).trimStart()).join('\n')).filter(Boolean);
  }else if(contentType.includes('application/json')){
    candidates=[text];
  }else throw new Error('MCP_CONTENT_TYPE_INVALID');
  for(const candidate of candidates){
    let parsed:unknown;
    try{parsed=JSON.parse(candidate);}catch{throw new Error('MCP_JSON_INVALID');}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))continue;
    const message=parsed as Record<string,unknown>;
    if(message.id===requestId&&message.jsonrpc==='2.0')return message;
  }
  throw new Error('MCP_RESPONSE_ID_MISMATCH');
}

/** Authenticated, single-attempt MCP protocol proof for a disposable/staging
 * endpoint. This is NOT evidence of ChatGPT OAuth consent; that separate real
 * connect flow must be witnessed by V2-08. No automatic retries or replay. */
export async function verifyConnectionV2AuthenticatedReadOnly(
  input:ConnectionV2AuthenticatedProbe,
):Promise<ConnectionV2AuthenticatedResult>{
  const completed:string[]=[];
  let publicBoundaryVerified=false;
  let sessionIdObserved=false;
  const fail=(code:string,stage:'DEGRADED'|'UNAVAILABLE'='DEGRADED'):ConnectionV2AuthenticatedResult=>({
    stage,code,publicBoundaryVerified,authenticatedToolVerified:false,
    sessionIdObserved,completedSteps:[...completed],
  });
  const timeout=input.timeoutMs??5000;
  if(!Number.isSafeInteger(timeout)||timeout<250||timeout>15000)
    throw new Error('STAGING_TIMEOUT_INVALID');
  if(!/^[-A-Za-z0-9_./+=]{16,4096}$/.test(input.bearerToken))
    throw new Error('STAGING_BEARER_INVALID');
  if(!input.expectedOutputContains||input.expectedOutputContains.length>256||
     /[\r\n\0]/.test(input.expectedOutputContains))
    throw new Error('STAGING_EXPECTED_MARKER_INVALID');
  const tool=input.toolName??'nexowire_surface_info';
  if(!['nexowire_surface_info','machine_health','machine_snapshot'].includes(tool))
    throw new Error('STAGING_TOOL_NOT_READ_ONLY');
  const resource=exactHttpsMcpResource(input.resourceUrl,input.allowLoopbackHttpFixture===true);
  const issuer=expectedIssuer(input.issuerUrl);
  const metadataUrl=new URL('/.well-known/oauth-protected-resource/mcp',resource);
  const send=input.fetchImpl??fetch;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeout);
  timer.unref();
  let sessionId:string|undefined;
  const headers=(authenticated:boolean):Record<string,string>=>({
    accept:'application/json, text/event-stream',
    'content-type':'application/json',
    ...(authenticated?{authorization:'Bearer '+input.bearerToken}:{}),
    ...(sessionId?{'mcp-session-id':sessionId}:{}),
    'mcp-protocol-version':'2025-03-26',
  });
  try{
    const metadata=await send(metadataUrl,{method:'GET',redirect:'error',
      signal:controller.signal,headers:{accept:'application/json'}});
    if(metadata.status!==200){await metadata.body?.cancel().catch(()=>{});return fail('MCP_METADATA_HTTP_'+metadata.status);}
    const body=await boundedJson(metadata) as Record<string,unknown>|null;
    let advertisedIssuer:string|undefined;
    try{
      if(Array.isArray(body?.authorization_servers)&&
         body.authorization_servers.length===1&&
         typeof body.authorization_servers[0]==='string')
        advertisedIssuer=new URL(body.authorization_servers[0]).toString().replace(/\/$/,'');
    }catch{/* A malformed advertised issuer is a boundary mismatch. */}
    if(!body||body.resource!==resource.toString()||advertisedIssuer!==issuer)
      return fail('MCP_OAUTH_RESOURCE_OR_ISSUER_MISMATCH');
    completed.push('metadata');
    const rpcBody=(id:number,method:string,params:unknown)=>JSON.stringify({
      jsonrpc:'2.0',id,method,params,
    });
    const initParams={protocolVersion:'2025-03-26',capabilities:{},
      clientInfo:{name:'nexowire-v2-03-staging-probe',version:'1'}};
    const anonymous=await send(resource,{method:'POST',redirect:'error',signal:controller.signal,
      headers:headers(false),body:rpcBody(0,'initialize',initParams)});
    const challenge=anonymous.headers.get('www-authenticate')??'';
    await anonymous.body?.cancel().catch(()=>{});
    if(anonymous.status!==401||
       !challenge.startsWith('Bearer ')||
       !challenge.includes('resource_metadata="'+metadataUrl.toString()+'"'))
      return fail('MCP_ANONYMOUS_OAUTH_CHALLENGE_MISMATCH');
    publicBoundaryVerified=true;
    completed.push('oauth_challenge');
    const call=async(id:number,method:string,params:unknown):Promise<Record<string,unknown>>=>{
      const response=await send(resource,{method:'POST',redirect:'error',signal:controller.signal,
        headers:headers(true),body:rpcBody(id,method,params)});
      if(response.status!==200&&response.status!==202){
        await response.body?.cancel().catch(()=>{});
        throw new Error('MCP_AUTHENTICATED_HTTP_'+response.status);
      }
      const responseSession=response.headers.get('mcp-session-id');
      if(responseSession!==null){
        if(!/^[A-Za-z0-9_-]{1,128}$/.test(responseSession)||
          (sessionId&&responseSession!==sessionId))
          throw new Error('MCP_SESSION_ID_INVALID');
        sessionId=responseSession;
        sessionIdObserved=true;
      }
      if(response.status===202)throw new Error('MCP_NO_COMPLETION');
      const message=await boundedMcpRpc(response,id);
      if(message.error||!message.result||typeof message.result!=='object')
        throw new Error('MCP_RPC_FAILED');
      return message.result as Record<string,unknown>;
    };
    const initialized=await call(1,'initialize',initParams);
    if(initialized.protocolVersion!=='2025-03-26'||
       !initialized.serverInfo||typeof initialized.serverInfo!=='object'||
       (initialized.serverInfo as Record<string,unknown>).name!=='nexowire')
      return fail('MCP_INITIALIZE_INVALID');
    completed.push('initialize');
    const tools=await call(2,'tools/list',{});
    if(!Array.isArray(tools.tools)||!tools.tools.some(x=>x&&typeof x==='object'&&
       (x as Record<string,unknown>).name===tool &&
       (x as Record<string,unknown>).annotations!==null &&
       (!((x as Record<string,unknown>).annotations)||
          (x as {annotations?:{readOnlyHint?:boolean}}).annotations?.readOnlyHint!==false)))
      return fail('MCP_READ_ONLY_TOOL_NOT_ADVERTISED');
    completed.push('tools_list');
    const result=await call(3,'tools/call',{name:tool,
      arguments:input.toolArguments??(tool==='nexowire_surface_info'?{include_tools:false}:{})});
    if(result.isError===true||!Array.isArray(result.content)||
       !result.content.some(x=>x&&typeof x==='object'&&
         (x as {type?:unknown}).type==='text'&&typeof (x as {text?:unknown}).text==='string'&&
         (x as {text:string}).text.includes(input.expectedOutputContains)))
      return fail('MCP_READ_ONLY_OUTPUT_MISMATCH');
    completed.push('tools_call_completed');
    return {stage:'AUTHENTICATED_MCP_READY',code:'MCP_AUTHENTICATED_READ_ONLY_COMPLETE',
      publicBoundaryVerified:true,authenticatedToolVerified:true,
      sessionIdObserved,completedSteps:[...completed]};
  }catch(error){
    const cause=error instanceof Error?error.message:'MCP_UNAVAILABLE';
    const code=controller.signal.aborted?'MCP_TIMEOUT_OR_CANCELLED':
      /^MCP_[A-Z0-9_]+$/.test(cause)?cause:'MCP_UPSTREAM_UNAVAILABLE';
    return fail(code,publicBoundaryVerified?'DEGRADED':'UNAVAILABLE');
  }finally{clearTimeout(timer);}
}


/** Readiness state is ephemeral and evidence-derived, never persisted as an
 * authorization grant. The Hub auth and Agent grant remain authoritative. */
export interface ConnectionV2AgentGrantObservation {
  remoteOnly:boolean;
  hubAdmissionContract:string;
  boundDeviceId:string;
  helloDeviceId:string;
  expiresAtMs:number;
  revoked?:boolean;
}
export class ConnectionV2ReadinessMonitor {
  private local=false;
  private boundaryAt:number|undefined;
  private mcpAt:number|undefined;
  private agentAt:number|undefined;
  private agentExpiresAt:number|undefined;
  private degraded=false;
  private processObservedAt:number|undefined;
  private readonly ttl:number;
  private readonly clock:()=>number;

  constructor(options:{maxEvidenceAgeMs?:number;clock?:()=>number}={}){
    const ttl=options.maxEvidenceAgeMs??60_000;
    if(!Number.isSafeInteger(ttl)||ttl<250||ttl>300_000)
      throw Error('READINESS_EVIDENCE_TTL_INVALID');
    this.ttl=ttl;
    this.clock=options.clock??(()=>Date.now());
  }
  /** Caller must source this event from its trusted local process supervisor. */
  observeLocalProcess(running:boolean):ConnectionV2State{
    this.local=running;
    this.processObservedAt=this.clock();
    if(!running){this.boundaryAt=undefined;this.mcpAt=undefined;
      this.agentAt=undefined;this.agentExpiresAt=undefined;this.degraded=false;}
    return this.current();
  }
  /** Calls the real diagnostic; a synthetic HTTP 200 is never accepted alone. */
  async inspectPublicBoundary(input:unknown,config:NexowireConfig,
    fetchImpl:typeof fetch=fetch):Promise<ConnectionV2State>{
    if(!this.local)return 'UNAVAILABLE';
    const result=await inspectCloudflareConnection(input,config,fetchImpl);
    if(result.publicBoundaryVerified){
      this.boundaryAt=this.clock();this.degraded=false;
    }else{
      this.boundaryAt=undefined;this.mcpAt=undefined;this.agentAt=undefined;
      this.degraded=true;
    }
    return this.current();
  }
  /** The probe executes a real authorized read-only tool; no caller-supplied
   * "ready" boolean can promote this status. */
  async proveAuthenticatedMcp(input:ConnectionV2AuthenticatedProbe):
    Promise<ConnectionV2AuthenticatedResult>{
    if(!this.local)return {
      stage:'UNAVAILABLE',code:'LOCAL_PROCESS_NOT_RUNNING',
      publicBoundaryVerified:false,authenticatedToolVerified:false,
      sessionIdObserved:false,completedSteps:[],
    };
    const result=await verifyConnectionV2AuthenticatedReadOnly(input);
    if(result.authenticatedToolVerified&&result.publicBoundaryVerified&&
       result.completedSteps.includes('tools_call_completed')){
      this.boundaryAt=this.clock();this.mcpAt=this.clock();this.degraded=false;
    }else{this.mcpAt=undefined;this.degraded=true;}
    return result;
  }
  /** Only a trusted Hub/device-auth layer may invoke this after verifying
   * the real credential. A client-supplied device ID is NOT sufficient. */
  observeHubAgentAdmission(grant:ConnectionV2AgentGrantObservation):ConnectionV2State{
    const now=this.clock();
    if(!this.local||!grant.remoteOnly||
       grant.hubAdmissionContract!=='device-bound-revalidate-v1'||
       !grant.boundDeviceId||grant.boundDeviceId!==grant.helloDeviceId||
       grant.revoked===true||!Number.isFinite(grant.expiresAtMs)||
       grant.expiresAtMs<=now){
      this.agentAt=undefined;this.agentExpiresAt=undefined;this.degraded=true;
      return this.current();
    }
    this.agentAt=now;
    this.agentExpiresAt=grant.expiresAtMs;
    this.degraded=false;
    return this.current();
  }
  /** Disconnects and revocations must fail closed rather than recycling stale
   * readiness. In particular, never replay UNKNOWN mutations here. */
  observeDisconnect(kind:'hub'|'agent'|'local-process'):ConnectionV2State{
    if(kind==='local-process')return this.observeLocalProcess(false);
    this.degraded=true;
    if(kind==='hub'){this.boundaryAt=undefined;this.mcpAt=undefined;this.agentAt=undefined;this.agentExpiresAt=undefined;}
    else {this.agentAt=undefined;this.agentExpiresAt=undefined;}
    return this.current();
  }
  current():ConnectionV2State{
    if(!this.local)return 'UNAVAILABLE';
    const now=this.clock();
    const fresh=(time:number|undefined)=>time!==undefined &&
      now>=time && now-time<=this.ttl;
    const stale=(time:number|undefined)=>time!==undefined&&!fresh(time);
    if(this.degraded||
       (this.agentExpiresAt!==undefined&&now>=this.agentExpiresAt)||
       stale(this.processObservedAt)||
       stale(this.boundaryAt)||stale(this.mcpAt)||stale(this.agentAt))
      return 'DEGRADED';
    return deriveConnectionV2State({
      localProcessRunning:this.local,
      publicOauthBoundaryOk:fresh(this.boundaryAt),
      authenticatedMcpToolComplete:fresh(this.mcpAt),
      agentAuthenticated:fresh(this.agentAt),
    });
  }
}
