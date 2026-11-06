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

export async function runExternalCloudflareIngress(profileFile:string,config:NexowireConfig):Promise<void>{
  if(!path.isAbsolute(profileFile)||/[\r\n\0]/.test(profileFile))
    throw new Error('External Cloudflare profile requires an absolute file path');
  const stat=await fs.lstat(profileFile);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024)
    throw new Error('External Cloudflare profile must be a bounded regular file');
  const {profile,ingress}=externalCloudflareIngressPlan(
    JSON.parse(await fs.readFile(profileFile,'utf8')),config);
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
