import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { executeCapability } from '../../src/agent/executors.js';
import { PathPolicy } from '../../src/agent/path-policy.js';
import { NEXOWIRE_VERSION } from '../../src/version.js';
import { PrivilegedBrokerClient } from '../../src/agent/privileged-broker-client.js';
import { startPrivilegedBroker } from '../../src/agent/privileged-broker.js';
import { createLocalOwnerBrokerAdmission } from '../../src/agent/privileged-broker-local-owner.js';
import { assertCoreWindowsMutationAdmission } from '../../src/agent/core-windows-mutation-dispatch.js';
import type { CoreConsoleAdmission } from '../../src/agent/core-console-admission.js';

const policy=new PathPolicy(['*']);
const capability='windows.environment.set';
const input={scope:'machine',name:'AI03_TEST_ONLY_NO_WRITE',value:'never-write'};
const active={active:true,localEnrolled:true,state:'ACTIVE_LOCAL_OWNER'} as const;
const code=(name:string)=>(e:unknown)=>e instanceof Error && 'code' in e && e.code===name;

function context(options:{
  core?:boolean;active?:boolean;local?:boolean;elevated?:boolean;
  version?:string;accessMode?:'safe'|'full';requestId?:string;external?:boolean;
}={}){
  const calls:Array<{capability:string;input:unknown;id:string|undefined}>=[];
  const broker={
    probe:async()=>({reachable:true,elevated:options.elevated!==false,
      version:options.version??NEXOWIRE_VERSION,
      localOwnerAdmissionConfigured:options.local!==false}),
    execute:async(capability:string,input:unknown,id?:string)=>{
      calls.push({capability,input,id});return {actualBrokerCallback:true};
    },
  } as unknown as PrivilegedBrokerClient;
  const coreConsole={
    status:async()=>options.active===false ?
      {active:false,localEnrolled:true,state:'REVOKED_LOCALLY'} : active,
  } as unknown as CoreConsoleAdmission;
  return {calls,request:{
    accessMode:options.accessMode??'full',
    privilegeMode:'broker' as const,
    requestId:options.requestId??randomUUID(),
    privilegedBroker:broker,
    ...(options.core===false?{}:{coreConsole}),
    ...(options.external?{coreWindowsDispatch:{} as never}:{}),
  }};
}

test('AI-03 authenticated locally enrolled Agent forwards a frozen effect once to Broker',async()=>{
  const {calls,request}=context();
  const result=await executeCapability(capability,input,policy,request);
  assert.deepEqual(result,{actualBrokerCallback:true});
  assert.equal(calls.length,1);
  assert.equal(calls[0]!.capability,capability);
  assert.equal(calls[0]!.id,request.requestId);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0]!.input)),input);
  assert.notEqual(calls[0]!.input,input);
  assert.equal(Object.isFrozen(calls[0]!.input),true);
});

test('AI-03 unverified Broker, stale CORE, SAFE or external CAS route never forwards',async()=>{
  const scenarios=[
    {local:false},{active:false},{elevated:false},
    {version:'0.0.0'}, {accessMode:'safe' as const},
    {core:false},{requestId:'not-a-uuid'}, {external:true},
  ];
  for(const scenario of scenarios){
    const {calls,request}=context(scenario);
    await assert.rejects(
      executeCapability(capability,input,policy,request),
      code('CORE_EXECUTOR_DISPATCH_NOT_INSTALLED'),
      JSON.stringify(scenario),
    );
    assert.equal(calls.length,0,JSON.stringify(scenario));
  }
});

test('AI-03 cancelled remote request cannot reach the local owner Broker callback',async()=>{
  const controller=new AbortController();
  const {calls,request}=context();
  controller.abort();
  await assert.rejects(executeCapability(capability,input,policy,{
    ...request,requestSignal:controller.signal,
  }),/aborted/i);
  assert.equal(calls.length,0);
});


test('AI-03 Windows Agent to authenticated Broker HTTP callback composes correctly (non-elevated fixture)',{
  skip:process.platform!=='win32',
},async()=>{
  const token='ai03-agent-composition-fixture-token';
  const reserved=new Set<string>();
  const admission=createLocalOwnerBrokerAdmission({
    readStatus:async()=>active,
    reserve:async id=>{if(reserved.has(id))throw Object.assign(Error('EEXIST'),{code:'EEXIST'});reserved.add(id);},
  });
  let callbacks=0;
  const server=await startPrivilegedBroker({port:0,tokens:[token],requireElevation:false,
    localOwnerAdmission:admission,
    execute:async(cap,raw)=>{
      assert.equal(cap,capability);
      assertCoreWindowsMutationAdmission(cap,raw);
      callbacks++;
      return {fixtureOnly:true};
    },
  });
  const realClient=new PrivilegedBrokerClient({url:server.url,token});
  // This disposable test server is NOT elevated; override only its test
  // health evidence to exercise the Agent forwarding branch. Never use this
  // object in production or claim it proves a physical HIGH token.
  const composedClient={
    probe:async()=>({...(await realClient.probe()),elevated:true,
      version:NEXOWIRE_VERSION,localOwnerAdmissionConfigured:true}),
    execute:realClient.execute.bind(realClient),
  } as unknown as PrivilegedBrokerClient;
  const coreConsole={status:async()=>active} as unknown as CoreConsoleAdmission;
  const requestId=randomUUID();
  try{
    const result=await executeCapability(capability,input,policy,{
      privilegeMode:'broker',accessMode:'full',requestId,
      coreConsole,privilegedBroker:composedClient,
    });
    assert.deepEqual(result,{fixtureOnly:true});
    assert.equal(callbacks,1);
    await assert.rejects(executeCapability(capability,input,policy,{
      privilegeMode:'broker',accessMode:'full',requestId,
      coreConsole,privilegedBroker:composedClient,
    }),/BROKER_LOCAL_OWNER_OPERATION_ALREADY_RECORDED/);
    assert.equal(callbacks,1);
  }finally{admission.close();await server.close();}
});
