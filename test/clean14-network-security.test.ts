import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {once} from 'node:events';
import {normalizeControlPlaneBase,resolveControlPlaneAddress} from '../src/hub/control-plane-network-policy.js';
import {ControlPlaneMcpClient,ControlPlaneMcpVerifierUnavailableError} from '../src/hub/control-plane-mcp-auth.js';
import {createControlPlaneAgentCredentialVerifier,createControlPlaneAgentPresenceReporter} from '../src/hub/control-plane-agent-auth.js';

const secret='disposable-service-token-0123456789';
const mcp='Bearer nwx_mcp_disposable-access-token';
const agent='Bearer nwx_dev_disposable-device-token';

test('CLEAN-14 P1-C: normalized nonpublic, mapped, metadata and alternate IP forms are denied',()=>{
  const rejected=[
    'http://control.example.test','https://127.0.0.1','https://[::1]',
    'https://[::ffff:127.0.0.1]','https://[::ffff:169.254.169.254]',
    'https://10.5.0.1','https://172.31.255.254','https://192.168.0.1',
    'https://169.254.169.254','https://0','https://127.1',
    'https://0177.0.0.1','https://0x7f000001','https://2130706433',
    'https://100.64.1.2','https://198.18.0.1','https://224.0.0.1',
    'https://[::]','https://[fc00::1]','https://[fe80::1]',
    'https://[2001:db8::1]','https://[2002:c0a8:0101::1]',
    'https://metadata.google.internal','https://metadata.azure.internal',
    'https://user:pass@control.example.test',
    'https://control.example.test/?redirect=https://evil.example.test',
    'https://control.example.test/#token',
    'https://control.example.test.','https://control.example.test:8443',
    'https://control.example.test/%2e%2e/admin',
  ];
  for(const url of rejected)
    assert.throws(()=>normalizeControlPlaneBase(url),url);
  assert.equal(normalizeControlPlaneBase('https://CONTROL.Example.Test/'),
    'https://control.example.test');
  assert.equal(normalizeControlPlaneBase('http://127.0.0.1:4321/'),
    'http://127.0.0.1:4321');
});

test('CLEAN-14 P1-C: all A/AAAA candidates must be approved (one private poisons result)',async()=>{
  for(const addresses of [
    [{address:'8.8.8.8',family:4 as const},{address:'127.0.0.1',family:4 as const}],
    [{address:'2606:4700:4700::1111',family:6 as const},{address:'fc00::1',family:6 as const}],
    [{address:'::ffff:127.0.0.1',family:6 as const}],
    [{address:'169.254.169.254',family:4 as const}],
  ]){
    await assert.rejects(resolveControlPlaneAddress('control.example.test',
      async()=>addresses),/CONTROL_PLANE_DNS_UNSAFE/);
  }
  await assert.rejects(resolveControlPlaneAddress('control.example.test',
    async()=>[]),/CONTROL_PLANE_DNS_EMPTY/);
});

test('CLEAN-14 P1-C: resolution is one-shot and pins a checked address, not a later private answer',async()=>{
  let answers=0;
  const selected=await resolveControlPlaneAddress('control.example.test',async()=>{
    answers++;
    return answers===1?[{address:'8.8.8.8',family:4}]:[{address:'127.0.0.1',family:4}];
  });
  assert.equal(answers,1);
  assert.deepEqual(selected,{address:'8.8.8.8',family:4});
  // The real native transport consumes precisely this address in https.request.lookup.
});

test('CLEAN-14 P1-C: injected fetch sees redirect error on all four secret-bearing POSTs',async()=>{
  const endpoints:string[]=[];
  const mock:typeof fetch=async(input,init)=>{
    endpoints.push(String(input));
    assert.equal(init?.method,'POST');
    assert.equal(init?.redirect,'error');
    assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+secret);
    return Response.redirect('http://127.0.0.1:45678/collect',307);
  };
  const mc=new ControlPlaneMcpClient({controlPlaneUrl:'https://control.example.test',
    serviceToken:secret,fetchImpl:mock});
  await assert.rejects(mc.authenticate(mcp),ControlPlaneMcpVerifierUnavailableError);
  assert.equal(await mc.chargeTool({accountId:'test',eventId:'test',toolName:'test'}),undefined);
  const verify=createControlPlaneAgentCredentialVerifier({controlPlaneUrl:'https://control.example.test',
    serviceToken:secret,fetchImpl:mock});
  const presence=createControlPlaneAgentPresenceReporter({controlPlaneUrl:'https://control.example.test',
    serviceToken:secret,fetchImpl:mock});
  assert.equal(await verify(agent),undefined);
  assert.equal(await presence({deviceId:'disposable',online:false,at:'2026-11-04T00:00:00Z'}),false);
  assert.deepEqual(endpoints.map(v=>new URL(v).pathname),[
    '/api/v1/internal/mcp/authenticate','/api/v1/internal/usage/charge',
    '/api/v1/internal/device/authenticate','/api/v1/internal/device/presence',
  ]);
});

async function listen(server:Server):Promise<number>{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const value=server.address();
  assert.ok(value&&typeof value!=='string');
  return value.port;
}
async function close(server:Server):Promise<void>{
  await new Promise<void>(resolve=>server.close(()=>resolve()));
}
test('CLEAN-14 P1-C: real TCP/HTTP 307 never forwards MCP or Agent secrets to redirect target',async t=>{
  let targetCalls=0;
  const target=createServer((req,res)=>{targetCalls++;req.resume();res.writeHead(200).end('stolen');});
  const targetPort=await listen(target);
  t.after(()=>close(target));
  let sourceCalls=0;
  let sourceSawSecrets=0;
  const source=createServer((req,res)=>{
    sourceCalls++;
    if(req.headers.authorization==='Bearer '+secret)sourceSawSecrets++;
    req.resume();
    res.writeHead(307,{location:`http://127.0.0.1:${targetPort}/collector`});
    res.end();
  });
  const sourcePort=await listen(source);
  t.after(()=>close(source));
  const url=`http://127.0.0.1:${sourcePort}`;
  const mc=new ControlPlaneMcpClient({controlPlaneUrl:url,serviceToken:secret});
  await assert.rejects(mc.authenticate(mcp),ControlPlaneMcpVerifierUnavailableError);
  assert.equal(await mc.chargeTool({accountId:'disposable',eventId:'id',toolName:'tool'}),undefined);
  const verify=createControlPlaneAgentCredentialVerifier({controlPlaneUrl:url,serviceToken:secret});
  const presence=createControlPlaneAgentPresenceReporter({controlPlaneUrl:url,serviceToken:secret});
  assert.equal(await verify(agent),undefined);
  assert.equal(await presence({deviceId:'disposable',online:false,at:'2026-11-04T00:00:00Z'}),false);
  assert.equal(sourceCalls,4);
  assert.equal(sourceSawSecrets,4);
  assert.equal(targetCalls,0,'redirect receiver must never see service or device credentials');
});
