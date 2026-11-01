import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import * as z from 'zod';
import type {NexowireConfig} from '../config.js';
import {createLocalFirstIngressServer,validateLocalFirstIngress,closeLocalFirstAgentSockets,
  verifyLocalFirstPublicUpstream} from './local-first-ingress.js';
import {windowsDpapiChildEnvironment} from '../security/windows-dpapi.js';

const absoluteFile=z.string().min(1).max(4096).refine(value=>
  path.isAbsolute(value)&&!/[\r\n\0]/.test(value),'Absolute local file path required');
const Profile=z.object({
  version:z.literal(1),
  hostname:z.string().min(4).max(253),
  tunnelId:z.string().uuid(),
  credentialsFile:absoluteFile,
  binary:absoluteFile,
  binarySha256:z.string().regex(/^[a-f0-9]{64}$/),
  listenPort:z.number().int().min(1).max(65535).default(43111),
  publishAgentEndpoint:z.boolean().default(false),
}).strict();
export type CloudflareConnectionProfile=z.infer<typeof Profile>;

/** Local configuration only: never creates a tunnel, DNS record or Agent. */
export function cloudflareConnectionConfig(input:unknown,config:NexowireConfig){
  const profile=Profile.parse(input);
  const safe=validateLocalFirstIngress({hubPort:config.port,
    listenPort:profile.listenPort,publicHostname:profile.hostname,allowAgentWebSocket:profile.publishAgentEndpoint});
  const resource=config.mcpResourceUrl?new URL(config.mcpResourceUrl):undefined;
  if(!config.controlPlaneAgentAuth || !resource || resource.protocol!=='https:' ||
      resource.hostname!==safe.publicHostname || resource.port || resource.pathname!=='/mcp' ||
      resource.search || resource.hash || resource.username || resource.password ||
      safe.publicHostname!.endsWith('.trycloudflare.com') ||
      safe.publicHostname!.endsWith('.ts.net'))
    throw new Error('Cloudflare connection requires stable HTTPS MCP resource and hosted OAuth authority');
  if(profile.publishAgentEndpoint&&config.remoteAgentAuthOnly!==true)
    throw new Error('Public Agent endpoint requires remote-only Agent authentication');
  const tunnelConfig={
    tunnel:profile.tunnelId,
    'credentials-file':profile.credentialsFile,
    ingress:[{
      hostname:safe.publicHostname,
      path:profile.publishAgentEndpoint?'^(/agent|/mcp|/\\.well-known/oauth-protected-resource(/mcp)?)$':
        '^(/mcp|/\\.well-known/oauth-protected-resource(/mcp)?)$',
      service:`http://127.0.0.1:${profile.listenPort}`,
      originRequest:{httpHostHeader:safe.publicHostname},
    },{service:'http_status:404'}],
  };
  return {profile,safe,tunnelConfig};
}

export function cloudflareChildEnvironment():NodeJS.ProcessEnv{
  if(process.platform==='win32')return windowsDpapiChildEnvironment();
  // No proxy, TUNNEL_*, cloud account tokens, loader hooks or PATH inheritance.
  return {PATH:'/usr/bin:/bin',HOME:os.homedir(),LANG:'C.UTF-8'};
}

async function regularFile(file:string,max:number){
  const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>max)
    throw new Error('Cloudflare connection file is not a bounded regular file');
  return fs.readFile(file);
}

/** Foreground owner process, suitable for a user-logon task. Stops only its
 * own connector/origin; never restarts Hub, Agent, Broker or Tailscale. */
export async function startCloudflareConnection(input:unknown,config:NexowireConfig){
  const {profile,safe,tunnelConfig}=cloudflareConnectionConfig(input,config);
  const binary=await regularFile(profile.binary,256*1024*1024);
  if(createHash('sha256').update(binary).digest('hex')!==profile.binarySha256)
    throw new Error('Cloudflare connector binary checksum mismatch');
  const credentials=JSON.parse((await regularFile(profile.credentialsFile,16*1024)).toString('utf8'));
  if(credentials.TunnelID!==profile.tunnelId ||
      !/^[a-f0-9]{32}$/i.test(credentials.AccountTag??'') ||
      typeof credentials.TunnelSecret!=='string' ||
      !/^[A-Za-z0-9+/]{43}=$/.test(credentials.TunnelSecret) ||
      Buffer.from(credentials.TunnelSecret,'base64').length!==32)
    throw new Error('Cloudflare tunnel credentials do not match the selected tunnel');
  await verifyLocalFirstPublicUpstream({hubPort:config.port,expectedResourceUrl:config.mcpResourceUrl!,
    requireRemoteAgentAdmission:profile.publishAgentEndpoint});
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-cloudflare-'));
  const origin=createLocalFirstIngressServer(safe);
  let child:ReturnType<typeof spawn>|undefined;
  let stopped=false;
  let exit:Promise<void>|undefined;
  let closePromise:Promise<void>|undefined;
  const close=()=>closePromise??=(async()=>{
    stopped=true;
    if(child&&child.exitCode===null&&child.signalCode===null){
      child.kill('SIGTERM');
      const timer=setTimeout(()=>child?.kill('SIGKILL'),5000);
      try{await exit;}finally{clearTimeout(timer);}
    }
    closeLocalFirstAgentSockets(origin);origin.closeAllConnections();
    await new Promise<void>(resolve=>origin.close(()=>resolve()));
    await fs.rm(dir,{recursive:true,force:true});
  })();
  try{
    const file=path.join(dir,'config.json');
    await fs.writeFile(file,JSON.stringify(tunnelConfig),{mode:0o600,flag:'wx'});
    await new Promise<void>((resolve,reject)=>{
      origin.once('error',reject);
      origin.listen(profile.listenPort,'127.0.0.1',()=>{origin.off('error',reject);resolve();});
    });
    // #402 reviewed headless sink: hash-pinned absolute executable; no shell,
    // raw token, inherited environment, stdin, or unbounded secret-bearing log.
    child=spawn(profile.binary,['tunnel','--config',file,'--no-autoupdate',
      '--protocol','auto','--loglevel','error','run',profile.tunnelId],{
      cwd:dir,env:cloudflareChildEnvironment(),windowsHide:true,stdio:'ignore',
    });
    exit=new Promise<void>(resolve=>{child!.once('exit',()=>resolve());child!.once('error',()=>resolve());});
    const current=child;
    await new Promise<void>((resolve,reject)=>{current.once('spawn',resolve);current.once('error',()=>reject(Error('Cloudflare connector could not start')));});
    const done=exit.then(async()=>{if(!stopped){await close();throw Error('Cloudflare connector exited; connection unavailable');}});
    // Prevent an unhandled rejection between returning the handle and awaiting it.
    void done.catch(()=>{});
    return {close,done,resource:config.mcpResourceUrl!};
  }catch(error){await close();throw error;}
}

export async function runCloudflareConnection(profileFile:string,config:NexowireConfig){
  if(!path.isAbsolute(profileFile))throw new Error('Cloudflare profile path must be absolute');
  const profile=JSON.parse((await regularFile(profileFile,16*1024)).toString('utf8'));
  const handle=await startCloudflareConnection(profile,config);
  const stop=()=>{void handle.close();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  // Process launch is not remote readiness. Do not print token/path/account IDs.
  process.stderr.write('Nexowire Cloudflare connector started; external OAuth/MCP readiness not yet verified.\n');
  try{await handle.done;}finally{
    process.off('SIGINT',stop);process.off('SIGTERM',stop);await handle.close();
  }
}
