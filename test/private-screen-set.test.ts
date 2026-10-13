import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {ZodError} from 'zod';
import {executeWindowsPrivateDesktopCapability as privateDesktop} from '../src/agent/windows-private-desktop.js';
import {isReadOnlyCapability} from '../src/protocol/capabilities.js';
import {MCP_TOOL_CAPABILITY_REQUIREMENTS} from '../src/mcp/tool-capabilities.js';
import {
  captureWindowsPrivateScreenSet,
  PrivateScreenSetRequestSchema,
  PrivateScreenSetError,
  validatePrivateScreenSet,
} from '../src/agent/windows-private-screen-set.js';
import type {
  WindowsPrivateScreenCapture,
  WindowsPrivateDisplayTopology,
} from '../src/agent/windows-private-screen.js';

const monitors=[
  {index:0,id:'\\\\.\\DISPLAY1',x:0,y:0,width:1920,height:1080,
    primary:true,effectiveDpiX:96,effectiveDpiY:96},
  {index:1,id:'\\\\.\\DISPLAY2',x:-2560,y:0,width:2560,height:1440,
    primary:false,effectiveDpiX:144,effectiveDpiY:144},
];
const topology:WindowsPrivateDisplayTopology={
  topologyKind:'host_shared_native',independentAiDisplays:false,
  monitorCount:2,monitors,
  virtualBounds:{x:-2560,y:0,width:4480,height:1440},
  perMonitorDpiAwarenessApplied:true,capturedAt:new Date().toISOString(),
  inputDesktopBefore:'Default',inputDesktopAfter:'Default',
  visibleDesktopChanged:false,
};
const frame=(index:number):WindowsPrivateScreenCapture=>({
  source:'monitor',topologyKind:'host_shared_native',
  perMonitorDpiAwarenessApplied:true,
  monitorCount:2,monitors,selectedMonitorIndex:index,
  captureBounds:{
    x:monitors[index]!.x,y:monitors[index]!.y,
    width:monitors[index]!.width,height:monitors[index]!.height,
  },
  hwnd:null,title:null,width:1280,height:720,
  sourceWidth:monitors[index]!.width,
  sourceHeight:monitors[index]!.height,
  scaled:true,scale:0.5,mimeType:'image/png',
  bytes:4096,base64:'iVBORw0KGgo=',
  inputDesktopBefore:'Default',inputDesktopAfter:'Default',
  visibleDesktopChanged:false,
  enumeratedWindows:1,capturedWindows:1,
  emptyCaptureArea:false,failedWindows:0,
});

test('all monitor images capability is read only and default combined screenshot remains separate',()=>{
  assert.equal(isReadOnlyCapability('windows.private_screen.capture_set'),true);
  assert.equal(
    MCP_TOOL_CAPABILITY_REQUIREMENTS.windows_private_screen_capture_set,
    'windows.private_screen.capture_set',
  );
  assert.equal(PrivateScreenSetRequestSchema.parse({}).max_width,2560);
  assert.throws(()=>PrivateScreenSetRequestSchema.parse({
    max_bytes:4_194_304,max_total_bytes:1024,
  }),ZodError);
  assert.throws(()=>PrivateScreenSetRequestSchema.parse({
    source:'default',
  }),ZodError);
});

test('two separate PNGs retain negative coordinates and independent DPI',()=>{
  const result=validatePrivateScreenSet(topology,[frame(0),frame(1)],16384);
  assert.equal(result,8192);
  assert.equal(topology.monitors[1]!.x,-2560);
  assert.equal(topology.monitors[1]!.effectiveDpiX,144);
});

test('partial batches, topology hotplug, wrong scope, changed Default and byte overrun fail closed',()=>{
  for(const [name,all,total] of [
    ['missing',[frame(0)],16384],
    ['wrong scope',[frame(0),{...frame(1),source:'desktop' as const}],16384],
    ['wrong index',[frame(0),{...frame(1),selectedMonitorIndex:0}],16384],
    ['hotplug',[frame(0),{...frame(1),monitorCount:3}],16384],
    ['geometry',[frame(0),{...frame(1),captureBounds:{x:-1280,y:0,width:2560,height:1440}}],16384],
    ['input desktop',[frame(0),{...frame(1),inputDesktopAfter:'NexowirePrivate'}],16384],
    ['bytes',[frame(0),frame(1)],4096],
  ] as const){
    assert.throws(()=>validatePrivateScreenSet(
      topology,[...all],total,
    ),PrivateScreenSetError,name);
  }
});

test('rejects inconsistent and excessive monitor count instead of returning truncated images',()=>{
  assert.throws(()=>validatePrivateScreenSet(
    {...topology,monitorCount:9},[frame(0),frame(1)],16000,
  ),PrivateScreenSetError);
  assert.throws(()=>validatePrivateScreenSet(
    {...topology,monitorCount:2,monitors:[monitors[0]!,monitors[0]!] },
    [frame(0),frame(1)],16000,
  ),PrivateScreenSetError);
});

test('real Windows batch captures every private monitor as independent PNG, without changing Default',{
  skip:process.platform!=='win32',timeout:80_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-screen-set-'));
  const prior=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const priorSkip=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=root;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await privateDesktop('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(prior===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=prior;
    if(priorSkip===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=priorSkip;
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:150});
  });
  const started=await privateDesktop('windows.private_desktop.start',{
    create_shortcut:false,
  }) as {data:{inputDesktop:string}};
  assert.equal(started.data.inputDesktop,'Default');
  const {data}=await captureWindowsPrivateScreenSet({
    max_width:1024,max_height:768,max_bytes:4_194_304,
    max_total_bytes:16_777_216,
  });
  assert.equal(data.complete,true);
  assert.equal(data.monitorCount,data.capturedMonitorCount);
  assert.equal(data.captures.length,data.monitorCount);
  assert.equal(data.inputDesktopBefore,'Default');
  assert.equal(data.inputDesktopAfter,'Default');
  assert.equal(data.visibleDesktopChanged,false);
  assert.equal(data.independentAiDisplays,false);
  assert.equal(data.totalBytes,data.captures.reduce((sum,item)=>sum+item.bytes,0));
  for(let i=0;i<data.captures.length;i++){
    const frame=data.captures[i]!;
    const m=data.monitors[i]!;
    assert.equal(frame.selectedMonitorIndex,m.index);
    assert.deepEqual(frame.captureBounds,{
      x:m.x,y:m.y,width:m.width,height:m.height,
    });
    assert.equal(frame.mimeType,'image/png');
    assert.equal(Buffer.from(frame.base64,'base64').subarray(0,4).toString('hex'),'89504e47');
  }
});
