import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../../src/config.js';
import {externalCloudflareIngressPlan,inspectExternalCloudflareIngress} from '../../src/mcp/cloudflare-external-origin.js';

const profile=()=>({
  version:1 as const,
  hostname:'mcp.example.test',
  listenPort:43111,
  publishAgentEndpoint:false,
});
function config(remote=false){
  return loadConfig({
    NEXOWIRE_HTTP_PORT:'43110',
    NEXOWIRE_MCP_RESOURCE_URL:'https://mcp.example.test/mcp',
    NEXOWIRE_CONTROL_PLANE_URL:'https://control.example.test',
    NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN:'disposable-test-secret-only',
    ...(remote?{NEXOWIRE_AGENT_REMOTE_AUTH_ONLY:'1'}:{}),
  });
}

test('external Cloudflare ingress requires no executable, token or tunnel credentials',()=>{
  const plan=externalCloudflareIngressPlan(profile(),config());
  assert.deepEqual(plan.ingress,{
    hubPort:43110,listenPort:43111,publicHostname:'mcp.example.test',
  });
  assert.equal(JSON.stringify(plan).includes('binary'),false);
  assert.equal(JSON.stringify(plan).includes('credentialsFile'),false);
  for(const additional of [
    {binary:'C:\\bad.exe'}, {binarySha256:'a'.repeat(64)},
    {credentialsFile:'C:\\secret'}, {tunnelToken:'secret'},
    {extraArgs:['--url','http://example.test']},
  ]) assert.throws(()=>externalCloudflareIngressPlan({...profile(),...additional},config()));
});

test('external Cloudflare Agent WebSocket ingress is opt-in and bound to strict remote authorization',()=>{
  const published={...profile(),publishAgentEndpoint:true};
  assert.throws(()=>externalCloudflareIngressPlan(published,config()),/remote-only owner\/device/);
  const plan=externalCloudflareIngressPlan(published,config(true));
  assert.equal(plan.ingress.allowAgentWebSocket,true);
  assert.equal(plan.ingress.publicHostname,'mcp.example.test');
});

test('external origin rejects transient DNS, wrong OAuth resource and no trusted control plane',()=>{
  for(const bad of [
    {hostname:'demo.trycloudflare.com'},
    {hostname:'pc.ts.net'},
    {hostname:'localhost'},
    {hostname:'127.0.0.1'},
    {hostname:'*.example.test'},
    {listenPort:43110},
  ]) assert.throws(()=>externalCloudflareIngressPlan({...profile(),...bad},config()));
  const wrong=config();wrong.mcpResourceUrl='https://other.example.test/mcp';
  assert.throws(()=>externalCloudflareIngressPlan(profile(),wrong),/matching stable HTTPS/);
  const missing=config();delete missing.controlPlaneAgentAuth;
  assert.throws(()=>externalCloudflareIngressPlan(profile(),missing),/hosted OAuth/);
});

test('read-only external Cloudflare check verifies the real loopback Hub contract without opening an origin',async t=>{
  let resource='https://mcp.example.test/mcp';
  const server=createServer((req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/health'){
      res.end(JSON.stringify({ok:true,service:'nexowire',
        runtime:{ownerOauthConfigured:true}}));
      return;
    }
    if(req.url==='/.well-known/oauth-protected-resource/mcp'){
      res.end(JSON.stringify({resource,authorization_servers:['https://issuer.example.test']}));
      return;
    }
    res.statusCode=404;res.end('{}');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();
  assert.ok(address&&typeof address!=='string');
  const root=await mkdtemp(join(tmpdir(),'nw-cf-local-check-'));
  t.after(async()=>{
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(root,{recursive:true,force:true});
  });
  const file=join(root,'external-profile.json');
  await writeFile(file,JSON.stringify(profile()));
  const allowed=await inspectExternalCloudflareIngress(file,address.port);
  assert.equal(allowed.status,'READY_LOCAL');
  assert.equal(allowed.oauthMetadataVerified,true);
  assert.equal(allowed.publishAgentEndpoint,false);
  assert.equal(allowed.realPublicTunnel,'NOT_RUN');
  assert.equal(allowed.strictAgentContractAdvertised,false);

  await writeFile(file,JSON.stringify({...profile(),publishAgentEndpoint:true}));
  const denied=await inspectExternalCloudflareIngress(file,address.port);
  assert.equal(denied.status,'BLOCKED');
  assert.equal(denied.oauthMetadataVerified,true,'missing Agent admission must not erase verified OAuth evidence');
  assert.match(denied.reason,/remote-only device-bound revalidation/);
  assert.equal(denied.realPublicTunnel,'NOT_RUN');

  await writeFile(file,JSON.stringify(profile()));
  resource='https://different.example.test/mcp';
  const wrongOauth=await inspectExternalCloudflareIngress(file,address.port);
  assert.equal(wrongOauth.status,'BLOCKED');
  assert.equal(wrongOauth.oauthMetadataVerified,false);
  await writeFile(file,JSON.stringify({...profile(),hostname:'unstable.trycloudflare.com'}));
  const unstable=await inspectExternalCloudflareIngress(file,address.port);
  assert.equal(unstable.status,'BLOCKED');
  assert.match(unstable.reason,/stable/);
});
