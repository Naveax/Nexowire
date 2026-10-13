import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recoverUnavailablePrivatePreview,
} from '../src/agent/windows-private-viewer.js';

function makeState(){
  return {
    version:1 as const,pid:1234,startedAt:'2026-10-13T00:00:00.000Z',
    refreshMs:500,maxWidth:1920,maxHeight:1080,maxBytes:4194304,
    topmost:false,selectedMonitorId:null as string|null,
    selectedWindowHwnd:'0xABC' as string|null,
    lastSelectionError:null as string|null,
    emptyCaptureArea:null as boolean|null,
    lastFrameAt:null as string|null,frameBytes:null as number|null,
    frameWidth:null as number|null,frameHeight:null as number|null,
    lastError:null as string|null,
  };
}

test('closed private window restores ALL AI screens without touching host desktop',()=>{
  const state=makeState();
  const next=recoverUnavailablePrivatePreview(state,{
    code:'WINDOW_NOT_PRIVATE_DESKTOP',
  });
  assert.ok(next);
  assert.equal(next.selectedWindowHwnd,null);
  assert.equal(next.selectedMonitorId,null);
  assert.match(next.lastSelectionError??'',/restored all AI screens/);
  assert.equal(state.selectedWindowHwnd,'0xABC','prior state is immutable');
});

test('removed monitor restores ALL screens, but only if that monitor was selected',()=>{
  const state={...makeState(),selectedWindowHwnd:null,selectedMonitorId:'\\\\.\\DISPLAY2'};
  const next=recoverUnavailablePrivatePreview(state,{
    code:'PRIVATE_MONITOR_NOT_FOUND',
  });
  assert.equal(next?.selectedMonitorId,null);
  assert.equal(next?.selectedWindowHwnd,null);
  assert.match(next?.lastSelectionError??'',/disconnected/);
});

test('render failures, timeouts and Windows failures NEVER become healthy fallbacks',()=>{
  const state=makeState();
  for(const code of [
    'PRIVATE_WINDOW_RENDER_FAILED','PRIVATE_SCREEN_TIMEOUT',
    'PRIVATE_DESKTOP_RENDER_FAILED','PRIVATE_SCREEN_OUTPUT_INVALID',
    'PRIVATE_SCREEN_START_FAILED','WINDOWS_REQUIRED',
    'PRIVATE_MONITOR_NOT_FOUND','PRIVATE_SCREEN_TOO_LARGE',
    'WINDOW_NOT_PRIVATE_DESKTOP_BAD',
  ]){
    assert.equal(recoverUnavailablePrivatePreview(state,{code}),null,code);
  }
  assert.equal(recoverUnavailablePrivatePreview(state,new Error('bad')),null);
  assert.equal(recoverUnavailablePrivatePreview(state,undefined),null);
  assert.equal(recoverUnavailablePrivatePreview(state,{code:'WINDOW_NOT_PRIVATE_DESKTOP'} as any)?.selectedWindowHwnd,null);
  assert.equal(recoverUnavailablePrivatePreview({...state,selectedWindowHwnd:null},{
    code:'WINDOW_NOT_PRIVATE_DESKTOP',
  }),null);
});

test('window selection takes priority; a disconnected monitor error cannot change window scope',()=>{
  const state={...makeState(),selectedMonitorId:'\\\\.\\DISPLAY3'};
  assert.equal(recoverUnavailablePrivatePreview(state,{code:'PRIVATE_MONITOR_NOT_FOUND'}),null);
  const next=recoverUnavailablePrivatePreview(state,{code:'WINDOW_NOT_PRIVATE_DESKTOP'});
  assert.ok(next);
  assert.equal(next.selectedWindowHwnd,null);
  assert.equal(next.selectedMonitorId,'\\\\.\\DISPLAY3');
});
