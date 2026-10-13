import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPrivateHotkeyNoHostClipboard,
  executeWindowsPrivateDesktopCapability,
} from '../src/agent/windows-private-desktop.js';

const forbidden=[
  ['CTRL','C'],
  ['CTRL','V'],
  ['CONTROL','X'],
  ['SHIFT','INSERT'],
  ['CTRL','INSERT'],
  ['SHIFT','DELETE'],
  ['CTRL','SHIFT','V'],
  ['WIN','V'],
  ['META','D'],
  ['LWIN','E'],
  ['RWIN','R'],
  ['CTRL','ALT','DELETE'],
  ['CTRL','ALT','D'],
];

test('private keyboard refuses every host clipboard and shell-global shortcut',()=>{
  for(const keys of forbidden){
    assert.throws(()=>assertPrivateHotkeyNoHostClipboard(keys),
      (error:unknown)=>error instanceof Error&&
        'code' in error&&
        error.code==='PRIVATE_HOTKEY_HOST_SHARED_NOT_ISOLATED',
      keys.join('+'));
  }
});

test('private keyboard preserves ordinary application shortcuts',()=>{
  for(const keys of [
    ['CTRL','A'],
    ['CTRL','Z'],
    ['CTRL','SHIFT','Z'],
    ['ALT','F4'],
    ['SHIFT','TAB'],
    ['CTRL','F'],
    ['ENTER'],
  ]){
    assert.doesNotThrow(()=>assertPrivateHotkeyNoHostClipboard(keys),
      keys.join('+'));
  }
});

test('a forbidden chord fails before the native private GUI helper or host clipboard',{
  skip:process.platform!=='win32',
},async()=>{
  for(const keys of forbidden){
    await assert.rejects(
      executeWindowsPrivateDesktopCapability(
        'windows.private_keyboard.hotkey',{hwnd:'0x1',keys},
      ),(error:unknown)=>error instanceof Error&&
        'code' in error&&
        error.code==='PRIVATE_HOTKEY_HOST_SHARED_NOT_ISOLATED',
      keys.join('+'));
  }
});

test('mixed-case aliases cannot bypass the clipboard restriction',()=>{
  for(const keys of [
    ['control','v'],['ctrl','Insert'],['Shift','delete'],
    ['meta','v'],['Win','d'],
  ]){
    assert.throws(()=>assertPrivateHotkeyNoHostClipboard(keys),
      /could reach the host clipboard or shell/);
  }
});
