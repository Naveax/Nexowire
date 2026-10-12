import test from 'node:test';
import assert from 'node:assert/strict';
import {requireWslHeadlessRouting} from '../src/agent/ai-workspace-default.js';
import {executeCapability} from '../src/agent/executors.js';
import {PathPolicy} from '../src/agent/path-policy.js';

test('private AI policy refuses WSLg because visible Linux GUI is not confined to Win32 private desktop',()=>{
  const privateEnv={NEXOWIRE_AI_UI_TARGET_DEFAULT:'private_desktop'};
  assert.throws(
    ()=>requireWslHeadlessRouting(undefined,{platform:'win32',env:privateEnv}),
    (error:unknown)=>error instanceof Error&&'code' in error&&
      error.code==='WSL_PRIVATE_GUI_NOT_ISOLATED',
  );
  assert.throws(
    ()=>requireWslHeadlessRouting('private_desktop',{platform:'win32',env:{}}),
    (error:unknown)=>error instanceof Error&&'code' in error&&
      error.code==='WSL_PRIVATE_GUI_NOT_ISOLATED',
  );
  assert.equal(
    requireWslHeadlessRouting('headless',{platform:'win32',env:privateEnv}),
    'headless',
  );
  assert.equal(
    requireWslHeadlessRouting(undefined,{platform:'win32',env:{}}),
    'headless',
  );
});

test('Windows native wsl.exec fails closed before launching when private AI default is selected',{
  skip:process.platform!=='win32',
},async()=>{
  const old=process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
  process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT='private_desktop';
  try{
    await assert.rejects(
      executeCapability('wsl.exec',{
        command:'printf hello',distro:'nonexistent-private-policy-fixture',
      },new PathPolicy(['*'])),
      (error:unknown)=>error instanceof Error&&'code' in error&&
        error.code==='WSL_PRIVATE_GUI_NOT_ISOLATED',
    );
  }finally{
    if(old===undefined)delete process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
    else process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT=old;
  }
});
