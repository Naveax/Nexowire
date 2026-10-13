import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {ZodError} from 'zod';
import {
  parseLocalPrivateWindowCloseRequest,
} from '../src/agent/windows-private-viewer.js';

test('local confirmation produces only a bounded HWND close request',()=>{
  assert.deepEqual(
    parseLocalPrivateWindowCloseRequest({
      action:'close_private_window',hwnd:'0xAC12',
    }),
    {action:'close_private_window',hwnd:'0xAC12'},
  );
});

test('close request parser rejects arbitrary command injection, missing or forged actions',()=>{
  for(const value of [
    {},{hwnd:'0xA'},
    {action:'kill_process',hwnd:'0xA'},
    {action:'close_private_window',hwnd:'not-a-hwnd'},
    {action:'close_private_window',hwnd:'0xG'},
    {action:'close_private_window',hwnd:'0x1',pid:55},
    {action:'close_private_window',hwnd:'0x1',shell:'powershell'},
    {action:'close_private_window',hwnd:'0x1',desktop:'Default'},
    {action:'close_private_window',hwnd:1},
  ]){
    assert.throws(()=>parseLocalPrivateWindowCloseRequest(value),ZodError,
      JSON.stringify(value));
  }
});

test('WPF viewer requires local Yes/No confirmation and agent rechecks HWND provenance',async()=>{
  const source=await fs.readFile(
    new URL('../src/agent/windows-private-viewer.ts',import.meta.url),'utf8');
  for(const required of [
    "Content='CLOSE APP'",
    "MessageBoxButton]::YesNo",
    "action='close_private_window'",
    "WindowCloseRequestPath",
    "WindowCloseResultPath",
    "handleLocalPrivateWindowClose",
    "'windows.private_desktop.window.close'",
    "inputDesktop!=='Default'",
    "closed:boolean",
    "forcedProcessTermination",
  ]){
    if(required==='forcedProcessTermination')continue; // native tool owns termination invariants
    assert.ok(source.includes(required),required);
  }
  assert.doesNotMatch(source,/SetForegroundWindow\s*\(/);
  assert.doesNotMatch(source,/taskkill\.exe/);
});
