import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import {
  PrivateScreenCaptureResponseSchema,
} from '../src/agent/windows-private-screen.js';

const base={
  ok:true as const,
  source:'monitor' as const,
  topologyKind:'host_shared_native' as const,
  perMonitorDpiAwarenessApplied:true,
  monitorCount:1,
  monitors:[{
    index:0,id:'\\\\.\\DISPLAY1',
    x:0,y:0,width:1920,height:1080,
    primary:true,effectiveDpiX:96,effectiveDpiY:96,
  }],
  selectedMonitorIndex:0,captureBounds:{x:0,y:0,width:1920,height:1080},
  hwnd:null,title:null,
  width:1280,height:720,sourceWidth:1920,sourceHeight:1080,
  scaled:true,scale:2/3,mimeType:'image/png' as const,
  bytes:8,base64:'iVBORw0KGgo=',
  inputDesktopBefore:'Default',inputDesktopAfter:'Default',
  visibleDesktopChanged:false,
  enumeratedWindows:0,capturedWindows:0,emptyCaptureArea:true,
  failedWindows:0,
};

test('blank selected private monitor is a valid screenshot, not a render failure',()=>{
  const parsed=PrivateScreenCaptureResponseSchema.parse(base);
  assert.equal(parsed.emptyCaptureArea,true);
  assert.equal(parsed.capturedWindows,0);
  assert.equal(parsed.source,'monitor');
  assert.equal(parsed.selectedMonitorIndex,0);
});

test('blank whole private desktop accepted, including hidden-window inventory',()=>{
  const parsed=PrivateScreenCaptureResponseSchema.parse({
    ...base,source:'desktop',selectedMonitorIndex:null,
    enumeratedWindows:2,
  });
  assert.equal(parsed.emptyCaptureArea,true);
  assert.equal(parsed.capturedWindows,0);
});

test('nonblank capture without any rendered window cannot masquerade as empty',()=>{
  for(const v of [
    {...base,emptyCaptureArea:false},
    {...base,failedWindows:1},
    {...base,capturedWindows:1},
    {...base,source:'window',hwnd:'0x101'},
    {...base,visibleDesktopChanged:true},
    {...base,inputDesktopAfter:'NexowirePrivate'},
  ]){
    assert.equal(PrivateScreenCaptureResponseSchema.safeParse(v).success,false,
      JSON.stringify({source:v.source,empty:v.emptyCaptureArea,windows:v.capturedWindows}));
  }
});

test('successful window image remains valid and cannot be flagged empty',()=>{
  const result=PrivateScreenCaptureResponseSchema.parse({
    ...base,source:'window',hwnd:'0x101',title:'Fixture',
    selectedMonitorIndex:null,captureBounds:null,
    capturedWindows:1,emptyCaptureArea:false,enumeratedWindows:1,
  });
  assert.equal(result.emptyCaptureArea,false);
});

test('viewer clearly identifies an empty area and continues reporting frame health',async()=>{
  const source=await fs.readFile(
    new URL('../src/agent/windows-private-viewer.ts',import.meta.url),'utf8');
  assert.match(source,/LIVE EMPTY AI SCREEN/);
  assert.match(source,/emptyCaptureArea: capture.data.emptyCaptureArea/);
  assert.match(source,/emptyCaptureArea: state.emptyCaptureArea/);
});
