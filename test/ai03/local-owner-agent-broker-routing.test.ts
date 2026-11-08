import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { executeCapability } from '../../src/agent/executors.js';
import { PathPolicy } from '../../src/agent/path-policy.js';
import { NEXOWIRE_VERSION } from '../../src/version.js';
import type { PrivilegedBrokerClient } from '../../src/agent/privileged-broker-client.js';
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
  assert.deepEqual(calls[0]!.input,input);
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
