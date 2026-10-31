import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {buildCloudflareConnectionLauncher,cloudflareConnectionLifecycle} from '../src/mcp/cloudflare-connection-lifecycle.js';
import {inspectCloudflareConnection} from '../src/mcp/cloudflare-connection-doctor.js';
import {loadConfig} from '../src/config.js';

const environment={NEXOWIRE_HTTP_PORT:'43110',NEXOWIRE_MCP_RESOURCE_URL:'https://mcp.example.test/mcp',
  NEXOWIRE_CONTROL_PLANE_URL:'https://control.example.test',
  NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_FILE:path.resolve('protected-service-token')};
// Avoid reading a real service-token file in the isolated read-only doctor.
const config=()=>loadConfig({...environment,NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_FILE:undefined,
  NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN:'disposable-secret-not-for-transmission'});
const profile=()=>({version:1,hostname:'mcp.example.test',tunnelId:randomUUID(),
  binary:path.resolve('cloudflared'),binarySha256:'a'.repeat(64),credentialsFile:path.resolve('credentials.json'),listenPort:43111});

test('connection launcher preserves quoted Unicode paths and only protected Hub configuration',()=>{
  const source=buildCloudflareConnectionLauncher(path.resolve("Ömer's profile.json"),{
    executable:process.execPath,cli:path.resolve("Ömer's cli.js"),
    env:{...environment,NODE_OPTIONS:'--import evil.js',TUNNEL_URL:'http://evil.test',UNRELATED_SECRET:'never-copy'},
  });
  assert.ok(source.startsWith('\uFEFF# Nexowire'));
  assert.ok(source.includes("Ömer''s profile.json"));
  assert.ok(source.includes("Ömer''s cli.js"));
  assert.ok(source.includes("'local-first' 'cloudflare-run'"));
  assert.equal(source.includes('evil.js'),false);assert.equal(source.includes('never-copy'),false);
  assert.ok(source.includes('Remove-Item'));
  assert.throws(()=>buildCloudflareConnectionLauncher('relative.json'));
  assert.throws(()=>buildCloudflareConnectionLauncher(path.resolve('profile.json'),{
    env:{NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN:'must-not-persist'},
  }),/plaintext/);
});

test('public doctor distinguishes OAuth metadata from authenticated tool readiness, without sending secrets',async()=>{
  let calls=0;
  const c=config();
  const status=await inspectCloudflareConnection(profile(),c,async(input,init)=>{
    assert.equal(new Headers(init?.headers).has('authorization'),false);
    assert.equal(JSON.stringify(init).includes('disposable-secret'),false);
    assert.equal(init?.redirect,'error');assert.ok(init?.signal);
    calls++;
    if(calls===1){assert.equal(String(input),'https://mcp.example.test/.well-known/oauth-protected-resource/mcp');
      return Response.json({resource:c.mcpResourceUrl,authorization_servers:['https://control.example.test/']});}
    assert.equal(init?.method,'POST');return new Response('',{status:401});
  });
  assert.equal(calls,2);assert.equal(status.publicBoundaryVerified,true);
  assert.equal(status.authenticatedToolVerified,false);
});
test('wrong public resource or issuer stops diagnostic before MCP POST',async()=>{
  for(const metadata of [
    {resource:'https://wrong.example.test/mcp',authorization_servers:['https://control.example.test']},
    {resource:'https://mcp.example.test/mcp',authorization_servers:['https://attacker.example.test']},
    {resource:'https://mcp.example.test/mcp',authorization_servers:['https://control.example.test','https://attacker.example.test']},
  ]){
    let calls=0;const status=await inspectCloudflareConnection(profile(),config(),async()=>{calls++;return Response.json(metadata);});
    assert.equal(calls,1);assert.equal(status.stage,'PUBLIC_OAUTH_RESOURCE_MISMATCH');
  }
});
test('network failure, excessive metadata and unauthenticated success never report ready',async()=>{
  assert.equal((await inspectCloudflareConnection(profile(),config(),async()=>{throw Error('network');})).publicBoundaryVerified,false);
  assert.equal((await inspectCloudflareConnection(profile(),config(),async()=>new Response('x'.repeat(16385)))).publicBoundaryVerified,false);
  let calls=0;
  assert.equal((await inspectCloudflareConnection(profile(),config(),async()=>++calls===1?
    Response.json({resource:'https://mcp.example.test/mcp',authorization_servers:['https://control.example.test']}):
    new Response('',{status:200}))).stage,'PUBLIC_AUTH_BOUNDARY_FAILED');
});

test('Windows user-logon task registers limited and cannot be silently overwritten',{
  skip:process.platform!=='win32',timeout:120000,
},async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'nw-cf-task-'));
  const file=path.join(root,'profile.json');await writeFile(file,JSON.stringify(profile()));
  const tokenFile=path.join(root,'protected-token.txt');await writeFile(tokenFile,'disposable-service-token-12345');
  const options={root,taskName:'Nexowire Cloudflare Test '+randomUUID(),
    env:{...environment,NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_FILE:tokenFile},
    executable:process.execPath,cli:path.resolve('dist/src/cli.js')};
  t.after(async()=>{
    await cloudflareConnectionLifecycle('uninstall',undefined,options);
    await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  const installed=await cloudflareConnectionLifecycle('install',file,options);
  assert.equal(installed.installed,true);assert.equal(installed.limited,true);assert.equal(installed.autostart,true);
  assert.notEqual(installed.state,'Running','registration does not interrupt or auto-start any existing process');
  const before=await readFile(path.join(root,'launch.ps1'),'utf8');
  await assert.rejects(cloudflareConnectionLifecycle('install',file,options),/already installed/);
  assert.equal(await readFile(path.join(root,'launch.ps1'),'utf8'),before);
  await cloudflareConnectionLifecycle('uninstall',undefined,options);
  assert.equal((await cloudflareConnectionLifecycle('status',undefined,options)).installed,false);
  // A clean uninstall permits a fresh explicit registration.
  assert.equal((await cloudflareConnectionLifecycle('install',file,options)).installed,true);
});

test('Windows connection task stop terminates its real disposable process tree',{
  skip:process.platform!=='win32',timeout:120000,
},async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'nw-cf-tree-'));
  const profileFile=path.join(root,'profile.json');await writeFile(profileFile,JSON.stringify(profile()));
  const tokenFile=path.join(root,'token.txt');await writeFile(tokenFile,'disposable-service-token-12345');
  const pidFile=path.join(root,'pids.json'),cli=path.join(root,'disposable.cjs');
  await writeFile(cli,`const {spawn}=require('node:child_process');const fs=require('node:fs');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000);`);
  const options={root,taskName:'Nexowire Cloudflare Tree Test '+randomUUID(),executable:process.execPath,cli,
    env:{...environment,NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_FILE:tokenFile}};
  let pids:{parent:number;child:number}|undefined;
  const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
  t.after(async()=>{
    await cloudflareConnectionLifecycle('stop',undefined,options);
    if(pids)for(const pid of [pids.child,pids.parent])if(alive(pid))process.kill(pid,'SIGKILL');
    await cloudflareConnectionLifecycle('uninstall',undefined,options);
    await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  await cloudflareConnectionLifecycle('install',profileFile,options);
  await cloudflareConnectionLifecycle('start',undefined,options);
  const deadline=Date.now()+20000;
  while(!pids&&Date.now()<deadline){try{pids=JSON.parse(await readFile(pidFile,'utf8'));}catch{await new Promise(r=>setTimeout(r,100));}}
  assert.ok(pids,'limited user-logon task must actually execute the disposable fixture');
  assert.equal(alive(pids.parent),true);assert.equal(alive(pids.child),true);
  await cloudflareConnectionLifecycle('stop',undefined,options);
  const stopDeadline=Date.now()+10000;
  while((alive(pids.parent)||alive(pids.child))&&Date.now()<stopDeadline)await new Promise(r=>setTimeout(r,100));
  assert.equal(alive(pids.parent),false,'task stop must stop the managed parent');
  assert.equal(alive(pids.child),false,'task stop must leave no orphan connector descendant');
});
