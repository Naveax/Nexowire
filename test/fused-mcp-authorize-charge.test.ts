import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryControlPlaneStore } from '../src/product/memory-control-plane-store.js';
import { ControlPlaneService } from '../src/product/control-plane-service.js';
import {
  createFusedMcpAuthorizeChargeHandler,
  type FusedMcpChargeDependencies,
} from '../src/product/fused-mcp-authorize-charge.js';
import { hostedMcpUsageEventId } from '../src/mcp/hosted-metering.js';

const ACCESS='nwx_mcp_example-access-token-that-is-long-enough';
function request(invocationId='s1-invocation-0001', toolName='machine_health',
  extra:Record<string,unknown>={}): Request {
  return new Request('https://control.example.test/api/v1/internal/mcp/authorize-charge',{
    method:'POST',
    headers:{
      'content-type':'application/json',
      authorization:'Bearer s1-service-test-token-0123456789',
    },
    body:JSON.stringify({accessToken:ACCESS,invocationId,toolName,...extra}),
  });
}
async function fixture() {
  const store=new MemoryControlPlaneStore();
  const service=new ControlPlaneService(store,{
    now:()=>new Date('2026-10-15T14:00:00.000Z'),
  });
  await service.ensureAccount({id:'s1-owner'});
  await service.ensureAccount({id:'s1-victim'});
  let verifyCount=0;
  let chargeCount=0;
  let revoked=false;
  let injectedError=false;
  const dependencies:FusedMcpChargeDependencies={
    authenticateService:async req=>
      req.headers.get('authorization')==='Bearer s1-service-test-token-0123456789',
    authenticateAccessToken:async token=>{
      verifyCount++;
      if(injectedError) throw new Error('PRIVATE_OAUTH_FAILURE');
      return !revoked && token===ACCESS
        ?{accountId:'s1-owner',scopes:['mcp']} : null;
    },
    store,
    chargeUsage:async input=>{
      chargeCount++;
      return service.chargeUsage(input);
    },
  };
  return {
    store,service,dependencies,
    handler:createFusedMcpAuthorizeChargeHandler(dependencies),
    get verifyCount(){return verifyCount},
    get chargeCount(){return chargeCount},
    revoke(){revoked=true},
    failOAuth(){injectedError=true},
  };
}

test('single handler call verifies OAuth and makes one server-side atomic reservation',async()=>{
  const f=await fixture();
  const r=await f.handler(request('accepted-call-0001','machine_health',{
    accountId:'s1-victim',quotaSubjectId:'s1-victim',plan:'pro',
  }));
  assert.equal(r.status,200);
  const body=await r.json() as {authenticated:boolean;authorization:{accountId:string;role:string};charge:{status:string;remainingCredits:number}};
  assert.equal(body.authenticated,true);
  assert.equal(body.authorization.accountId,'s1-owner');
  assert.equal(body.authorization.role,'user');
  assert.equal(body.charge.status,'charged');
  assert.equal(body.charge.remainingCredits,999);
  assert.equal(f.verifyCount,1);
  assert.equal(f.chargeCount,1);
  const victim=await f.service.dashboard({accountId:'s1-victim',role:'user'});
  assert.equal(victim.usage.usedCredits,0);
  assert.equal(JSON.stringify(body).includes(ACCESS),false);
});

test('repeated invocation ID is denied, not double-charged or re-executable',async()=>{
  const f=await fixture();
  assert.equal((await f.handler(request('same-call-0002'))).status,200);
  const repeat=await f.handler(request('same-call-0002'));
  assert.equal(repeat.status,409);
  assert.equal(((await repeat.json()) as {error:string}).error,'MCP_DUPLICATE_REQUEST');
  assert.equal(f.verifyCount,2);
  assert.equal(f.chargeCount,2);
  const dashboard=await f.service.dashboard({accountId:'s1-owner',role:'user'});
  assert.equal(dashboard.usage.usedCredits,1);
});

test('revoked OAuth token fails before reservation, even for a previously valid call',async()=>{
  const f=await fixture();
  assert.equal((await f.handler(request('revoke-00000001'))).status,200);
  f.revoke();
  assert.equal((await f.handler(request('revoke-00000002'))).status,401);
  assert.equal(f.chargeCount,1);
});

test('role-based admin tool is forbidden BEFORE usage charge',async()=>{
  const f=await fixture();
  const result=await f.handler(request('admin-call-001','policy_profile_set'));
  assert.equal(result.status,403);
  assert.equal(((await result.json()) as {error:string}).error,'MCP_TOOL_NOT_AUTHORIZED');
  assert.equal(f.chargeCount,0);
});

test('Free premium feature and exhausted budget deny execution and preserve existing codes',async()=>{
  const f=await fixture();
  const premium=await f.handler(request('premium-call-001','windows_private_desktop_start'));
  assert.equal(premium.status,403);
  assert.equal(((await premium.json()) as {error:string}).error,'MCP_FEATURE_NOT_IN_PLAN');
  await f.service.chargeUsage({
    accountId:'s1-owner',eventId:'prefilled-1000',
    toolName:'machine_health',baseCredits:1000,
  });
  const quota=await f.handler(request('quota-call-001'));
  assert.equal(quota.status,429);
  assert.equal(((await quota.json()) as {error:string}).error,'MCP_QUOTA_EXHAUSTED');
});

test('invalid service bearer, token, request ID, tool and payload cannot reserve credits',async()=>{
  const f=await fixture();
  const unauth=request('service-failure-001');
  unauth.headers.set('authorization','Bearer wrong');
  assert.equal((await f.handler(unauth)).status,403);
  assert.equal((await f.handler(request('short'))).status,400);
  assert.equal((await f.handler(request('valid-tool-001','policy_profile_set; DROP TABLE x'))).status,400);
  assert.equal((await f.handler(request('valid-tool-002','machine_health',{specialSkill:'true'}))).status,400);
  assert.equal((await f.handler(request('valid-tool-003','machine_health',{accessToken:'invalid'}))).status,400);
  assert.equal(f.chargeCount,0);
  assert.equal(f.verifyCount,0);
});

test('OAuth errors fail closed, without exposing private provider error or charging',async()=>{
  const f=await fixture();
  f.failOAuth();
  const response=await f.handler(request('provider-error-01'));
  assert.equal(response.status,503);
  const text=await response.text();
  assert.equal(text.includes('PRIVATE_OAUTH_FAILURE'),false);
  assert.equal(f.chargeCount,0);
});

test('concurrent identical invocation IDs consume at most one Free credit',async()=>{
  const f=await fixture();
  const responses=await Promise.all(Array.from({length:12},()=>
    f.handler(request('concurrent-id-001'))));
  assert.equal(responses.filter(r=>r.status===200).length,1);
  assert.equal(responses.filter(r=>r.status===409).length,11);
  const dashboard=await f.service.dashboard({accountId:'s1-owner',role:'user'});
  assert.equal(dashboard.usage.usedCredits,1);
});

test('fused and legacy charge share exact idempotency event namespace',async()=>{
  const f=await fixture();
  const original=await f.service.chargeUsage({
    accountId:'s1-owner',
    eventId:hostedMcpUsageEventId({accountId:'s1-owner',invocationId:'legacy-shared-0001'}),
    toolName:'machine_health',
  });
  assert.equal(original.status,'charged');
  const next=await f.handler(request('legacy-shared-0001'));
  assert.equal(next.status,409);
});
