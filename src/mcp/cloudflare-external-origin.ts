import {promises as fs} from 'node:fs';
import path from 'node:path';
import * as z from 'zod';
import type {NexowireConfig} from '../config.js';
import {normalizePublicControlPlaneAuthority} from '../hub/control-plane-network-policy.js';
import {runLocalFirstIngress,validateLocalFirstIngress,verifyLocalFirstPublicUpstream} from './local-first-ingress.js';

/**
 * Externally managed Cloudflare tunnel mode.
 *
 * Nexowire owns ONLY the loopback origin. An independently installed Windows
 * cloudflared service owns its own executable, credentials, configuration and
 * lifecycle. This path never reads tunnel secrets or launches a binary.
 * It is not an attestation of the external Windows service or public tunnel.
 */
const ExternalProfile=z.strictObject({
  version:z.literal(1),
  hostname:z.string().min(4).max(253),
  listenPort:z.number().int().min(1).max(65535).default(43111),
  publishAgentEndpoint:z.boolean().default(false),
});

export function externalCloudflareIngressPlan(input:unknown,config:NexowireConfig){
  const profile=ExternalProfile.parse(input);
  const safe=validateLocalFirstIngress({
    hubPort:config.port,
    listenPort:profile.listenPort,
    publicHostname:profile.hostname,
    allowAgentWebSocket:profile.publishAgentEndpoint,
  });
  const resource=config.mcpResourceUrl?new URL(config.mcpResourceUrl):undefined;
  if(!config.controlPlaneAgentAuth||!resource||
      resource.protocol!=='https:'||
      resource.hostname!==safe.publicHostname||
      resource.port!==''||resource.pathname!=='/mcp'||
      resource.search!==''||resource.hash!==''||
      resource.username!==''||resource.password!==''||
      safe.publicHostname!.endsWith('.trycloudflare.com')||
      safe.publicHostname!.endsWith('.ts.net')){
    throw new Error('External Cloudflare ingress requires matching stable HTTPS MCP resource and hosted OAuth authority');
  }
  try{normalizePublicControlPlaneAuthority(config.controlPlaneAgentAuth.url);}
  catch{throw new Error('External Cloudflare ingress requires a canonical global HTTPS control-plane authority');}
  if(profile.publishAgentEndpoint&&config.remoteAgentAuthOnly!==true){
    throw new Error('External Cloudflare Agent ingress requires remote-only owner/device authorization');
  }
  return {profile,ingress:{
    hubPort:config.port,
    listenPort:profile.listenPort,
    publicHostname:safe.publicHostname!,
    ...(profile.publishAgentEndpoint?{allowAgentWebSocket:true}:{}),
  }};
}

async function readExternalProfileFile(profileFile:string){
  if(!path.isAbsolute(profileFile)||/[\r\n\0]/.test(profileFile))
    throw new Error('External Cloudflare profile requires an absolute file path');
  const stat=await fs.lstat(profileFile);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024)
    throw new Error('External Cloudflare profile must be a bounded regular file');
  return ExternalProfile.parse(JSON.parse(await fs.readFile(profileFile,'utf8')));
}

/** Local readiness ONLY. No Cloudflare service, public DNS or credentials are
 * inspected; the report cannot establish off-network acceptance. It reads
 * the already-running Hub rather than duplicating protected service-token
 * configuration in a diagnostic process. */
export async function inspectExternalCloudflareIngress(
  profileFile:string,hubPort:number,
){
  const profile=await readExternalProfileFile(profileFile);
  const summary={
    kind:'NEXOWIRE_EXTERNAL_CLOUDFLARE_LOCAL_PREFLIGHT',
    publicHostname:profile.hostname,
    hubPort,listenPort:profile.listenPort,
    publishAgentEndpoint:profile.publishAgentEndpoint,
    realPublicTunnel:'NOT_RUN',
  };
  let safe:ReturnType<typeof validateLocalFirstIngress>;
  try{
    safe=validateLocalFirstIngress({
      hubPort,listenPort:profile.listenPort,publicHostname:profile.hostname,
      allowAgentWebSocket:profile.publishAgentEndpoint,
    });
    if(safe.publicHostname!.endsWith('.trycloudflare.com')||
       safe.publicHostname!.endsWith('.ts.net'))
      throw new Error('External Cloudflare origin requires a stable public hostname');
  }catch(error){
    return {...summary,status:'BLOCKED' as const,
      oauthMetadataVerified:false,strictAgentContractAdvertised:false,
      reason:(error instanceof Error?error.message:String(error)).slice(0,300)};
  }
  const expectedResourceUrl=`https://${safe.publicHostname}/mcp`;
  try{
    await verifyLocalFirstPublicUpstream({hubPort,expectedResourceUrl});
  }catch(error){
    return {...summary,status:'BLOCKED' as const,
      oauthMetadataVerified:false,strictAgentContractAdvertised:false,
      reason:(error instanceof Error?error.message:String(error)).slice(0,300)};
  }
  // Distinguish an OAuth-ready Hub from one that cannot yet admit remote
  // Agent sockets. Reverify the whole upstream boundary with strict Agent
  // admission instead of assuming the initial OAuth check is enough.
  if(profile.publishAgentEndpoint){
    try{
      await verifyLocalFirstPublicUpstream({
        hubPort,expectedResourceUrl,requireRemoteAgentAdmission:true,
      });
    }catch(error){
      return {...summary,status:'BLOCKED' as const,
        oauthMetadataVerified:true,strictAgentContractAdvertised:false,
        reason:(error instanceof Error?error.message:String(error)).slice(0,300)};
    }
  }
  return {...summary,status:'READY_LOCAL' as const,
    oauthMetadataVerified:true,
    strictAgentContractAdvertised:profile.publishAgentEndpoint};
}

export async function runExternalCloudflareIngress(profileFile:string,config:NexowireConfig):Promise<void>{
  const profile=await readExternalProfileFile(profileFile);
  const {ingress}=externalCloudflareIngressPlan(profile,config);
  // Refuse to expose even loopback ingress unless the local Hub already
  // advertises matching OAuth metadata and, if requested, strict Agent auth.
  await verifyLocalFirstPublicUpstream({
    hubPort:ingress.hubPort,
    expectedResourceUrl:config.mcpResourceUrl!,
    requireRemoteAgentAdmission:profile.publishAgentEndpoint,
  });
  // No Windows service install, executable spawn, privilege escalation,
  // credential copy, public DNS change or automatic retry occurs here.
  await runLocalFirstIngress(ingress);
}
