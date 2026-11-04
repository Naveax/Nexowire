import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {once} from 'node:events';
import {normalizeControlPlaneBase,resolveControlPlaneAddress,controlPlaneSecretPost} from '../src/hub/control-plane-network-policy.js';
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
test('CLEAN-14 P1-C: real TCP/HTTP 301, 302, 307, 308 never forward credentials',async t=>{
  for(const status of [301,302,307,308] as const){
    await t.test('HTTP '+status+' with all four secret POST endpoints',async scenario=>{
      let targetCalls=0;
      const target=createServer((req,res)=>{
        targetCalls++;req.resume();res.writeHead(200).end('stolen');
      });
      const targetPort=await listen(target);
      scenario.after(()=>close(target));
      let sourceCalls=0;
      let sourceSawSecrets=0;
      const source=createServer((req,res)=>{
        sourceCalls++;
        if(req.headers.authorization==='Bearer '+secret)sourceSawSecrets++;
        req.resume();
        res.writeHead(status,{location:`http://127.0.0.1:${targetPort}/collector`});
        res.end();
      });
      const sourcePort=await listen(source);
      scenario.after(()=>close(source));
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
      assert.equal(targetCalls,0,'redirect receiver must never see either service or device credentials');
    });
  }
});

test('CLEAN-14 P1-C: full request URL validation rejects credentials, query and fragments before DNS',async()=>{
  for(const target of [
    'http://user:pass@localhost:54321/collect',
    'http://localhost:54321/collect?destination=127.0.0.1',
    'http://localhost:54321/collect#secret',
    'http://localhost:54321/%2e%2e/collect',
  ]){
    await assert.rejects(controlPlaneSecretPost(target,{
      method:'POST',redirect:'error',body:'{}',headers:{authorization:'Bearer '+secret},
    }),/CONTROL_PLANE_URL_INVALID/,target);
  }
});

test('CLEAN-14 P1-C: Unicode, punycode and encoded authority disguises fail closed',()=>{
  for(const target of [
    'https://ｅxample.test','https://ᴄontrol.example.test',
    'https://xn--e1afmkfd.test','https://%63ontrol.example.test',
    'https://control..example.test','https://control.example.test..',
  ])assert.throws(()=>normalizeControlPlaneBase(target),/CONTROL_PLANE_URL_INVALID/,target);
});

test('CLEAN-14 P1-C: rebinding to nonpublic CNAME final A/AAAA denies before socket creation',async()=>{
  let calls=0;
  for(const address of ['127.0.0.1','169.254.169.254','10.0.0.8','192.168.1.10']){
    await assert.rejects(controlPlaneSecretPost('https://control.example.test/api/v1/internal/mcp/authenticate',{
      method:'POST',redirect:'error',body:'{}',headers:{authorization:'Bearer '+secret},
    },undefined,async()=>{
      calls++;
      return [{address,family:4 as const}];
    }),/CONTROL_PLANE_DNS_UNSAFE/);
  }
  assert.equal(calls,4);
});

test('CLEAN-14 P1-C: revoked credential and ambiguous device identities do not authenticate',async()=>{
  let result:Record<string,unknown>={authenticated:true,device:{deviceId:'expected-device-id'}};
  const verify=createControlPlaneAgentCredentialVerifier({
    controlPlaneUrl:'https://control.example.test',serviceToken:secret,
    fetchImpl:async()=>Response.json(result),
  });
  assert.deepEqual(await verify(agent),{deviceId:'expected-device-id'});
  for(const id of [' expected-device-id','expected-device-id ','bad\\nidentifier','bad\\u0000identifier']){
    result={authenticated:true,device:{deviceId:id.replace('\\n','\n').replace('\\u0000','\u0000')}};
    assert.equal(await verify(agent),undefined,'invalid identity must be refused');
  }
  result={authenticated:false,device:{deviceId:'expected-device-id'}};
  assert.equal(await verify(agent),undefined,'revoked or expired authority must deny on fresh verification');
  assert.equal(await verify('Bearer shared-legacy-token'),undefined,'shared token is not a device credential');
});

test('CLEAN-14 P1-C: real TCP lookup pins the first checked DNS answer despite later rebinding',async t=>{
  let trustedRequests=0,redirectedRequests=0,dnsCalls=0;
  const trusted=createServer((req,res)=>{
    trustedRequests++;
    assert.equal(req.headers.authorization,'Bearer '+secret);
    req.resume();
    res.writeHead(200,{'content-type':'application/json'});res.end('{}');
  });
  const port=await listen(trusted);
  t.after(()=>close(trusted));
  // Same port, different address family; this represents the attacker-selected
  // second DNS answer. Both listeners are disposable and loopback-only.
  const alternate=createServer((req,res)=>{
    redirectedRequests++;req.resume();res.writeHead(200).end('{}');
  });
  alternate.listen({host:'::1',port,ipv6Only:true});
  await once(alternate,'listening');
  t.after(()=>close(alternate));
  const response=await controlPlaneSecretPost('http://localhost:'+port+'/one-use',{
    method:'POST',redirect:'error',
    headers:{authorization:'Bearer '+secret,'content-type':'application/json'},
    body:'{}',
  },undefined,async()=>{
    dnsCalls++;
    return dnsCalls===1
      ? [{address:'127.0.0.1',family:4}]
      : [{address:'::1',family:6}];
  });
  assert.equal(response.status,200);
  assert.equal(dnsCalls,1,'socket lookup must not perform a second DNS resolution');
  assert.equal(trustedRequests,1);
  assert.equal(redirectedRequests,0,'rebound second endpoint receives no credential');
});
