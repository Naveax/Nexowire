import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  privateDisplayProfileSet,
  privateDisplayProfileStatus,
  privateDisplayProfileReset,
} from '../src/agent/windows-private-display-profile.js';
import { inspectWindowsPrivateDisplayTopology } from '../src/agent/windows-private-screen.js';

test('AI may revise screen count, DPI, resolution, and refresh without modifying host monitors',{
  skip:process.platform!=='win32',timeout:30_000,
},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nx-display-profile-update-'));
  const prior=process.env.NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR;
  process.env.NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR=dir;
  try {
    const before=(await inspectWindowsPrivateDisplayTopology()).data;
    const first=await privateDisplayProfileSet({screen_count:1,width:1920,height:1080,dpi:96});
    assert.equal(first.data.plan?.requestedScreenCount,1);
    assert.equal(first.data.applied,false);
    assert.equal(first.data.touchesHostDisplaySettings,false);
    const second=await privateDisplayProfileSet({
      screen_count:3,width:2560,height:1440,dpi:144,refresh_hz:144,
      layout:'vertical',
      per_monitor:[{index:2,width:1280,height:720,dpi:120,refresh_hz:60}],
    });
    assert.equal(second.data.plan?.requestedScreenCount,3);
    assert.deepEqual(second.data.plan?.monitors.map(x=>[x.width,x.height,x.dpi,x.refreshHz]),
      [[2560,1440,144,144],[2560,1440,144,144],[1280,720,120,60]]);
    assert.deepEqual((await privateDisplayProfileStatus()).data,second.data);
    const third=await privateDisplayProfileSet({
      screen_count:2,width:1280,height:1024,dpi:110,refresh_hz:75,
      primary_index:1,
    });
    assert.equal(third.data.plan?.requestedScreenCount,2);
    assert.deepEqual(third.data.plan?.monitors.map(x=>x.dpi),[110,110]);
    assert.equal((await privateDisplayProfileStatus()).data.plan?.primaryIndex,1);

    const after=(await inspectWindowsPrivateDisplayTopology()).data;
    assert.equal(after.topologyKind,'host_shared_native');
    assert.deepEqual(after.monitors,before.monitors,
      'Saved desired AI display mode must not modify actual Windows monitors');
    assert.deepEqual(after.virtualBounds,before.virtualBounds);
    const files=await fs.readdir(dir);
    assert.deepEqual(files,['profile.json'],
      'No partial temporary files should remain after replacements');
  }finally{
    await privateDisplayProfileReset().catch(()=>undefined);
    if(prior===undefined)delete process.env.NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR;
    else process.env.NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR=prior;
    await fs.rm(dir,{force:true,recursive:true});
  }
});

test('concurrent valid profile replacements cannot create a partial file',{
  skip:process.platform!=='win32',timeout:30_000,
},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nx-display-profile-concurrent-'));
  const prior=process.env.NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR;
  process.env.NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR=dir;
  const modes=[
    {screen_count:1,width:1024,height:768,dpi:96},
    {screen_count:2,width:1920,height:1080,dpi:120},
    {screen_count:3,width:2560,height:1440,dpi:144},
  ];
  try{
    const results=await Promise.all(modes.map(mode=>privateDisplayProfileSet(mode)));
    assert.equal(results.length,3);
    const current=await privateDisplayProfileStatus();
    assert.equal(current.data.configured,true);
    assert.ok(modes.some(m=>current.data.plan?.requestedScreenCount===m.screen_count));
    const file=JSON.parse(await fs.readFile(path.join(dir,'profile.json'),'utf8'));
    assert.equal(file.version,1);
    assert.equal(file.requested.screen_count,current.data.plan?.requestedScreenCount);
    assert.deepEqual(await fs.readdir(dir),['profile.json']);
    const saved=JSON.stringify(current.data);
    await assert.rejects(privateDisplayProfileSet({screen_count:9}));
    assert.equal(JSON.stringify((await privateDisplayProfileStatus()).data),saved);
  }finally{
    await privateDisplayProfileReset().catch(()=>undefined);
    if(prior===undefined)delete process.env.NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR;
    else process.env.NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR=prior;
    await fs.rm(dir,{force:true,recursive:true});
  }
});

test('oversized stored profile fails closed instead of silently ignoring corrupt state',{
  skip:process.platform!=='win32',
},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nx-display-profile-oversize-'));
  const prior=process.env.NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR;
  process.env.NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR=dir;
  try{
    await fs.writeFile(path.join(dir,'profile.json'),'x'.repeat(65537));
    await assert.rejects(privateDisplayProfileStatus(),
      (e:unknown)=>e instanceof Error&&'code' in e&&
        e.code==='PRIVATE_DISPLAY_PROFILE_INVALID');
  }finally{
    if(prior===undefined)delete process.env.NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR;
    else process.env.NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR=prior;
    await fs.rm(dir,{force:true,recursive:true});
  }
});
