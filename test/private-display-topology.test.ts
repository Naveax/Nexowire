import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectWindowsPrivateDisplayTopology,
  PrivateDisplayTopologyResultSchema,
} from '../src/agent/windows-private-screen.js';
import {isReadOnlyCapability} from '../src/protocol/capabilities.js';
import {MCP_TOOL_CAPABILITY_REQUIREMENTS} from '../src/mcp/tool-capabilities.js';

test('monitor topology inspection is a read-only MCP capability',()=>{
  assert.equal(isReadOnlyCapability('windows.private_display.topology'),true);
  assert.equal(
    MCP_TOOL_CAPABILITY_REQUIREMENTS.windows_private_display_topology,
    'windows.private_display.topology',
  );
});

const sample={
  ok:true as const,topologyKind:'host_shared_native' as const,
  independentAiDisplays:false as const,monitorCount:2,
  monitors:[
    {index:0,id:'\\\\.\\DISPLAY1',x:0,y:0,width:1920,height:1080,
      primary:true,effectiveDpiX:96,effectiveDpiY:96},
    {index:1,id:'\\\\.\\DISPLAY2',x:-2560,y:0,width:2560,height:1440,
      primary:false,effectiveDpiX:144,effectiveDpiY:144},
  ],
  virtualBounds:{x:-2560,y:0,width:4480,height:1440},
  perMonitorDpiAwarenessApplied:true,
  capturedAt:new Date().toISOString(),
  inputDesktopBefore:'Default',inputDesktopAfter:'Default',
  visibleDesktopChanged:false,
};

test('preserves negative coordinates, DPI and shared-host fact',()=>{
  const result=PrivateDisplayTopologyResultSchema.parse(sample);
  assert.equal(result.monitors.length,2);
  assert.equal(result.monitors[1]?.x,-2560);
  assert.equal(result.monitors[1]?.effectiveDpiX,144);
  assert.equal(result.independentAiDisplays,false);
});

test('topology parser rejects inconsistent count, identity and unexpected input-desktop change',()=>{
  for(const bad of [
    {...sample,monitorCount:3},
    {...sample,monitors:[sample.monitors[0],{...sample.monitors[1],index:0}]},
    {...sample,monitors:[sample.monitors[0],{...sample.monitors[1],id:sample.monitors[0]!.id}]},
    {...sample,visibleDesktopChanged:true},
    {...sample,inputDesktopAfter:'NexowirePrivate'},
    {...sample,monitors:[],monitorCount:0},
    {...sample,monitors:sample.monitors.map(m=>({...m,primary:false}))},
    {...sample,virtualBounds:{...sample.virtualBounds,width:1920}},
    {...sample,virtualBounds:{...sample.virtualBounds,x:0}},
  ])assert.equal(PrivateDisplayTopologyResultSchema.safeParse(bad).success,false);
});

test('live Windows monitor discovery works without private-desktop window, and never switches input desktop',{
  skip:process.platform!=='win32',timeout:30_000,
},async()=>{
  const response=await inspectWindowsPrivateDisplayTopology();
  const data=response.data;
  assert.equal(data.topologyKind,'host_shared_native');
  assert.equal(data.independentAiDisplays,false);
  assert.ok(data.monitorCount>=1);
  assert.equal(data.monitors.length,data.monitorCount);
  assert.equal(data.inputDesktopBefore,data.inputDesktopAfter);
  assert.equal(data.visibleDesktopChanged,false);
  assert.ok(data.monitors.some(m=>m.primary));
  for(const m of data.monitors){
    assert.ok(m.width>0&&m.height>0&&m.id.length>0);
  }
  const minX=Math.min(...data.monitors.map(m=>m.x));
  const minY=Math.min(...data.monitors.map(m=>m.y));
  const maxX=Math.max(...data.monitors.map(m=>m.x+m.width));
  const maxY=Math.max(...data.monitors.map(m=>m.y+m.height));
  assert.deepEqual(data.virtualBounds,
    {x:minX,y:minY,width:maxX-minX,height:maxY-minY});
});
