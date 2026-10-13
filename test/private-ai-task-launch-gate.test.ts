import test from 'node:test';
import assert from 'node:assert/strict';
import {ZodError} from 'zod';
import {assertPrivateAiScheduledTaskBoundary,executeCapability} from '../src/agent/executors.js';
import {PathPolicy} from '../src/agent/path-policy.js';
import type {PrivilegedBrokerClient} from '../src/agent/privileged-broker-client.js';

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

test('private AI may still stop or disable tasks for emergency containment',{
  skip:process.platform!=='win32',
},async()=>withPrivateTarget(true,async()=>{
  const broker={execute:async(capability:string,payload:unknown)=>
    ({capability,payload}),
  } as unknown as PrivilegedBrokerClient;
  for(const action of ['stop','disable'] as const){
    assert.doesNotThrow(()=>assertPrivateAiScheduledTaskBoundary(
      'windows.task.control',{name:'UserVisibleTask',action},
    ));
    const result=await executeCapability('windows.task.control',{
      name:'UserVisibleTask',path:'\\',action,
    },new PathPolicy(['*']),{
      accessMode:'full',privilegeMode:'broker',privilegedBroker:broker,
    });
    assert.deepEqual(result,{
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

test('ordinary legacy/headless operation retains existing authorized Scheduler behavior',{
  skip:process.platform!=='win32',
},async()=>withPrivateTarget(false,async()=>{
  assert.doesNotThrow(()=>assertPrivateAiScheduledTaskBoundary(
    'windows.task.control',{name:'Example',action:'start'}));
  let count=0;
  const broker={execute:async()=>{count++;return {ok:true};}} as unknown as PrivilegedBrokerClient;
  const result=await executeCapability('windows.task.control',{
    name:'Example',action:'start',
  },new PathPolicy(['*']),{
    accessMode:'full',privilegeMode:'broker',privilegedBroker:broker,
  });
  assert.deepEqual(result,{ok:true});
  assert.equal(count,1);
}));
