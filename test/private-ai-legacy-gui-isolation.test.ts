import test from 'node:test';
import assert from 'node:assert/strict';
import {assertPrivateAiGuiBoundary,executeCapability} from '../src/agent/executors.js';
import {PathPolicy} from '../src/agent/path-policy.js';
import type {Capability} from '../src/protocol/capabilities.js';

const legacyPhysicalGui:Capability[]=[
  'windows.window.list',
  'windows.window.focus',
  'windows.clipboard.read',
  'windows.clipboard.write',
  'windows.clipboard.clear',
  'windows.keyboard.type',
  'windows.keyboard.hotkey',
  'windows.accessibility.tree',
  'windows.accessibility.find',
  'windows.accessibility.invoke',
  'windows.accessibility.set_value',
  'windows.pointer.position',
  'windows.pointer.move',
  'windows.pointer.click',
  'windows.pointer.scroll',
];

function withPrivatePolicy<T>(mode:'private_desktop'|'headless',
  work:()=>Promise<T>|T):Promise<T>{
  const beforeTarget=process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
  const beforeEnforce=process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE;
  process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT=mode;
  process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE=
    mode==='private_desktop'?'1':'0';
  return Promise.resolve().then(work).finally(()=>{
    if(beforeTarget===undefined)delete process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
    else process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT=beforeTarget;
    if(beforeEnforce===undefined)delete process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE;
    else process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE=beforeEnforce;
  });
}

test('private AI mode rejects all 15 physical GUI legacy routes before any native side effects',{
  skip:process.platform!=='win32',
},async()=>await withPrivatePolicy('private_desktop',async()=>{
  const policy=new PathPolicy(['*']);
  for(const capability of legacyPhysicalGui){
    assert.throws(()=>assertPrivateAiGuiBoundary(capability),
      (err:unknown)=>err instanceof Error &&
        'code' in err && err.code==='AI_PHYSICAL_GUI_NOT_ISOLATED' &&
        'capability' in err && err.capability===capability &&
        /NexowirePrivate/.test(err.message),capability);
    // Direct, nested task graph and runbook dispatch eventually reach
    // this central Agent route. The body must never touch the owner GUI.
    await assert.rejects(executeCapability(capability,{},policy,{
      accessMode:'full',
    }), (err:unknown)=>err instanceof Error&&
      'code' in err&&err.code==='AI_PHYSICAL_GUI_NOT_ISOLATED',
      capability);
  }
}));

test('private clipboard, accessibility and physical pointer have no silent fallback',{
  skip:process.platform!=='win32',
},async()=>await withPrivatePolicy('private_desktop',()=>{
  for(const capability of [
    'windows.clipboard.read',
    'windows.accessibility.invoke',
    'windows.pointer.position',
  ] as const){
    assert.throws(()=>assertPrivateAiGuiBoundary(capability),
      /not isolated/);
  }
}));

test('normal headless/legacy mode retains explicit physical GUI functionality',{
  skip:process.platform!=='win32',
},async()=>await withPrivatePolicy('headless',()=>{
  for(const capability of legacyPhysicalGui){
    assert.doesNotThrow(()=>assertPrivateAiGuiBoundary(capability));
  }
}));

test('private-desktop APIs and system diagnostics are not incorrectly blocked',{
  skip:process.platform!=='win32',
},async()=>await withPrivatePolicy('private_desktop',()=>{
  for(const capability of [
    'windows.private_screen.capture',
    'windows.private_screen.capture_set',
    'windows.private_desktop.windows',
    'windows.private_desktop.launch',
    'windows.private_keyboard.type',
    'windows.private_keyboard.hotkey',
    'windows.private_pointer.move',
    'windows.private_pointer.click',
    'windows.private_display.readiness',
    'windows.processes',
    'machine.snapshot',
    'files.read',
  ] as Capability[]){
    assert.doesNotThrow(()=>assertPrivateAiGuiBoundary(capability),capability);
  }
}));

test('policy enforcement cannot be bypassed by a legacy direct GUI capability',{
  skip:process.platform!=='win32',
},async()=>await withPrivatePolicy('private_desktop',async()=>{
  await assert.rejects(executeCapability('windows.window.focus',{
    hwnd:'0x1',
  },new PathPolicy(['*']),{accessMode:'full'}),
  (err:unknown)=>err instanceof Error && 'code' in err &&
    err.code==='AI_PHYSICAL_GUI_NOT_ISOLATED');
}));
