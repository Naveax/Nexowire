import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  privateDisplayProfileSet,privateDisplayProfileStatus,
  privateDisplayProfileReset,
} from '../src/agent/windows-private-display-profile.js';
import {isReadOnlyCapability} from '../src/protocol/capabilities.js';
import {MCP_TOOL_CAPABILITY_REQUIREMENTS} from '../src/mcp/tool-capabilities.js';

test('display profile status is read-only; save and reset are mutating capabilities',()=>{
  for(const [name,readOnly] of [
    ['status',true],['set',false],['reset',false],
  ] as const){
    const cap='windows.private_display.profile.'+name;
    assert.equal(isReadOnlyCapability(cap),readOnly);
    assert.equal(
      MCP_TOOL_CAPABILITY_REQUIREMENTS[
        ('windows_private_display_profile_'+name) as keyof typeof MCP_TOOL_CAPABILITY_REQUIREMENTS
      ],cap,
    );
  }
});

test('saved AI display profiles survive reads, never provision OS monitors',{
  skip:process.platform!=='win32',
},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-display-profile-'));
  const prior=process.env.NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR;
  process.env.NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR=root;
  try {
    const empty=await privateDisplayProfileStatus();
    assert.equal(empty.data.configured,false);
    assert.equal(empty.data.applied,false);
    assert.equal(empty.data.osMonitorsProvisioned,false);

    const input={
      screen_count:3,
      width:1920,height:1080,dpi:96,refresh_hz:60,
      primary_index:1,layout:'horizontal',
      per_monitor:[
        {index:1,width:2560,height:1440,dpi:144,refresh_hz:144},
        {index:2,width:1280,height:1024,dpi:120,refresh_hz:75},
      ],
    };
    const saved=await privateDisplayProfileSet(input);
    assert.equal(saved.data.configured,true);
    assert.equal(saved.data.plan?.monitors.length,3);
    assert.equal(saved.data.plan?.monitors[1]?.dpi,144);
    assert.equal(saved.data.plan?.monitors[2]?.refreshHz,75);
    assert.equal(saved.data.plan?.screenshotPolicy.defaultSource,'all_monitors');
    assert.equal(saved.data.applied,false);
    assert.equal(saved.data.touchesHostDisplaySettings,false);
    assert.equal(saved.data.backend,'isolated_virtual_display_backend_required');

    const disk=JSON.parse(await fs.readFile(path.join(root,'profile.json'),'utf8'));
    assert.equal(disk.version,1);
    assert.equal(disk.requested.screen_count,3);

    const reread=await privateDisplayProfileStatus();
    assert.deepEqual(reread.data,saved.data);

    await assert.rejects(
      privateDisplayProfileSet({screen_count:9}),
    );
    assert.deepEqual((await privateDisplayProfileStatus()).data,saved.data,
      'A rejected profile must not replace a valid one');

    const cleared=await privateDisplayProfileReset();
    assert.equal(cleared.data.removed,true);
    assert.equal(cleared.data.configured,false);
    assert.equal((await privateDisplayProfileStatus()).data.configured,false);
    assert.equal((await privateDisplayProfileReset()).data.removed,false);
  }finally{
    if(prior===undefined)delete process.env.NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR;
    else process.env.NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR=prior;
    await fs.rm(root,{recursive:true,force:true});
  }
});

test('invalid persisted profile fails explicitly, never silently activates defaults',{
  skip:process.platform!=='win32',
},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-profile-invalid-'));
  const prior=process.env.NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR;
  process.env.NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR=root;
  try{
    await fs.writeFile(path.join(root,'profile.json'),
      JSON.stringify({version:1,savedAt:new Date().toISOString(),
        requested:{screen_count:33}}));
    await assert.rejects(privateDisplayProfileStatus(),
      (e:unknown)=>!!e&&typeof e==='object'&&'code' in e&&
        e.code==='PRIVATE_DISPLAY_PROFILE_INVALID');
    await fs.writeFile(path.join(root,'profile.json'),'{bad json');
    await assert.rejects(privateDisplayProfileStatus(),
      (e:unknown)=>!!e&&typeof e==='object'&&'code' in e&&
        e.code==='PRIVATE_DISPLAY_PROFILE_INVALID');
  }finally{
    if(prior===undefined)delete process.env.NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR;
    else process.env.NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR=prior;
    await fs.rm(root,{recursive:true,force:true});
  }
});
