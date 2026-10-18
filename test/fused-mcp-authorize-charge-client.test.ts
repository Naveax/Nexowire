import test from 'node:test';
import assert from 'node:assert/strict';
import {FusedMcpAuthorizeChargeClient} from '../src/hub/fused-mcp-authorize-charge-client.js';

const ACCESS='nwx_mcp_example-access-token-that-is-long-enough';
const INPUT={accessToken:ACCESS,invocationId:'fused-test-id-0001',toolName:'machine_health'};
function payload() {
  return {
    authenticated:true,
    authorization:{
      accountId:'owner-1',role:'user',
      allowedDeviceIds:['device-a'],
      deviceAccessModes:{'device-a':'safe'},
      autoSelectDevices:false,
      ownerDevices:[{id:'device-a',name:'Work PC',folderId:null}],
      ownerFolders:[],
    },
    charge:{status:'charged',chargedCredits:1,remainingCredits:999,reason:null},
  };
}
function client(fetchImpl:typeof fetch) {
  return new FusedMcpAuthorizeChargeClient({
    controlPlaneUrl:'https://control.example.test',
    serviceToken:'service-test-token-0123456789',
    fetchImpl,timeoutMs:1000,
  });
}

test('one fused client HTTP POST validates ownership projection and charged quota',async()=>{
  const calls:Array<{url:string;authorization:string|null;body:unknown}>=[];
  const subject=client(async(url,options)=>{
    calls.push({
      url:String(url),
      authorization:new Headers(options?.headers).get('authorization'),
      body:JSON.parse(String(options?.body)),
    });
    return Response.json(payload());
  });
  const decision=await subject.authorizeAndCharge(INPUT);
  assert.equal(decision.kind,'authorized');
  if(decision.kind!=='authorized')return;
  assert.equal(decision.authorization.accountId,'owner-1');
  assert.deepEqual(decision.authorization.deviceAccessModes,{'device-a':'safe'});
  assert.equal(decision.remainingCredits,999);
  assert.equal(calls.length,1);
  assert.equal(calls[0]?.url,'https://control.example.test/api/v1/internal/mcp/authorize-charge');
  assert.equal(calls[0]?.authorization,'Bearer service-test-token-0123456789');
  assert.deepEqual(calls[0]?.body,INPUT);
  assert.equal(JSON.stringify(decision).includes(ACCESS),false);
});

test('duplicate, quota, feature, revoked and service denials never fall back or retry',async()=>{
  for(const [status,code] of [
    [409,'MCP_DUPLICATE_REQUEST'],
    [429,'MCP_QUOTA_EXHAUSTED'],
    [403,'MCP_FEATURE_NOT_IN_PLAN'],
    [401,'UNAUTHENTICATED'],
  ] as const){
    let calls=0;
    const c=client(async()=>{calls++;return Response.json({error:code},{status})});
    const result=await c.authorizeAndCharge(INPUT);
    assert.deepEqual(result,{
      kind:'rejected',httpStatus:status,code,remainingCredits:null,
    });
    assert.equal(calls,1);
  }
});

test('malformed approvals cannot be interpreted as authorized or bypass SAFE',async()=>{
  const invalid=[
    {...payload(),authorization:{...payload().authorization,accountId:42}},
    {...payload(),authorization:{...payload().authorization,deviceAccessModes:{'device-a':'admin'}}},
    {...payload(),authorization:{...payload().authorization,ownerDevices:[{id:'foreign',name:'device',folderId:null}]}},
    {...payload(),charge:{status:'duplicate',chargedCredits:0,remainingCredits:999}},
    {...payload(),charge:{status:'charged',chargedCredits:-1,remainingCredits:999}},
    {...payload(),authenticated:false},
    {},
  ];
  for(const x of invalid){
    const c=client(async()=>Response.json(x));
    assert.deepEqual(await c.authorizeAndCharge(INPUT),{
      kind:'unavailable',code:'MCP_AUTH_CHARGE_UNAVAILABLE',
    });
  }
});

test('network timeouts, HTML and server 5xx remain unavailable without fallback',async()=>{
  for(const response of [
    new Response('service down',{status:503}),
    new Response('<html>oops</html>',{status:200}),
  ]) {
    let calls=0;
    const c=client(async()=>{calls++;return response.clone()});
    assert.deepEqual(await c.authorizeAndCharge(INPUT),{
      kind:'unavailable',code:'MCP_AUTH_CHARGE_UNAVAILABLE',
    });
    assert.equal(calls,1);
  }
  const outage=client(async()=>{throw new Error('NETWORK_ERROR')});
  assert.deepEqual(await outage.authorizeAndCharge(INPUT),{
    kind:'unavailable',code:'MCP_AUTH_CHARGE_UNAVAILABLE',
  });
});

test('invalid invocation IDs and credentials never send a network request',async()=>{
  let networkCalls=0;
  const c=client(async()=>{networkCalls++;return Response.json(payload())});
  assert.equal((await c.authorizeAndCharge({...INPUT,invocationId:'bad'})).kind,'rejected');
  assert.equal((await c.authorizeAndCharge({...INPUT,accessToken:'bad'})).kind,'rejected');
  assert.equal((await c.authorizeAndCharge({...INPUT,toolName:'not valid tool'})).kind,'rejected');
  assert.equal(networkCalls,0);
});

test('constructor rejects insecure control plane and malformed service token',()=>{
  assert.throws(()=>new FusedMcpAuthorizeChargeClient({
    controlPlaneUrl:'http://public.example.test',
    serviceToken:'service-test-token-0123456789',
  }));
  assert.throws(()=>new FusedMcpAuthorizeChargeClient({
    controlPlaneUrl:'https://control.example.test',
    serviceToken:'too-short',
  }));
});
