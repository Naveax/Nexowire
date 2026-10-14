import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryControlPlaneStore} from '../src/product/memory-control-plane-store.js';
import {ControlPlaneService} from '../src/product/control-plane-service.js';
import {createFusedMcpAuthorizeChargeHandler} from '../src/product/fused-mcp-authorize-charge.js';
import {FusedMcpAuthorizeChargeClient} from '../src/hub/fused-mcp-authorize-charge-client.js';

const accessToken='nwx_mcp_first-party-local-test-token';
const serviceToken='service-local-test-token-0123456789';
const accountId='fused-owned-account';

async function fixture() {
  const store=new MemoryControlPlaneStore();
  const service=new ControlPlaneService(store,{
    now:()=>new Date('2026-10-15T15:00:00.000Z'),
  });
  await service.ensureAccount({id:accountId});
  let workerCalls=0;
  let oauthVerifications=0;
  let revoked=false;
  const server=createFusedMcpAuthorizeChargeHandler({
    authenticateService:async request=>
      request.headers.get('authorization')==='Bearer '+serviceToken,
    authenticateAccessToken:async access=>{
      oauthVerifications++;
      return !revoked && access===accessToken
        ?{accountId,scopes:['mcp']}:null;
    },
    store,
    chargeUsage:args=>service.chargeUsage(args),
  });
  const client=new FusedMcpAuthorizeChargeClient({
    controlPlaneUrl:'https://control.example.test',
    serviceToken,
    timeoutMs:2000,
    fetchImpl:async(url,init)=>{
      workerCalls++;
      return server(new Request(String(url),init));
    },
  });
  return {
    service,client,
    get workerCalls(){return workerCalls},
    get oauthVerifications(){return oauthVerifications},
    revoke(){revoked=true},
  };
}
function invocation(id:string,toolName='machine_health') {
  return {accessToken,invocationId:id,toolName};
}

test('S1 first-party client/server: exactly one Worker POST per accepted hosted invocation',async()=>{
  const f=await fixture();
  const result=await f.client.authorizeAndCharge(invocation('single-client-server-0001'));
  assert.equal(result.kind,'authorized',JSON.stringify(result));
  if(result.kind!=='authorized')return;
  assert.equal(result.authorization.accountId,accountId);
  assert.equal(result.authorization.role,'user');
  assert.equal(result.remainingCredits,999);
  assert.equal(f.workerCalls,1);
  assert.equal(f.oauthVerifications,1);
  const dashboard=await f.service.dashboard({accountId,role:'user'});
  assert.equal(dashboard.usage.usedCredits,1);
  assert.equal(JSON.stringify(result).includes(accessToken),false);
});

test('S1 integrated duplicate ID cannot execute twice, even under concurrent replay',async()=>{
  const f=await fixture();
  const tasks=Array.from({length:12},()=>f.client.authorizeAndCharge(invocation('parallel-client-0002')));
  const decisions=await Promise.all(tasks);
  assert.equal(decisions.filter(x=>x.kind==='authorized').length,1);
  assert.equal(decisions.filter(x=>x.kind==='rejected'&&x.httpStatus===409).length,11);
  assert.equal(f.workerCalls,12);
  assert.equal(f.oauthVerifications,12);
  assert.equal((await f.service.dashboard({accountId,role:'user'})).usage.usedCredits,1);
});

test('S1 integrated token revocation and role-denied tool have no unmetered fallback',async()=>{
  const f=await fixture();
  const allowed=await f.client.authorizeAndCharge(invocation('before-revoke-0003'));
  assert.equal(allowed.kind,'authorized');
  f.revoke();
  const denied=await f.client.authorizeAndCharge(invocation('after-revoke-0004'));
  assert.equal(denied.kind,'rejected');
  if(denied.kind==='rejected')assert.equal(denied.httpStatus,401);
  assert.equal(f.workerCalls,2);
  assert.equal((await f.service.dashboard({accountId,role:'user'})).usage.usedCredits,1);
  const roleFixture=await fixture();
  const admin=await roleFixture.client.authorizeAndCharge(
    invocation('admin-role-denied-0005','policy_profile_set'),
  );
  assert.equal(admin.kind,'rejected');
  if(admin.kind==='rejected')assert.equal(admin.httpStatus,403);
  assert.equal((await roleFixture.service.dashboard({accountId,role:'user'})).usage.usedCredits,0);
});

test('S1 integrated Free monthly quota exhausted fails closed with one fetch',async()=>{
  const f=await fixture();
  await f.service.chargeUsage({
    accountId,eventId:'prefill-budget-0006',
    toolName:'machine_health',baseCredits:1000,
  });
  const denied=await f.client.authorizeAndCharge(invocation('after-budget-0007'));
  assert.equal(denied.kind,'rejected');
  if(denied.kind==='rejected')assert.equal(denied.httpStatus,429);
  assert.equal(f.workerCalls,1);
  assert.equal((await f.service.dashboard({accountId,role:'user'})).usage.usedCredits,1000);
});
