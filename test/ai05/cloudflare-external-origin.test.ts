import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConfig} from '../../src/config.js';
import {externalCloudflareIngressPlan} from '../../src/mcp/cloudflare-external-origin.js';

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
