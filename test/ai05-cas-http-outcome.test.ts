/**
 * AI-05: HTTPS CAS transport returns cannot make uncertain mutations replayable.
 * All network replies are synthetic: no real CAS, credentials or OS effects.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {HttpsExternalGrantCas} from '../src/agent/https-external-grant-cas.js';

const ids={
  authority:'00000000-0000-4000-8000-000000000201',
  owner:'00000000-0000-4000-8000-000000000202',
  device:'00000000-0000-4000-8000-000000000203',
  epoch:'00000000-0000-4000-8000-000000000204',
  session:'00000000-0000-4000-8000-000000000205',
  request:'00000000-0000-4000-8000-000000000206',
  newOwner:'00000000-0000-4000-8000-000000000207',
  newEpoch:'00000000-0000-4000-8000-000000000208',
  newSession:'00000000-0000-4000-8000-000000000209',
};
const client=()=>new HttpsExternalGrantCas({
  endpoint:'https://nexowire-cas.invalid/v1/grant-cas/reserve',
  authorityId:ids.authority,
  credentialFor:async()=> 'test-only-not-an-authority-credential',
});
const operation={
  deviceId:ids.device,epoch:ids.epoch,requestId:ids.request,
  fingerprint:'a'.repeat(64),capability:'windows.registry.set',
};
const grant={
  ownerId:ids.owner,deviceId:ids.device,
  deviceEpoch:ids.epoch,sessionEpoch:ids.session,
  expectedGeneration:4,requiredPrivilege:'CORE' as const,
};
const revoke={
  deviceId:ids.device,ownerId:ids.owner,
  deviceEpoch:ids.epoch,sessionEpoch:ids.session,
  expectedGeneration:4,signedOwnerApproval:'x'.repeat(64),
};
const repair={
  ...revoke,newOwnerId:ids.newOwner,
  newDeviceEpoch:ids.newEpoch,newSessionEpoch:ids.newSession,
};
const code=(value:string)=>(e:unknown):boolean=>
  (e as {code?:string})?.code===value;

test('AI-05 HTTP 408/425/429/5xx after CAS request always means UNKNOWN',async t=>{
  let responseStatus=503,callCount=0;
  const paths:string[]=[];
  t.mock.method(globalThis,'fetch',async (input:URL|Request|string)=>{
    callCount++;
    paths.push(String(input));
    return new Response('upstream uncertain',{status:responseStatus});
  });
  const cas=client();
  for(const status of [408,425,429,500,503,504]){
    responseStatus=status;
    const before=callCount;
    await assert.rejects(cas.reserveIfCurrent(operation,grant),
      code('EXTERNAL_GRANT_TRANSPORT_UNKNOWN'));
    await assert.rejects(cas.revokeIfCurrent(revoke),
      code('EXTERNAL_REVOKE_OUTCOME_UNKNOWN'));
    await assert.rejects(cas.rePairIfCurrent(repair),
      code('EXTERNAL_REPAIR_OUTCOME_UNKNOWN'));
    assert.equal(callCount,before+3,'no hidden retry after uncertain HTTP');
  }
  assert.equal(paths.length,18);
  assert.ok(paths.every(p=>p.startsWith('https://nexowire-cas.invalid/')));
});

test('AI-05 verified terminal HTTP 403/409 remains refusal, not an execution permit',async t=>{
  let responseStatus=403,callCount=0;
  t.mock.method(globalThis,'fetch',async ()=>{
    callCount++;
    return new Response('explicit rejection',{status:responseStatus});
  });
  const cas=client();
  for(const status of [403,409]){
    responseStatus=status;
    await assert.rejects(cas.reserveIfCurrent(operation,grant),
      code('EXTERNAL_GRANT_AUTHORITY_REFUSED'));
    await assert.rejects(cas.revokeIfCurrent(revoke),
      code('EXTERNAL_REVOKE_AUTHORITY_REFUSED'));
    await assert.rejects(cas.rePairIfCurrent(repair),
      code('EXTERNAL_REPAIR_AUTHORITY_REFUSED'));
  }
  assert.equal(callCount,6);
});

test('AI-05 authorityId cannot be retargeted after constructor before signed proof',async t=>{
  const foreign='00000000-0000-4000-8000-000000000299';
  const mutable={
    endpoint:'https://nexowire-cas.invalid/v1/grant-cas/reserve',
    authorityId:ids.authority,
    credentialFor:async()=> 'synthetic-credential-not-for-production',
  };
  const cas=new HttpsExternalGrantCas(mutable);
  // Previously, verification referenced this mutable object rather than the
  // pinned constructor authority. A foreign but well-shaped proof could pass.
  mutable.authorityId=foreign;
  let requested=0;
  t.mock.method(globalThis,'fetch',async (input:URL|Request|string)=>{
    requested++;
    const endpoint=String(input);
    if(endpoint.endsWith('/reserve')){
      return new Response(JSON.stringify({
        authorityId:foreign,deviceId:ids.device,epoch:ids.epoch,
        requestId:ids.request,ownerId:ids.owner,sessionEpoch:ids.session,
        grantGeneration:4,fingerprint:'a'.repeat(64),
        capability:'windows.registry.set',created:true,sequence:9,
      }),{status:200});
    }
    const common={
      authorityId:foreign,deviceId:ids.device,ownerId:ids.owner,
      deviceEpoch:ids.epoch,sessionEpoch:ids.session,
      previousGeneration:4,generation:5,revoked:true,
    };
    if(endpoint.endsWith('/revoke'))
      return new Response(JSON.stringify(common),{status:200});
    return new Response(JSON.stringify({
      ...common,newOwnerId:ids.newOwner,newDeviceEpoch:ids.newEpoch,
      newSessionEpoch:ids.newSession,coreCleared:true,
    }),{status:200});
  });
  await assert.rejects(cas.reserveIfCurrent(operation,grant),
    code('EXTERNAL_GRANT_PROOF_SCOPE_MISMATCH'));
  await assert.rejects(cas.revokeIfCurrent(revoke),
    code('EXTERNAL_REVOKE_PROOF_SCOPE_MISMATCH'));
  await assert.rejects(cas.rePairIfCurrent(repair),
    code('EXTERNAL_REPAIR_PROOF_SCOPE_MISMATCH'));
  assert.equal(requested,3,'no unexpected retry of foreign authority proof');
});


test('AI-05 HTTPS CAS rejects accessor-backed identity and signed approval without invoking getters',async()=>{
  const cas=client();
  let getterReads=0,credentialCalls=0;
  const original=Object.defineProperty({...operation},'requestId',{
    enumerable:true,configurable:true,
    get(){getterReads++;return ids.request},
  });
  const provider=new HttpsExternalGrantCas({
    endpoint:'https://nexowire-cas.invalid/v1/grant-cas/reserve',
    authorityId:ids.authority,
    credentialFor:async()=>{credentialCalls++;return 'untrusted-test-token';},
  });
  await assert.rejects(provider.reserveIfCurrent(original,grant),
    code('EXTERNAL_GRANT_INPUT_INVALID'));
  const hostileScope=Object.defineProperty({...grant},'ownerId',{
    enumerable:true,configurable:true,
    get(){getterReads++;return ids.owner},
  });
  await assert.rejects(provider.reserveIfCurrent(operation,hostileScope),
    code('EXTERNAL_GRANT_SCOPE_INVALID'));
  for(const [input,invoke,expectedCode] of [
    [revoke,(value:typeof revoke)=>provider.revokeIfCurrent(value),
      'EXTERNAL_REVOKE_INPUT_INVALID'],
    [repair,(value:typeof repair)=>provider.rePairIfCurrent(value),
      'EXTERNAL_REPAIR_INPUT_INVALID'],
  ] as const){
    const hostile=Object.defineProperty({...input},'signedOwnerApproval',{
      enumerable:true,configurable:true,
      get(){getterReads++;return 'x'.repeat(64)},
    });
    await assert.rejects(invoke(hostile as never),code(expectedCode));
  }
  assert.equal(getterReads,0);
  assert.equal(credentialCalls,0);
  void cas;
});

test('AI-05 HTTPS CAS rejects proxy, symbol and hidden identity properties before transport',async()=>{
  let traps=0,credentials=0;
  const provider=new HttpsExternalGrantCas({
    endpoint:'https://nexowire-cas.invalid/v1/grant-cas/reserve',
    authorityId:ids.authority,
    credentialFor:async()=>{credentials++;return 'untrusted-test-token';},
  });
  const proxy=new Proxy({...operation},{
    getOwnPropertyDescriptor(target,key){
      traps++;return Reflect.getOwnPropertyDescriptor(target,key);
    },
    ownKeys(target){traps++;return Reflect.ownKeys(target)},
  });
  const symbol={...operation,[Symbol('hidden')]:ids.owner};
  const hidden=Object.defineProperty({...operation},'fingerprint',{
    enumerable:false,configurable:true,value:operation.fingerprint,
  });
  for(const value of [proxy,symbol,hidden]){
    await assert.rejects(provider.reserveIfCurrent(value,grant),
      code('EXTERNAL_GRANT_INPUT_INVALID'));
  }
  assert.equal(traps,0);
  assert.equal(credentials,0);
});

test('AI-05 HTTPS CAS sends admitted immutable wire bytes after credential await',async t=>{
  const original={...operation},scopeInput={...grant};
  const revocation={...revoke},repairInput={...repair};
  const resolvers:Array<(token:string)=>void>=[];
  const seen:Array<{url:string;data:unknown}>=[];
  t.mock.method(globalThis,'fetch',async (target:URL|Request|string,
    init?:RequestInit)=>{
    seen.push({url:String(target),data:JSON.parse(String(init?.body))});
    return new Response('uncertain external outcome',{status:503});
  });
  const provider=new HttpsExternalGrantCas({
    endpoint:'https://nexowire-cas.invalid/v1/grant-cas/reserve',
    authorityId:ids.authority,
    credentialFor:async()=>new Promise<string>(resolve=>{resolvers.push(resolve)}),
  });
  const calls=[
    {pending:provider.reserveIfCurrent(original,scopeInput),
      code:'EXTERNAL_GRANT_TRANSPORT_UNKNOWN'},
    {pending:provider.revokeIfCurrent(revocation),
      code:'EXTERNAL_REVOKE_OUTCOME_UNKNOWN'},
    {pending:provider.rePairIfCurrent(repairInput),
      code:'EXTERNAL_REPAIR_OUTCOME_UNKNOWN'},
  ];
  assert.equal(resolvers.length,3);
  original.fingerprint='b'.repeat(64);
  original.requestId=ids.newEpoch;
  scopeInput.ownerId=ids.newOwner;
  scopeInput.expectedGeneration=99;
  revocation.ownerId=ids.newOwner;
  revocation.signedOwnerApproval='y'.repeat(64);
  repairInput.newOwnerId=ids.owner;
  repairInput.signedOwnerApproval='z'.repeat(64);
  for(const resolve of resolvers)resolve('valid-only-for-synthetic-test');
  for(const call of calls)await assert.rejects(call.pending,code(call.code));
  assert.equal(seen.length,3);
  assert.deepEqual(seen[0]?.data,{request:operation,scope:grant});
  assert.deepEqual(seen[1]?.data,revoke);
  assert.deepEqual(seen[2]?.data,repair);
});

test('AI-05 validated external CAS authority and credential resolver cannot be retargeted at runtime',async t=>{
  const cas=client();
  assert.equal(Reflect.get(cas,'endpoint'),
    'https://nexowire-cas.invalid/v1/grant-cas/reserve');
  assert.equal(Reflect.set(cas,'endpoint',new URL(
    'https://foreign-cas.invalid/v1/grant-cas/reserve')),false);
  assert.equal(Reflect.set(cas,'config',{
    endpoint:'https://foreign-cas.invalid/v1/grant-cas/reserve',
    authorityId:ids.newOwner,credentialFor:async()=> 'foreign-credential',
  }),false);
  const urls:string[]=[];
  t.mock.method(globalThis,'fetch',async (url:URL|Request|string)=>{
    urls.push(String(url));
    return new Response('unknown CAS outcome',{status:503});
  });
  await assert.rejects(cas.reserveIfCurrent(operation,grant),
    code('EXTERNAL_GRANT_TRANSPORT_UNKNOWN'));
  await assert.rejects(cas.revokeIfCurrent(revoke),
    code('EXTERNAL_REVOKE_OUTCOME_UNKNOWN'));
  await assert.rejects(cas.rePairIfCurrent(repair),
    code('EXTERNAL_REPAIR_OUTCOME_UNKNOWN'));
  assert.deepEqual(urls,[
    'https://nexowire-cas.invalid/v1/grant-cas/reserve',
    'https://nexowire-cas.invalid/v1/grant-cas/revoke',
    'https://nexowire-cas.invalid/v1/grant-cas/re-pair',
  ]);
});

test('AI-05 grant CAS constructor rejects getter and Proxy configuration without side effects',()=>{
  const normal={
    endpoint:'https://nexowire-cas.invalid/v1/grant-cas/reserve',
    authorityId:ids.authority,
    credentialFor:async()=> 'test-only-not-an-authority-credential',
  };
  let getters=0,traps=0;
  const hostile=Object.defineProperty({...normal},'credentialFor',{
    configurable:true,enumerable:true,
    get(){getters++;return normal.credentialFor},
  });
  assert.throws(()=>new HttpsExternalGrantCas(hostile),
    code('EXTERNAL_GRANT_CONFIG_INVALID'));
  const proxied=new Proxy(normal,{
    ownKeys(target){traps++;return Reflect.ownKeys(target)},
    getOwnPropertyDescriptor(target,key){
      traps++;return Reflect.getOwnPropertyDescriptor(target,key);
    },
  });
  assert.throws(()=>new HttpsExternalGrantCas(proxied),
    code('EXTERNAL_GRANT_CONFIG_INVALID'));
  const hidden=Object.defineProperty({...normal},'authorityId',{
    value:ids.authority,enumerable:false,configurable:true,
  });
  assert.throws(()=>new HttpsExternalGrantCas(hidden),
    code('EXTERNAL_GRANT_CONFIG_INVALID'));
  assert.equal(getters,0);
  assert.equal(traps,0);
});

test('AI-05 successful HTTP headers with lost response body remain UNKNOWN, one attempt each',async t=>{
  // The independent authority may have committed reserve/revoke/re-pair
  // before the client loses its 200 response body. Never claim a safe refusal.
  let fetches=0;
  const urls:string[]=[];
  t.mock.method(globalThis,'fetch',async (url:URL|Request|string)=>{
    fetches++;
    urls.push(String(url));
    const broken=new ReadableStream<Uint8Array>({
      start(controller){controller.error(new Error('synthetic body ACK loss after commit'))},
    });
    return new Response(broken,{status:200});
  });
  const cas=client();
  await assert.rejects(cas.reserveIfCurrent(operation,grant),
    code('EXTERNAL_GRANT_TRANSPORT_UNKNOWN'));
  assert.equal(fetches,1,'lost reserve receipt cannot trigger automatic retry');
  await assert.rejects(cas.revokeIfCurrent(revoke),
    code('EXTERNAL_REVOKE_OUTCOME_UNKNOWN'));
  assert.equal(fetches,2,'lost revoke receipt cannot trigger automatic retry');
  await assert.rejects(cas.rePairIfCurrent(repair),
    code('EXTERNAL_REPAIR_OUTCOME_UNKNOWN'));
  assert.equal(fetches,3,'lost re-pair receipt cannot trigger automatic retry');
  assert.deepEqual(urls,[
    'https://nexowire-cas.invalid/v1/grant-cas/reserve',
    'https://nexowire-cas.invalid/v1/grant-cas/revoke',
    'https://nexowire-cas.invalid/v1/grant-cas/re-pair',
  ]);
});
