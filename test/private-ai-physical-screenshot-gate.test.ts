import test from 'node:test';
import assert from 'node:assert/strict';
import {ZodError} from 'zod';
import {executeCapability} from '../src/agent/executors.js';
import {PathPolicy} from '../src/agent/path-policy.js';

test('private AI default rejects physical Windows screenshots for every requested physical source',{
  skip:process.platform!=='win32',
},async()=>{
  const previousDefault=process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
  const previousEnforce=process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE;
  process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT='private_desktop';
  process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE='1';
  try{
    for(const input of [
      {},{source:'virtual_desktop'},
      {source:'primary_screen'},
      {source:'window',hwnd:'0x1'},
    ]){
      await assert.rejects(
        executeCapability('windows.screenshot',input,new PathPolicy(['*']),{accessMode:'full'}),
        (e:unknown)=>e instanceof Error&&'code' in e&&
          e.code==='AI_PHYSICAL_SCREEN_CAPTURE_NOT_ISOLATED'&&
          /windows.private_screen.capture/.test(e.message),
        JSON.stringify(input),
      );
    }
  }finally{
    if(previousDefault===undefined)delete process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
    else process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT=previousDefault;
    if(previousEnforce===undefined)delete process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE;
    else process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE=previousEnforce;
  }
});

test('normal compatibility mode still routes screenshot request to legacy validation',{
  skip:process.platform!=='win32',
},async()=>{
  const previousDefault=process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
  const previousEnforce=process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE;
  delete process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
  delete process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE;
  try{
    // Bogus request avoids capturing Default screen pixels while proving
    // the normal tool is not blanket-disabled outside private AI mode.
    await assert.rejects(
      executeCapability('windows.screenshot',{source:'INVALID_SOURCE'},
        new PathPolicy(['*']),{accessMode:'full'}),
      ZodError,
    );
  }finally{
    if(previousDefault===undefined)delete process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
    else process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT=previousDefault;
    if(previousEnforce===undefined)delete process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE;
    else process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE=previousEnforce;
  }
});
