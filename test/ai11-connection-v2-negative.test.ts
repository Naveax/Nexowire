import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {loadConfig} from '../src/config.js';
import {cloudflareConnectionConfig} from '../src/mcp/local-first-cloudflare.js';
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
