import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneMcpClient } from '../src/hub/control-plane-mcp-auth.js';
import { resolveMcpAuthorization } from '../src/security/auth.js';
import { enforceHostedMcpMetering } from '../src/mcp/hosted-metering.js';
import {
  estimateScaleWorkerDemand, maxActiveUsersUnderBudget,
  type ScaleWorkerDemand,
} from '../src/ops/scale-worker-capacity-model.js';

const basic:ScaleWorkerDemand={
  activeUsers:50,hostedToolCallsPerUserPerDay:1000,
  authWorkerRequestsPerTool:1,chargeWorkerRequestsPerTool:1,
  otherWorkerRequestsPerUserPerDay:0,fixedWorkerRequestsPerDay:0,
  retryPermille:0,workerRequestBudgetPerDay:100_000,
};

test('real client call path produces one auth POST plus one quota POST per hosted tool invocation',async()=>{
  const routes:string[]=[];
  let chargeStatus:'charged'|'duplicate'='charged';
  const client=new ControlPlaneMcpClient({
    controlPlaneUrl:'https://control.example.test',
    serviceToken:'service-token-0123456789',
    fetchImpl:async(input)=>{
      const path=new URL(String(input)).pathname;
      routes.push(path);
      if(path==='/api/v1/internal/mcp/authenticate') {
        return Response.json({
          authenticated:true,
          scopes:['mcp'],
          accountId:'case-test',
          role:'user',
          allowedDeviceIds:['device-a'],
        });
      }
      assert.equal(path,'/api/v1/internal/usage/charge');
      return Response.json({
        status:chargeStatus,chargedCredits:1,
        remainingCredits:900,reason:null,
      });
    },
  });
  const header='Bearer nwx_mcp_unit-test-token';
  const auth=await resolveMcpAuthorization(
    header,[],undefined,undefined,h=>client.authenticate(h),
  );
  assert.equal(auth?.kind,'control-plane');
  const body={
    jsonrpc:'2.0',id:1,method:'tools/call',
    params:{
      name:'machine_health',arguments:{},
      _meta:{'nexowire/invocation-id':'fixed-id-12345678'},
    },
  };
  const decision=await enforceHostedMcpMetering({
    authorization:auth,authorizationHeader:header,
    body,client,
  });
  assert.deepEqual(decision,{allowed:true});
  assert.deepEqual(routes,[
    '/api/v1/internal/mcp/authenticate',
    '/api/v1/internal/usage/charge',
  ]);

  chargeStatus='duplicate';
  const secondAuth=await resolveMcpAuthorization(
    header,[],undefined,undefined,h=>client.authenticate(h),
  );
  const repeated=await enforceHostedMcpMetering({
    authorization:secondAuth,authorizationHeader:header,
    body,client,
  });
  assert.equal(repeated.allowed,false);
  assert.equal(repeated.code,'MCP_DUPLICATE_REQUEST');
  assert.deepEqual(routes.slice(2),routes.slice(0,2));
});

test('planning budget: 50 active Free accounts at 1000 calls/day use entire hypothetical 100k Worker requests',()=>{
  const result=estimateScaleWorkerDemand(basic);
  assert.equal(result.hostedToolInvocations,50_000);
  assert.equal(result.authRequests,50_000);
  assert.equal(result.chargeRequests,50_000);
  assert.equal(result.estimatedWorkerRequests,100_000);
  assert.equal(result.remainingWorkerRequests,0);
  assert.equal(result.withinBudget,true);
  const over=estimateScaleWorkerDemand({...basic,activeUsers:51});
  assert.equal(over.estimatedWorkerRequests,102_000);
  assert.equal(over.withinBudget,false);
  assert.equal(maxActiveUsersUnderBudget(basic),50);
});

test('signaling and retry overhead reduce theoretical account capacity, no P2P ingress discount',()=>{
  const demand=estimateScaleWorkerDemand({
    ...basic,activeUsers:40,
    otherWorkerRequestsPerUserPerDay:100,
    fixedWorkerRequestsPerDay:1000,
    retryPermille:100,
  });
  // (40 * (1000 * 2 + 100) + 1000) * 1.1
  assert.equal(demand.estimatedWorkerRequests,93_500);
  assert.equal(demand.retryRequests,8_500);
  assert.equal(maxActiveUsersUnderBudget({
    ...basic,otherWorkerRequestsPerUserPerDay:100,
    fixedWorkerRequestsPerDay:1000,
    retryPermille:100,
  }),42);
});

test('estimate fails on negative, fractional, overflow and impossible retry assumptions',()=>{
  for(const patch of [
    {activeUsers:-1},{activeUsers:1.2},{workerRequestBudgetPerDay:-1},
    {retryPermille:1001},{hostedToolCallsPerUserPerDay:Number.MAX_SAFE_INTEGER},
  ]) {
    assert.throws(()=>estimateScaleWorkerDemand({...basic,...patch}));
  }
  assert.equal(maxActiveUsersUnderBudget({
    ...basic,fixedWorkerRequestsPerDay:100001,
  }),0);
  assert.equal(maxActiveUsersUnderBudget({
    ...basic,hostedToolCallsPerUserPerDay:0,
    authWorkerRequestsPerTool:0,chargeWorkerRequestsPerTool:0,
    otherWorkerRequestsPerUserPerDay:0,fixedWorkerRequestsPerDay:1000,
  }),Number.MAX_SAFE_INTEGER);
});
