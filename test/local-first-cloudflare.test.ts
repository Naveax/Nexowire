import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm,copyFile,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadConfig} from '../src/config.js';
import {cloudflareConnectionConfig,cloudflareChildEnvironment,startCloudflareConnection} from '../src/mcp/local-first-cloudflare.js';

function config(port=43110){return loadConfig({
  NEXOWIRE_HTTP_PORT:String(port),NEXOWIRE_MCP_RESOURCE_URL:'https://mcp.example.test/mcp',
  NEXOWIRE_CONTROL_PLANE_URL:'https://control.example.test',
  NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN:'disposable-test-service-secret',
});}
function profile(){return {version:1,hostname:'mcp.example.test',tunnelId:randomUUID(),
  binary:path.resolve('cloudflared'),binarySha256:'a'.repeat(64),
  credentialsFile:path.resolve('tunnel-credentials.json'),listenPort:43111};}

test('Cloudflare-only route restricts exact hostname/path to loopback MCP origin and denies everything else',()=>{
  const p=profile();const {tunnelConfig}=cloudflareConnectionConfig(p,config());
  const rule=tunnelConfig.ingress[0]!;
  assert.equal(rule.service,'http://127.0.0.1:43111');
  const matcher=new RegExp(rule.path!);
  for(const route of ['/mcp','/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'])assert.ok(matcher.test(route));
  for(const route of ['/agent','/health','/admin','/mcp/../agent','/mcp/','//mcp','/mcp?token=secret'])assert.equal(matcher.test(route),false);
  assert.deepEqual(tunnelConfig.ingress.at(-1),{service:'http_status:404'});
  assert.equal(JSON.stringify(tunnelConfig).includes('ts.net'),false);
});
test('reject arbitrary remote origin, transient endpoints, mismatched OAuth and hidden connector arguments',()=>{
  for(const changes of [{hostname:'a.trycloudflare.com'},{hostname:'pc.ts.net'},
    {hostname:'other.example.test'},{hostname:'*.example.test'},{hostname:'127.0.0.1'},
    {binary:'cloudflared'},{credentialsFile:'relative.json'},
    {listenPort:43110},{extraArgs:['--url','http://attacker.test']}])
    assert.throws(()=>cloudflareConnectionConfig({...profile(),...changes},config()));
  const c=config();delete c.controlPlaneAgentAuth;
  assert.throws(()=>cloudflareConnectionConfig(profile(),c));
});
test('connector does not inherit cloud credentials, proxy settings, loader hooks or caller tunnel overrides',()=>{
  const env=cloudflareChildEnvironment();
  for(const key of ['NODE_OPTIONS','TUNNEL_TOKEN','TUNNEL_URL','TUNNEL_ORIGIN_CERT','HTTP_PROXY','HTTPS_PROXY','CF_API_TOKEN','LD_PRELOAD'])
    assert.equal(Object.keys(env).some(k=>k.toLowerCase()===key.toLowerCase()),false);
});
test('checksum and tunnel identity are checked before any network exposure',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'nw-cf-identity-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const binary=path.join(dir,'connector');await writeFile(binary,'not an executable');
  const p={...profile(),binary,credentialsFile:path.join(dir,'credential.json')};
  await assert.rejects(startCloudflareConnection(p,config()),/checksum mismatch/);
  p.binarySha256=createHash('sha256').update('not an executable').digest('hex');
  await writeFile(p.credentialsFile,JSON.stringify({TunnelID:randomUUID(),AccountTag:'a'.repeat(32),TunnelSecret:Buffer.alloc(32).toString('base64')}));
  await assert.rejects(startCloudflareConnection(p,config()),/credentials do not match/);
});
test('connector exit closes only its own origin; existing local Hub stays available',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'nw-cf-exit-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const hub=createServer((req,res)=>{
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify(req.url==='/health'?
      {ok:true,service:'nexowire',runtime:{ownerOauthConfigured:true}}:
      {resource:'https://mcp.example.test/mcp',authorization_servers:['https://control.example.test']}));
  });
  await new Promise<void>(r=>hub.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise<void>(r=>hub.close(()=>r())));
  const address=hub.address();assert.ok(address&&typeof address!=='string');
  const reservation=createServer();await new Promise<void>(r=>reservation.listen(0,'127.0.0.1',r));
  const free=reservation.address();assert.ok(free&&typeof free!=='string');
  await new Promise<void>(r=>reservation.close(()=>r()));
  // A real disposable native executable deliberately exits on the fixed
  // cloudflared argv. This proves lifecycle cleanup, NOT cloud connectivity.
  const binary=path.join(dir,process.platform==='win32'?'connector.exe':'connector');
  await copyFile(process.execPath,binary);
  const p={...profile(),binary,listenPort:free.port,credentialsFile:path.join(dir,'credential.json'),
    binarySha256:createHash('sha256').update(await readFile(binary)).digest('hex')};
  await writeFile(p.credentialsFile,JSON.stringify({TunnelID:p.tunnelId,AccountTag:'a'.repeat(32),TunnelSecret:Buffer.alloc(32,7).toString('base64')}));
  const handle=await startCloudflareConnection(p,config(address.port));
  t.after(()=>handle.close());
  await assert.rejects(handle.done,/connector exited/);
  await handle.close();await handle.close();
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/health`)).status,200);
  // Port can be rebound immediately: no orphan origin after unexpected exit.
  const probe=createServer();await new Promise<void>((resolve,reject)=>{probe.once('error',reject);probe.listen(free.port,'127.0.0.1',resolve);});
  await new Promise<void>(r=>probe.close(()=>r()));
});

test('official hash-pinned cloudflared accepts generated configuration and rejects the Agent route',async t=>{
  const binary=process.env.NEXOWIRE_CLOUDFLARED_TEST_BINARY;
  if(!binary){t.skip('Official connector binary not provisioned; mandatory in Windows CI');return;}
  const expected=process.platform==='win32'?
    '4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6':
    '3bfc539f45d2620c71debb7a86be0efa737ed5ccbad9eb85c787116900e5c586';
  assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'),expected);
  const dir=await mkdtemp(path.join(os.tmpdir(),'nw-cf-official-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const {tunnelConfig}=cloudflareConnectionConfig(profile(),config());
  const file=path.join(dir,'config.json');await writeFile(file,JSON.stringify(tunnelConfig));
  function run(args:string[]){
    const result=spawnSync(binary!,['tunnel','--config',file,...args],{
      encoding:'utf8',timeout:15000,maxBuffer:16384,env:cloudflareChildEnvironment(),windowsHide:true,
    });
    assert.equal(result.status,0,result.error?.message??result.stderr);
    return result.stdout+result.stderr;
  }
  run(['ingress','validate']);
  assert.match(run(['ingress','rule','https://mcp.example.test/mcp']),/Matched rule #0/);
  assert.match(run(['ingress','rule','https://mcp.example.test/agent']),/Matched rule #1/);
  assert.match(run(['ingress','rule','https://other.example.test/mcp']),/Matched rule #1/);
  const hub=config();hub.remoteAgentAuthOnly=true;
  const published=cloudflareConnectionConfig({...profile(),publishAgentEndpoint:true},hub).tunnelConfig;
  await writeFile(file,JSON.stringify(published));
  assert.match(run(['ingress','rule','https://mcp.example.test/agent']),/Matched rule #0/);
  assert.match(run(['ingress','rule','https://mcp.example.test/admin']),/Matched rule #1/);
});
