import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZodError } from 'zod';
import {
  parseLocalMonitorSelection,
  readLocalMonitorSelection,
} from '../src/agent/windows-private-viewer.js';

test('locally chosen private window maps to exact HWND, other scopes clear it',()=>{
  assert.deepEqual(
    parseLocalMonitorSelection({source:'window',hwnd:'0x001A'}),
    {selectedWindowHwnd:'0x001A',selectedMonitorId:null},
  );
  assert.deepEqual(
    parseLocalMonitorSelection({source:'monitor',monitor_id:'MON-2'}),
    {selectedWindowHwnd:null,selectedMonitorId:'MON-2'},
  );
  assert.deepEqual(
    parseLocalMonitorSelection({source:'desktop'}),
    {selectedWindowHwnd:null,selectedMonitorId:null},
  );
});

test('malformed selectors fail closed and cannot target physical/default windows',()=>{
  for(const invalid of [
    {source:'window'},
    {source:'window',hwnd:'not a handle'},
    {source:'window',hwnd:'0xG'},
    {source:'window',hwnd:''},
    {source:'desktop',hwnd:'0xF'},
    {source:'monitor',monitor_id:'MON',hwnd:'0xB'},
    {source:'window',hwnd:'0xC',monitor_id:'MON'},
    {source:'default',hwnd:'0xA'},
    {source:'window',hwnd:'0xC',command:'activate'},
  ])assert.throws(()=>parseLocalMonitorSelection(invalid),ZodError,JSON.stringify(invalid));
});

test('local window request survives one refresh and can always reset to all screens',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nx-viewer-window-select-'));
  const previous=process.env.NEXOWIRE_PRIVATE_VIEWER_DIR;
  process.env.NEXOWIRE_PRIVATE_VIEWER_DIR=dir;
  const request=path.join(dir,'monitor-selection.request.json');
  let state:Parameters<typeof readLocalMonitorSelection>[0]={
    version:1,pid:999,startedAt:new Date().toISOString(),
    refreshMs:500,maxWidth:1280,maxHeight:720,maxBytes:4194304,
    topmost:false,selectedMonitorId:null,selectedWindowHwnd:null,
    lastSelectionError:null,emptyCaptureArea:null,lastFrameAt:null,
    frameBytes:null,frameWidth:null,frameHeight:null,lastError:null,
  };
  try{
    await fs.writeFile(request,JSON.stringify({source:'window',hwnd:'0xABC'}));
    state=await readLocalMonitorSelection(state);
    assert.equal(state.selectedWindowHwnd,'0xABC');
    assert.equal(state.selectedMonitorId,null);
    assert.equal(state.lastSelectionError,null);
    assert.equal((await readLocalMonitorSelection(state)).selectedWindowHwnd,'0xABC');

    await fs.writeFile(request,JSON.stringify({source:'window',hwnd:'not-a-private-handle'}));
    state=await readLocalMonitorSelection(state);
    assert.equal(state.selectedWindowHwnd,'0xABC');
    assert.match(state.lastSelectionError??'',/Invalid monitor selection/);

    await fs.writeFile(request,JSON.stringify({source:'desktop'}));
    state=await readLocalMonitorSelection(state);
    assert.equal(state.selectedWindowHwnd,null);
    assert.equal(state.lastSelectionError,null);

    await fs.writeFile(request,JSON.stringify({source:'monitor',monitor_id:'\\\\.\\DISPLAY2'}));
    state=await readLocalMonitorSelection(state);
    assert.equal(state.selectedWindowHwnd,null);
    assert.equal(state.selectedMonitorId,'\\\\.\\DISPLAY2');
  }finally{
    if(previous===undefined)delete process.env.NEXOWIRE_PRIVATE_VIEWER_DIR;
    else process.env.NEXOWIRE_PRIVATE_VIEWER_DIR=previous;
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test('viewer reads private window inventory handles and never calls foreground/window focus',async()=>{
  const source=await fs.readFile(new URL('../src/agent/windows-private-viewer.ts',import.meta.url),'utf8');
  for(const required of [
    "PREVIEW WINDOW", "ALL SCREENS", "source='window'",'hwnd=$handle',
    '$entry.Tag=$handle','selectedWindowHwnd',
    "source: state.selectedWindowHwnd ? 'window'",
    'Write-PreviewSelection',
  ])assert.ok(source.includes(required),required);
  assert.doesNotMatch(source,/SetForegroundWindow\s*\(/);
});
