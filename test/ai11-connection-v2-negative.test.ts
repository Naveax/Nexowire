import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,copyFile,writeFile,readFile,rm,chmod} from 'node:fs/promises';
import {createServer} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {loadConfig} from '../src/config.js';
import {cloudflareConnectionConfig,startCloudflareConnection} from '../src/mcp/local-first-cloudflare.js';
import {createControlPlaneAgentCredentialVerifier,createControlPlaneAgentPresenceReporter} from '../src/hub/control-plane-agent-auth.js';
import {verifyLocalFirstPublicUpstream} from '../src/mcp/local-first-ingress.js';
import {inspectCloudflareConnection} from '../src/mcp/cloudflare-connection-doctor.js';

// AI-11 independent, source-only negative evidence for Draft #1003.
// These fixtures never contact the real Cloudflare account, DNS, or user PCs.
// The P1-C assertions are deliberately RED against the reviewed #1003 HEAD.
// Do not weaken them to make the CI green before fixing the product boundary.
function profile(){
  return {version:1,hostname:'mcp.example.test',tunnelId:randomUUID(),
    binary:path.resolve('disposable-cloudflared'),binarySha256:'a'.repeat(64),
    credentialsFile:path.resolve('disposable-tunnel-credentials.json'),
    listenPort:43111};
}
function config(authority='https://control.example.test'){
  return loadConfig({
    NEXOWIRE_HTTP_PORT:'43110',
    NEXOWIRE_MCP_RESOURCE_URL:'https://mcp.example.test/mcp',
    NEXOWIRE_CONTROL_PLANE_URL:authority,
    NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN:'disposable-service-token-0123456789',
  });
}

test('AI-11 P1-C: public Cloudflare ingress refuses loopback, private and link-local control-plane authorities',()=>{
  const valid=cloudflareConnectionConfig(profile(),config());
  assert.equal(valid.profile.hostname,'mcp.example.test');
  for(const authority of [
    'http://localhost:8765',
    'https://127.0.0.1',
    'https://[::1]',
    'https://0x7f000001',
    'https://10.7.0.1',
    'https://172.16.0.9',
    'https://192.168.1.4',
    'https://169.254.169.254',
  ]){
    assert.throws(()=>cloudflareConnectionConfig(profile(),config(authority)),
      'Cloudflare publication must reject non-public control-plane authority: '+authority);
  }
});

test('AI-11 P1-C: public Cloudflare ingress rejects non-HTTPS and noncanonical authority URL forms',()=>{
  for(const authority of [
    'http://control.example.test',
    'https://user:pass@control.example.test',
    'https://control.example.test/?next=http://127.0.0.1',
    'https://control.example.test/#fragment',
  ]){
    assert.throws(()=>cloudflareConnectionConfig(profile(),config(authority)),
      'Cloudflare publication must reject unsafe control-plane URL form: '+authority);
  }
});

test('AI-11: default ingress does not expose Agent, admin or unknown routes',()=>{
  const {tunnelConfig}=cloudflareConnectionConfig(profile(),config());
  const match=new RegExp(tunnelConfig.ingress[0]!.path!);
  for(const route of ['/agent','/admin','/health','/mcp/../agent','/mcp?token=example']){
    assert.equal(match.test(route),false,route);
  }
  assert.deepEqual(tunnelConfig.ingress.at(-1),{service:'http_status:404'});
});

test('AI-11: unreachable public Cloudflare/OAuth boundary cannot claim authenticated MCP readiness',async()=>{
  let requests=0;
  const result=await inspectCloudflareConnection(profile(),config(),async (_input,init)=>{
    requests++;
    assert.equal(new Headers(init?.headers).has('authorization'),false);
    assert.equal(init?.redirect,'error');
    throw new Error('disposable simulated remote TLS/offline failure');
  });
  assert.equal(requests,1);
  assert.equal(result.publicBoundaryVerified,false);
  assert.equal(result.authenticatedToolVerified,false);
  assert.equal(result.stage,'PUBLIC_CONNECTION_UNAVAILABLE');
});


test('AI-11 P1-C: device authentication POST forbids automatic HTTP redirects',async()=>{
  let redirect:string|undefined;
  let calls=0;
  const verify=createControlPlaneAgentCredentialVerifier({
    controlPlaneUrl:'https://control.example.test',
    serviceToken:'disposable-service-token-0123456789',
    fetchImpl:async (_url,init)=>{
      calls++;
      redirect=init?.redirect;
      return Response.json({authenticated:true,device:{deviceId:'disposable-device-01'}});
    },
  });
  assert.deepEqual(await verify('Bearer nwx_dev_disposable-device-token'),{deviceId:'disposable-device-01'});
  assert.equal(calls,1);
  assert.equal(redirect,'error','authenticated control-plane POST must not follow redirects carrying service credentials or device tokens');
});

test('AI-11 P1-C: device presence POST forbids automatic HTTP redirects',async()=>{
  let redirect:string|undefined;
  let calls=0;
  const report=createControlPlaneAgentPresenceReporter({
    controlPlaneUrl:'https://control.example.test',
    serviceToken:'disposable-service-token-0123456789',
    fetchImpl:async (_url,init)=>{
      calls++;
      redirect=init?.redirect;
      return Response.json({updated:true});
    },
  });
  assert.equal(await report({deviceId:'disposable-device-01',online:false,at:'2026-11-01T00:00:00Z'}),true);
  assert.equal(calls,1);
  assert.equal(redirect,'error','presence POST must not follow redirects carrying protected service credentials');
});

// A local in-memory Hub proves that a nonofficial-but-profile-hash-matching
// native executable is not refused due to a broken Hub or invalid tunnel JSON.
// Never use a real account, service token, outbound network or Cloudflare DNS.
async function fakeHub(t:import('node:test').TestContext){
  const hub=createServer((req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/health'){
      res.end(JSON.stringify({ok:true,service:'nexowire',runtime:{ownerOauthConfigured:true}}));
    }else if(req.url==='/.well-known/oauth-protected-resource/mcp'){
      res.end(JSON.stringify({resource:'https://mcp.example.test/mcp',authorization_servers:['https://control.example.test']}));
    }else{
      res.writeHead(404);res.end('{}');
    }
  });
  await new Promise<void>(r=>hub.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise<void>(r=>hub.close(()=>r())));
  const address=hub.address();assert.ok(address&&typeof address!=='string');
  const probe=createServer();
  await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));
  const socket=probe.address();assert.ok(socket&&typeof socket!=='string');
  await new Promise<void>(r=>probe.close(()=>r()));
  const c=loadConfig({
    NEXOWIRE_HTTP_PORT:String(address.port),
    NEXOWIRE_MCP_RESOURCE_URL:'https://mcp.example.test/mcp',
    NEXOWIRE_CONTROL_PLANE_URL:'https://control.example.test',
    NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN:'disposable-service-token-0123456789',
  });
  await verifyLocalFirstPublicUpstream({hubPort:address.port,expectedResourceUrl:c.mcpResourceUrl!});
  return {config:c,listenPort:socket.port};
}

test('AI-11 P1-B: matching profile SHA of an unrelated executable is not trusted official cloudflared provenance',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'nw-ai11-nonofficial-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100}));
  const binary=path.join(root,process.platform==='win32'?'nonofficial.exe':'nonofficial');
  // A real native executable deliberately *not* published by Cloudflare.
  // It only receives harmless argv and never has genuine tunnel credentials.
  await copyFile(process.execPath,binary);
  if(process.platform!=='win32')await chmod(binary,0o700);
  const bytes=await readFile(binary);
  const credentialsFile=path.join(root,'disposable-credentials.json');
  const tunnelId=randomUUID();
  await writeFile(credentialsFile,JSON.stringify({
    TunnelID:tunnelId,AccountTag:'a'.repeat(32),
    TunnelSecret:Buffer.alloc(32,7).toString('base64'),
  }),{mode:0o600});
  const {config:c,listenPort}=await fakeHub(t);
  const p={version:1,hostname:'mcp.example.test',tunnelId,binary,
    binarySha256:createHash('sha256').update(bytes).digest('hex'),
    credentialsFile,listenPort};
  let handle:Awaited<ReturnType<typeof startCloudflareConnection>>|undefined;
  try{
    await assert.rejects(async()=>{handle=await startCloudflareConnection(p,c);},
      /publisher|signature|authenticode|official|untrusted|provenance|artifact|certificate|binary identity/i,
      'a profile-controlled SHA256 cannot authenticate a Cloudflare publisher');
  }finally{
    await handle?.close();
  }
});
