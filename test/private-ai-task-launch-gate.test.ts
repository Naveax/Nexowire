import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ZodError} from 'zod';
import {assertPrivateAiScheduledTaskBoundary,executeCapability} from '../src/agent/executors.js';
import {PathPolicy} from '../src/agent/path-policy.js';
import type {PrivilegedBrokerClient} from '../src/agent/privileged-broker-client.js';
import type {CoreConsoleAdmission} from '../src/agent/core-console-admission.js';
import {NEXOWIRE_VERSION} from '../src/version.js';

async function withPrivateTarget<T>(privateAi:boolean,fn:()=>Promise<T>|T):Promise<T>{
  const target=process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
  const enforce=process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE;
  process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT=privateAi?'private_desktop':'headless';
  process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE=privateAi?'1':'0';
  try{return await fn();}
  finally{
    if(target===undefined)delete process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
    else process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT=target;
    if(enforce===undefined)delete process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE;
    else process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE=enforce;
  }
}

// Fixture-only owner admission. It never reaches Windows Task Scheduler.
// The executor still requires active local CORE and authenticated Broker health.
function fixtureBroker(execute:(capability:string,input:unknown)=>Promise<unknown>) {
  return {
    probe:async()=>({reachable:true,elevated:true,version:NEXOWIRE_VERSION,
      localOwnerAdmissionConfigured:true}),
    execute,
  } as unknown as PrivilegedBrokerClient;
}
function locallyEnrolledContext(broker:PrivilegedBrokerClient){
  return {
    accessMode:'full' as const,
    privilegeMode:'broker' as const,
    privilegedBroker:broker,
    requestId:randomUUID(),
    coreConsole:{status:async()=>({active:true,localEnrolled:true,
      state:'ACTIVE_LOCAL_OWNER'})} as unknown as CoreConsoleAdmission,
  };
}

test('private AI cannot start or enable tasks that may launch owner-visible child GUI',{
  skip:process.platform!=='win32',
},async()=>withPrivateTarget(true,async()=>{
  const payload={name:'UserVisibleTask',path:'\\',action:'start' as const};
  let brokerCalls=0;
  const broker={execute:async()=>{
    brokerCalls++;return {scheduled:true};
  }} as unknown as PrivilegedBrokerClient;
  for(const action of ['start','enable'] as const){
    assert.throws(()=>assertPrivateAiScheduledTaskBoundary(
      'windows.task.control',{...payload,action},
    ),(error:unknown)=>error instanceof Error &&
      'code' in error&&
      error.code==='AI_PRIVATE_SCHEDULED_TASK_GUI_NOT_ISOLATED'&&
      'action' in error&&error.action===action);
    await assert.rejects(executeCapability('windows.task.control',{
      ...payload,action,
    },new PathPolicy(['*']),{
      accessMode:'full',privilegeMode:'broker',privilegedBroker:broker,
    }),(error:unknown)=>error instanceof Error &&
      'code' in error&&error.code==='AI_PRIVATE_SCHEDULED_TASK_GUI_NOT_ISOLATED');
  }
  assert.equal(brokerCalls,0,'No Broker RPC or Scheduler calls must occur');
}));

test('private AI can stop or disable tasks through locally enrolled owner Broker',{
  skip:process.platform!=='win32',
},async()=>withPrivateTarget(true,async()=>{
  const broker=fixtureBroker(async(capability:string,payload:unknown)=>
    ({capability,payload}));
  for(const action of ['stop','disable'] as const){
    assert.doesNotThrow(()=>assertPrivateAiScheduledTaskBoundary(
      'windows.task.control',{name:'UserVisibleTask',action},
    ));
    const result=await executeCapability('windows.task.control',{
      name:'UserVisibleTask',path:'\\',action,
    },new PathPolicy(['*']),locallyEnrolledContext(broker));
    // AI-03 forwards a frozen null-prototype JSON snapshot to the Broker.
    assert.deepEqual(JSON.parse(JSON.stringify(result)),{
      capability:'windows.task.control',
      payload:{name:'UserVisibleTask',path:'\\',action},
    });
  }
}));

test('private mode preserves task inventory and private launch APIs',{
  skip:process.platform!=='win32',
},async()=>withPrivateTarget(true,()=>{
  assert.doesNotThrow(()=>assertPrivateAiScheduledTaskBoundary('windows.tasks',{}));
  assert.doesNotThrow(()=>assertPrivateAiScheduledTaskBoundary(
    'windows.private_desktop.launch',{executable:'powershell.exe'}));
  for(const request of [
    {},{action:'unrecognized'}, {action:25},{action:'startx'},
  ])assert.throws(()=>assertPrivateAiScheduledTaskBoundary(
    'windows.task.control',request,
  ),ZodError);
}));

test('headless Scheduler mutation requires verified local owner Broker admission',{
  skip:process.platform!=='win32',
},async()=>withPrivateTarget(false,async()=>{
  assert.doesNotThrow(()=>assertPrivateAiScheduledTaskBoundary(
    'windows.task.control',{name:'Example',action:'start'}));
  let count=0;
  const broker=fixtureBroker(async()=>{count++;return {ok:true};});
  const request={name:'Example',action:'start'};
  // A bearer-only fixture can no longer bypass the required CORE admission.
  await assert.rejects(executeCapability('windows.task.control',
    request,new PathPolicy(['*']),{
      accessMode:'full',privilegeMode:'broker',privilegedBroker:broker,
    }),(error:unknown)=>error instanceof Error &&
      'code' in error && error.code==='CORE_EXECUTOR_DISPATCH_NOT_INSTALLED');
  assert.equal(count,0);
  const result=await executeCapability('windows.task.control',
    request,new PathPolicy(['*']),locallyEnrolledContext(broker));
  assert.deepEqual(result,{ok:true});
  assert.equal(count,1);
}));
