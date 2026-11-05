import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentBroker} from '../src/core/agent-broker.js';
import {loadConfig} from '../src/config.js';
import type {NexowireConfig} from '../src/config.js';
import type {McpContext} from '../src/mcp/create-server.js';
import {
  assertRemoteAgentAuthorizationContract,
  hasTrustedRemoteAgentGrant,
  hubRuntimeIdentity,
  REMOTE_AGENT_STRICT_CONTRACT,
  runHttpServer,
  bindRemoteAgentMutationReauthorization,
  type RemoteAgentAuthorityEvidence,
} from '../src/mcp/http.js';
import {verifyLocalFirstPublicUpstream} from '../src/mcp/local-first-ingress.js';

test('V2-03 remote-only Hub with legacy broker refuses startup before HTTP 101 or agent registration',async()=>{
  const broker=new AgentBroker();
  assert.doesNotThrow(()=>assertRemoteAgentAuthorizationContract(broker,false),
    'local-only session behavior must be unchanged');
  assert.throws(()=>assertRemoteAgentAuthorizationContract(broker,true),
    /REMOTE_AGENT_STRICT_REAUTHORIZATION_REQUIRED/);
  const config={remoteAgentAuthOnly:true} as NexowireConfig;
  // The guard must run BEFORE config access, network, WebSocket registration
  // and any attempt to call broker.request. Missing strict proof is NOT a
  // successful zero-frame strict-Broker acceptance; it is blocked admission.
  await assert.rejects(runHttpServer(config,broker,{} as McpContext),
    /REMOTE_AGENT_STRICT_REAUTHORIZATION_REQUIRED/);
  assert.deepEqual(broker.list(),[]);
});

test('V2-03 strict contract is an explicit broker capability; optional callback is never enough',()=>{
  const disabled={isMandatoryMutationReauthorizationEnabled:()=>false} as unknown as AgentBroker;
  assert.throws(()=>assertRemoteAgentAuthorizationContract(disabled,true),
    /REMOTE_AGENT_STRICT_REAUTHORIZATION_REQUIRED/);
  const strictAttestation={isMandatoryMutationReauthorizationEnabled:()=>true} as unknown as AgentBroker;
  assert.doesNotThrow(()=>assertRemoteAgentAuthorizationContract(strictAttestation,true));
  // The stub proves only the startup guard contract, NOT a real secure Broker.
});

test('V2-03 authority grant requires owner+device+epoch+finite short lease; deviceId-only is rejected',()=>{
  const now=1_700_000_000_000;
  const healthy={ownerId:'owner-123',deviceId:'device-123',
    authorizationEpoch:41,leaseExpiresAtMs:now+15_000};
  assert.equal(hasTrustedRemoteAgentGrant(healthy,now),true);
  for(const invalid of [
    {deviceId:'device-123'},
    {...healthy,ownerId:''},
    {...healthy,deviceId:'other device'},
    {...healthy,authorizationEpoch:-1},
    {...healthy,authorizationEpoch:41.3},
    {...healthy,authorizationEpoch:undefined},
    {...healthy,leaseExpiresAtMs:now},
    {...healthy,leaseExpiresAtMs:now-1},
    {...healthy,leaseExpiresAtMs:now+300_001},
    {...healthy,leaseExpiresAtMs:NaN},
    {...healthy,leaseExpiresAtMs:Infinity},
    null,
  ])assert.equal(hasTrustedRemoteAgentGrant(invalid,now),false);
  assert.equal(hasTrustedRemoteAgentGrant(healthy,now+15_000),false,
    'short-lived grant must expire without relying on the 60s periodic socket recheck');
});

test('V2-03 public Agent ingress rejects legacy periodic-only health contract',async()=>{
  const resource='https://mcp.example.test/mcp';
  const metadata={resource,authorization_servers:['https://issuer.example.test']};
  const run=(contract:string|undefined)=>
    verifyLocalFirstPublicUpstream({hubPort:43110,expectedResourceUrl:resource,
      requireRemoteAgentAdmission:true,
      fetchImpl:async(url)=>{
        if(String(url).endsWith('/health'))
          return Response.json({ok:true,service:'nexowire',
            runtime:{ownerOauthConfigured:true,remoteAgentAdmissionContract:contract}});
        return Response.json(metadata);
      }});
  await assert.rejects(run(undefined),/remote-only device-bound revalidation/);
  await assert.rejects(run('device-bound-revalidate-v1'),/remote-only device-bound revalidation/);
  await assert.doesNotReject(run(REMOTE_AGENT_STRICT_CONTRACT),
    'the coordinator can expose Agent only after a trusted Hub advertises strict admission');
  assert.equal(hubRuntimeIdentity(true,true).remoteAgentAdmissionContract,
    REMOTE_AGENT_STRICT_CONTRACT);
});

test('V2-03 remote auth config is independent of local static tokens',()=>{
  const config=loadConfig({
    NEXOWIRE_AGENT_REMOTE_AUTH_ONLY:'true',
    NEXOWIRE_CONTROL_PLANE_URL:'https://control.example.test',
    NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN:'disposable-only-service-token',
    NEXOWIRE_MCP_RESOURCE_URL:'https://mcp.example.test/mcp',
  });
  assert.equal(config.remoteAgentAuthOnly,true);
  assert.throws(()=>assertRemoteAgentAuthorizationContract(new AgentBroker(),true),
    /REMOTE_AGENT_STRICT_REAUTHORIZATION_REQUIRED/);
});


test('V2-03 socket-bound callback admits only fresh identical owner+device+authority epoch',async()=>{
  let now=1_700_000_000_000;
  let proof={ownerId:'owner-a',deviceId:'device-a',authorizationEpoch:4,
    leaseExpiresAtMs:now+2_000};
  const verifier=async()=>proof;
  const check=bindRemoteAgentMutationReauthorization({
    grant:proof,authorizationHeader:'Bearer disposable',verify:verifier,clock:()=>now,
  });
  assert.equal(await check(),true);
  now+=1999;
  assert.equal(await check(),true);
  now++;
  assert.equal(await check(),false,'initial socket grant expires even if the verifier might later refresh it');
});

for(const [name,mutation] of [
  ['wrong-device',(p:RemoteAgentAuthorityEvidence)=>({...p,deviceId:'other-device'})],
  ['wrong-owner',(p:RemoteAgentAuthorityEvidence)=>({...p,ownerId:'other-owner'})],
  ['stale-epoch',(p:RemoteAgentAuthorityEvidence)=>({...p,authorizationEpoch:p.authorizationEpoch+1})],
  ['expired-grant',(p:RemoteAgentAuthorityEvidence)=>({...p,leaseExpiresAtMs:p.leaseExpiresAtMs-120_000})],
] as const){
  test('V2-03 bound verifier denies '+name+' with zero gated mutation frames',async()=>{
    const now=Date.now();
    const grant={ownerId:'owner-a',deviceId:'device-a',authorizationEpoch:5,
      leaseExpiresAtMs:now+60_000};
    const check=bindRemoteAgentMutationReauthorization({
      grant,authorizationHeader:'Bearer disposable',
      verify:async()=>mutation(grant),clock:()=>now,
    });
    const frames:string[]=[];
    if(await check())frames.push('files.write');
    assert.deepEqual(frames,[],'helper-denied mutation must not invoke downstream send');
    assert.equal(await check(),false,'revoked/mismatched socket is terminal until new handshake');
  });
}

test('V2-03 revoked owner and unavailable callback fail closed without tool frame',async()=>{
  const now=Date.now();
  const grant={ownerId:'owner-a',deviceId:'device-a',authorizationEpoch:5,
    leaseExpiresAtMs:now+60_000};
  for(const verifier of [
    async()=>undefined,
    async()=>{throw Error('authority unavailable');},
  ]){
    const check=bindRemoteAgentMutationReauthorization({
      grant,authorizationHeader:'Bearer disposable',verify:verifier,clock:()=>now,
    });
    assert.equal(await check(),false);
  }
  assert.throws(()=>bindRemoteAgentMutationReauthorization({
    grant,authorizationHeader:undefined,verify:undefined as never,
  }),/REMOTE_REAUTH_VERIFIER_REQUIRED/);
});

test('V2-03 bound verifier times out unresponsive authority and never retries automatically',async()=>{
  const now=Date.now();
  const grant={ownerId:'owner-a',deviceId:'device-a',authorizationEpoch:9,
    leaseExpiresAtMs:now+60_000};
  let calls=0;
  let lateRelease!:(value:unknown)=>void;
  const check=bindRemoteAgentMutationReauthorization({
    grant,authorizationHeader:'Bearer disposable',
    verify:async()=>{calls++;return await new Promise(resolve=>{lateRelease=resolve;});},
    timeoutMs:250,
  });
  const result=await check();
  assert.equal(result,false);
  lateRelease(grant);
  assert.equal(await check(),false);
  assert.equal(calls,1,'late verifier resolution may not resurrect revoked socket or send mutation');
});
