import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {executeCapability} from '../src/agent/executors.js';
import {PathPolicy} from '../src/agent/path-policy.js';

test('private AI mode rejects Default-desktop virtual-pointer overlay without creating it',{
  skip:process.platform!=='win32',
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-ai-overlay-gate-'));
  const oldRoot=process.env.NEXOWIRE_VIRTUAL_POINTER_DIR;
  const oldTarget=process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
  const oldEnforced=process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE;
  process.env.NEXOWIRE_VIRTUAL_POINTER_DIR=root;
  process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT='private_desktop';
  process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE='1';
  t.after(async()=>{
    if(oldRoot===undefined)delete process.env.NEXOWIRE_VIRTUAL_POINTER_DIR;
    else process.env.NEXOWIRE_VIRTUAL_POINTER_DIR=oldRoot;
    if(oldTarget===undefined)delete process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
    else process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT=oldTarget;
    if(oldEnforced===undefined)delete process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE;
    else process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE=oldEnforced;
    await fs.rm(root,{recursive:true,force:true});
  });
  const policy=new PathPolicy(['*']);
  for(const [capability,input] of [
    ['windows.virtual_pointer.start',{visible:true}],
    ['windows.virtual_pointer.move',{x:400,y:300}],
    ['windows.virtual_pointer.style',{size:42}],
    ['windows.virtual_pointer.visibility',{visible:true}],
  ] as const){
    await assert.rejects(
      executeCapability(capability,input,policy,{accessMode:'full'}),
      (error:unknown)=>error instanceof Error&&'code' in error&&
        error.code==='AI_VISIBLE_OVERLAY_NOT_ISOLATED',
      capability,
    );
  }
  assert.deepEqual(await fs.readdir(root),[],'No WPF overlay can be spawned');
  const status=await executeCapability(
    'windows.virtual_pointer.status',{},policy,{accessMode:'full'},
  ) as {data:{running:boolean}};
  assert.equal(status.data.running,false);
  const stopped=await executeCapability(
    'windows.virtual_pointer.stop',{},policy,{accessMode:'full'},
  ) as {data:{running:boolean}};
  assert.equal(stopped.data.running,false);
});

test('default compatibility mode still permits virtual pointer status',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-ai-overlay-status-'));
  const priorRoot=process.env.NEXOWIRE_VIRTUAL_POINTER_DIR;
  const priorDefault=process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
  const priorEnforce=process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE;
  process.env.NEXOWIRE_VIRTUAL_POINTER_DIR=root;
  delete process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
  delete process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE;
  try{
    if(process.platform==='win32'){
      const status=await executeCapability('windows.virtual_pointer.status',{},
        new PathPolicy(['*'])) as {data:{running:boolean}};
      assert.equal(status.data.running,false);
    }
  }finally{
    if(priorRoot===undefined)delete process.env.NEXOWIRE_VIRTUAL_POINTER_DIR;
    else process.env.NEXOWIRE_VIRTUAL_POINTER_DIR=priorRoot;
    if(priorDefault===undefined)delete process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
    else process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT=priorDefault;
    if(priorEnforce===undefined)delete process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE;
    else process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE=priorEnforce;
    await fs.rm(root,{recursive:true,force:true});
  }
});
