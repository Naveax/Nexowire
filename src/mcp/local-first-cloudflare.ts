import {promises as fs,constants as fsFlags,type BigIntStats} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import * as z from 'zod';
import type {NexowireConfig} from '../config.js';
import {createLocalFirstIngressServer,validateLocalFirstIngress,closeLocalFirstAgentSockets,
  verifyLocalFirstPublicUpstream} from './local-first-ingress.js';
import {windowsDpapiChildEnvironment} from '../security/windows-dpapi.js';
import {readCloudflareTunnelCredential} from './cloudflare-credential-custody.js';
import {prepareTrustedCloudflared,type TrustedCloudflared} from './cloudflare-binary-trust.js';
import {normalizeControlPlaneBase} from '../hub/control-plane-network-policy.js';

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
  // A local-only loopback authority is valid for development, but must never
  // become the authenticated control plane for a publicly published tunnel.
  // Reuse the DNS/IP-safe network policy instead of trusting URL() parsing.
  try {
    const controlPlane=normalizeControlPlaneBase(config.controlPlaneAgentAuth.url);
    if(new URL(controlPlane).protocol!=='https:')throw new Error('HTTPS required');
  } catch {
    throw new Error('Public Cloudflare connection requires a canonical global HTTPS control-plane authority');
  }
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

/** A narrow, identity-bound cleanup. Never recursively remove an untrusted
 * runtime path: a renamed/replaced temporary directory could contain someone
 * else's files. On Linux use the opened directory's /proc fd for child unlink,
 * so a parent-path swap cannot redirect deletion.
 * Returns false on drift and leaves the suspicious files untouched.
 */
export async function cleanupOwnedCloudflareRuntime(
  directory:string,root:BigIntStats,files:ReadonlyArray<{name:string;identity:BigIntStats}>,
):Promise<boolean>{
  if(!root.isDirectory()||root.isSymbolicLink()||
     (process.platform!=='win32'&&(root.mode&0o077n)!==0n))return false;
  const seen=new Set<string>();
  for(const file of files){
    if(!['tunnel-credentials.json','config.json'].includes(file.name)||seen.has(file.name)||
       !file.identity.isFile()||file.identity.isSymbolicLink()||file.identity.nlink!==1n)
      return false;
    seen.add(file.name);
  }
  let handle:Awaited<ReturnType<typeof fs.open>>|undefined;
  try{
    if(process.platform==='linux'){
      handle=await fs.open(directory,fsFlags.O_RDONLY|fsFlags.O_DIRECTORY|fsFlags.O_NOFOLLOW);
    }
    const stable=handle?await handle.stat({bigint:true}):await fs.lstat(directory,{bigint:true});
    const matches=(a:BigIntStats,b:BigIntStats)=>a.dev===b.dev&&a.ino===b.ino&&a.uid===b.uid;
    if(!stable.isDirectory()||stable.isSymbolicLink()||!matches(root,stable))return false;
    const owned=handle?`/proc/self/fd/${handle.fd}`:directory;
    const existing=await fs.readdir(owned);
    if(existing.length!==files.length||existing.some(name=>!seen.has(name)))return false;
    // Validate the entire inventory BEFORE deleting anything.
    for(const {name,identity} of files){
      const actual=await fs.lstat(path.join(owned,name),{bigint:true});
      if(!actual.isFile()||actual.isSymbolicLink()||actual.nlink!==1n||
         !matches(actual,identity)||
         (process.platform!=='win32'&&(actual.mode&0o077n)!==0n))return false;
    }
    for(const {name,identity} of files){
      const actual=await fs.lstat(path.join(owned,name),{bigint:true});
      if(!matches(actual,identity))return false;
      await fs.unlink(path.join(owned,name));
    }
    const final=await fs.lstat(directory,{bigint:true});
    if(!matches(final,root)||!final.isDirectory())return false;
    await fs.rmdir(directory);
    return true;
  }catch{return false;}
  finally{await handle?.close().catch(()=>{});}
}

/** Foreground owner process, suitable for a user-logon task. Stops only its
 * own connector/origin; never restarts Hub, Agent, Broker or Tailscale. */
export async function startCloudflareConnection(input:unknown,config:NexowireConfig){
  const {profile,safe,tunnelConfig}=cloudflareConnectionConfig(input,config);
  const binary=await regularFile(profile.binary,256*1024*1024);
  if(createHash('sha256').update(binary).digest('hex')!==profile.binarySha256)
    throw new Error('Cloudflare connector binary checksum mismatch');
  // Windows has no approved immutable-image launcher. Refuse untrusted
  // publisher/provenance before consuming credentials or contacting Hub.
  // A profile-controlled digest alone never authenticates the publisher.
  if(process.platform==='win32')
    await prepareTrustedCloudflared(profile.binary,profile.binarySha256);
  const credentialBytes=await readCloudflareTunnelCredential(profile.credentialsFile);
  let credentials:{TunnelID?:string;AccountTag?:string;TunnelSecret?:string};
  try{credentials=JSON.parse(credentialBytes.toString('utf8')) as typeof credentials;}
  catch{throw Error('Cloudflare tunnel credential format invalid');}
  if(credentials.TunnelID!==profile.tunnelId ||
      !/^[a-f0-9]{32}$/i.test(credentials.AccountTag??'') ||
      typeof credentials.TunnelSecret!=='string' ||
      !/^[A-Za-z0-9+/]{43}=$/.test(credentials.TunnelSecret) ||
      Buffer.from(credentials.TunnelSecret,'base64').length!==32)
    throw new Error('Cloudflare tunnel credentials do not match the selected tunnel');
  await verifyLocalFirstPublicUpstream({hubPort:config.port,expectedResourceUrl:config.mcpResourceUrl!,
    requireRemoteAgentAdmission:profile.publishAgentEndpoint});
  // Windows has no approved held-image custodian. Reject before writing even a
  // temporary copy of the secret. Linux opens and stages the approved image.
  const approvedImage=await prepareTrustedCloudflared(profile.binary,profile.binarySha256);
  let dir:string;
  try{dir=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-cloudflare-'));}
  catch(error){await approvedImage.dispose();throw error;}
  const runtimeRoot=await fs.lstat(dir,{bigint:true});
  const runtimeFiles:Array<{name:string;identity:BigIntStats}>=[];
  const origin=createLocalFirstIngressServer(safe);
  let child:ReturnType<typeof spawn>|undefined;
  let trusted:TrustedCloudflared|undefined=approvedImage;
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
    try{await trusted?.dispose();}
    finally{
      if(!await cleanupOwnedCloudflareRuntime(dir,runtimeRoot,runtimeFiles))
        throw Error('Cloudflare runtime custody drift: unsafe cleanup refused');
    }
  })();
  try{
    // Cloudflared must NEVER reopen the original mutable credential pathname.
    // The private configuration points to a new owner-only copy of verified bytes.
    const secretCopy=path.join(dir,'tunnel-credentials.json');
    await fs.writeFile(secretCopy,credentialBytes,{flag:'wx',mode:0o600});
    const secretStat=await fs.lstat(secretCopy);
    if(!secretStat.isFile()||secretStat.isSymbolicLink()||secretStat.nlink!==1||
       (process.platform!=='win32'&&(secretStat.mode&0o077)!==0))
      throw Error('Cloudflare tunnel credential custody unsafe');
    runtimeFiles.push({name:'tunnel-credentials.json',identity:await fs.lstat(secretCopy,{bigint:true})});
    tunnelConfig['credentials-file']=secretCopy;
    // Linux uses descriptor-bound exec, never the owner-supplied binary path.
    // Windows remains fail closed until a native immutable-image launch exists.
    const file=path.join(dir,'config.json');
    await fs.writeFile(file,JSON.stringify(tunnelConfig),{mode:0o600,flag:'wx'});
    runtimeFiles.push({name:'config.json',identity:await fs.lstat(file,{bigint:true})});
    await new Promise<void>((resolve,reject)=>{
      origin.once('error',reject);
      origin.listen(profile.listenPort,'127.0.0.1',()=>{origin.off('error',reject);resolve();});
    });
    // #402 reviewed sink: verified opened image fd (not mutable profile path),
    // fixed arguments, no shell, inherited env, stdin, or secret-bearing logs.
    child=spawn(trusted.command,['tunnel','--config',file,'--no-autoupdate',
      '--protocol','auto','--loglevel','error','run',profile.tunnelId],{
      cwd:dir,env:cloudflareChildEnvironment(),windowsHide:true,
      stdio:['ignore','ignore','ignore',trusted.imageFd],
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
