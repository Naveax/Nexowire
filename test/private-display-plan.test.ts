import test from 'node:test';
import assert from 'node:assert/strict';
import {ZodError} from 'zod';
import {planWindowsPrivateDisplays} from '../src/agent/windows-private-display-plan.js';
import {isReadOnlyCapability} from '../src/protocol/capabilities.js';
import {MCP_TOOL_CAPABILITY_REQUIREMENTS} from '../src/mcp/tool-capabilities.js';

const plan=(v:unknown)=>planWindowsPrivateDisplays(v).data;

test('display planning is a read-only capability without physical screen mutation',()=>{
  assert.equal(isReadOnlyCapability('windows.private_display.plan'),true);
  assert.equal(MCP_TOOL_CAPABILITY_REQUIREMENTS.windows_private_display_plan,'windows.private_display.plan');
  const p=plan({screen_count:2});
  assert.equal(p.applied,false);
  assert.equal(p.osMonitorsProvisioned,false);
  assert.equal(p.touchesHostDisplaySettings,false);
  assert.equal(p.blocker.code,'ISOLATED_VIRTUAL_DISPLAY_BACKEND_REQUIRED');
  assert.equal(p.screenshotPolicy.defaultSource,'all_monitors');
  assert.equal(p.screenshotPolicy.includesEveryScreenUnlessSelected,true);
});

test('3-screen independent DPI / resolution / refresh plan has deterministic layout',()=>{
  const p=plan({
    screen_count:3,width:1920,height:1080,dpi:96,refresh_hz:60,
    primary_index:1,layout:'horizontal',
    per_monitor:[
      {index:1,width:2560,height:1440,dpi:144,refresh_hz:144},
      {index:2,width:1280,height:1024,dpi:120},
    ],
  });
  assert.equal(p.requestedScreenCount,3);
  assert.deepEqual(p.monitors.map(m=>[m.id,m.index,m.primary,m.x,m.y,m.width,m.height,m.dpi,m.scalePercent,m.refreshHz]),[
    ['AI-1',0,false,0,0,1920,1080,96,100,60],
    ['AI-2',1,true,1920,0,2560,1440,144,150,144],
    ['AI-3',2,false,4480,0,1280,1024,120,125,60],
  ]);
  assert.deepEqual(p.unionBounds,{x:0,y:0,width:5760,height:1440});
  assert.equal(p.estimatedRgbaBytes,5760*1440*4);
});

test('vertical layout calculates independent monitor offsets',()=>{
  const p=plan({screen_count:2,width:1920,height:1080,layout:'vertical'});
  assert.deepEqual(p.monitors.map(m=>[m.x,m.y]),[[0,0],[0,1080]]);
  assert.deepEqual(p.unionBounds,{x:0,y:0,width:1920,height:2160});
});

test('invalid display counts, DPI, primary, overrides and refresh fail explicitly',()=>{
  const cases:unknown[]=[
    {screen_count:0},{screen_count:9},{screen_count:2,dpi:60},
    {screen_count:2,dpi:481},{screen_count:1,primary_index:1},
    {screen_count:2,per_monitor:[{index:0},{index:0}]},
    {screen_count:2,per_monitor:[{index:2}]},
    {screen_count:2,per_monitor:[{index:1,width:100}]},
    {screen_count:1,refresh_hz:241},{screen_count:1,refresh_hz:23},
    {screen_count:1,per_monitor:[{index:0,dpi:480}, {index:0,dpi:96}]},
    {screen_count:1,unknown_setting:true},
  ];
  for(const input of cases)assert.throws(()=>plan(input),ZodError,JSON.stringify(input));
});

test('giant layouts are rejected prior to display provisioning',()=>{
  assert.throws(
    ()=>plan({screen_count:8,width:7680,height:4320}),
    (e:unknown)=>!!e&&typeof e==='object'&&'code' in e&&e.code==='PRIVATE_DISPLAY_PLAN_TOO_LARGE',
  );
});

test('identical plans have identical device IDs and do not persist or apply them',()=>{
  const x=plan({screen_count:2,primary_index:0});
  assert.deepEqual(x,plan({screen_count:2,primary_index:0}));
  assert.deepEqual(x.monitors.map(m=>m.id),['AI-1','AI-2']);
});
