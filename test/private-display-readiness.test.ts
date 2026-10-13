import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {planWindowsPrivateDisplays} from '../src/agent/windows-private-display-plan.js';
import {
  privateDisplayProfileSet,
  privateDisplayProfileReset,
  privateDisplayProfileStatus,
} from '../src/agent/windows-private-display-profile.js';
import {inspectWindowsPrivateDisplayTopology} from '../src/agent/windows-private-screen.js';
import {
  inspectWindowsPrivateDisplayBackend,
  type WindowsPrivateDisplayBackendProbe,
} from '../src/agent/windows-private-display-backend-probe.js';
import {
  assessWindowsPrivateDisplayReadiness,
  inspectWindowsPrivateDisplayReadiness,
} from '../src/agent/windows-private-display-readiness.js';
import {isReadOnlyCapability} from '../src/protocol/capabilities.js';
import {MCP_TOOL_CAPABILITY_REQUIREMENTS} from '../src/mcp/tool-capabilities.js';

const host={
  topologyKind:'host_shared_native' as const,independentAiDisplays:false as const,
  monitorCount:1,
  monitors:[{index:0,id:'\\\\.\\DISPLAY1',x:0,y:0,width:1920,height:1080,
    primary:true,effectiveDpiX:96,effectiveDpiY:96}],
  virtualBounds:{x:0,y:0,width:1920,height:1080},
  perMonitorDpiAwarenessApplied:true,
  capturedAt:new Date().toISOString(),
  inputDesktopBefore:'Default',inputDesktopAfter:'Default',
  visibleDesktopChanged:false,
};
const backend:WindowsPrivateDisplayBackendProbe={
  platform:'win32',hypervisorPresent:true,
  vmManagementServiceRunning:true,hyperVModuleAvailable:true,
  vmInventoryStatus:'available',vmCount:3,runningVmCount:2,
  candidateHostVirtualDisplayAdapters:[
    {name:'Parsec Virtual Display Adapter',driverVersion:'0.45.0.0'},
  ],
  hostDisplayTopologyShared:true,
  isolatedAiDisplayBackendReady:false,
  osDisplaysProvisioned:false,
  touchesHostDisplaySettings:false,
  pendingRequirement:'ISOLATED_GUEST_DISPLAY_PROVIDER_AND_AUTHORIZATION',
};

test('profile readiness is read-only and has an MCP capability',()=>{
  assert.equal(isReadOnlyCapability('windows.private_display.readiness'),true);
  assert.equal(
    MCP_TOOL_CAPABILITY_REQUIREMENTS.windows_private_display_readiness,
    'windows.private_display.readiness',
  );
});

test('even exact resolution match plus 2 running VMs is never evidence of isolated AI monitors',()=>{
  const plan=planWindowsPrivateDisplays({
    screen_count:1,width:1920,height:1080,dpi:96,
  }).data;
  const readiness=assessWindowsPrivateDisplayReadiness({
    configured:true,savedAt:new Date().toISOString(),plan,applied:false,
    osMonitorsProvisioned:false,touchesHostDisplaySettings:false,
    backend:'isolated_virtual_display_backend_required',
  },host,backend).data;
  assert.equal(readiness.configured,true);
  assert.equal(readiness.desiredScreenCount,1);
  assert.equal(readiness.hostNativeLayoutMatchesRequestedResolution,true);
  assert.equal(readiness.backend.runningVmCount,2);
  assert.equal(readiness.canApplyDesiredIsolatedDisplays,false);
  assert.equal(readiness.nativeHostMonitorsAreIndependentAiScreens,false);
  assert.equal(readiness.applied,false);
  assert.equal(readiness.osMonitorsProvisioned,false);
  assert.ok(readiness.blockers.includes('ISOLATED_DISPLAY_PROVIDER_NOT_INSTALLED'));
});

test('multiple requested screens show mismatch and deny provisioning on unknown VM authority',()=>{
  const plan=planWindowsPrivateDisplays({
    screen_count:3,width:2560,height:1440,dpi:144,
    per_monitor:[{index:2,width:1280,height:720,dpi:120}],
  }).data;
  const readiness=assessWindowsPrivateDisplayReadiness({
    configured:true,savedAt:new Date().toISOString(),plan,applied:false,
    osMonitorsProvisioned:false,touchesHostDisplaySettings:false,
    backend:'isolated_virtual_display_backend_required',
  },host,{
    ...backend,vmInventoryStatus:'access_denied_or_unavailable',
    vmCount:null,runningVmCount:null,
  }).data;
  assert.equal(readiness.desiredScreenCount,3);
  assert.equal(readiness.desiredMonitors[2]?.dpi,120);
  assert.equal(readiness.hostMonitorCount,1);
  assert.equal(readiness.hostNativeLayoutMatchesRequestedResolution,false);
  assert.ok(readiness.blockers.includes('VM_INVENTORY_NOT_ACCESSIBLE'));
  assert.equal(readiness.canApplyDesiredIsolatedDisplays,false);
  assert.equal(readiness.changesHostDisplaySettings,false);
});

test('missing saved profile remains visibly unconfigured rather than inventing a desired screen',()=>{
  const readiness=assessWindowsPrivateDisplayReadiness({
    configured:false,savedAt:null,plan:null,applied:false,
    osMonitorsProvisioned:false,touchesHostDisplaySettings:false,
    backend:'isolated_virtual_display_backend_required',
  },host,backend).data;
  assert.equal(readiness.configured,false);
  assert.equal(readiness.desiredScreenCount,null);
  assert.deepEqual(readiness.desiredMonitors,[]);
  assert.equal(readiness.hostNativeLayoutMatchesRequestedResolution,null);
  assert.ok(readiness.blockers.includes('PROFILE_NOT_CONFIGURED'));
});

test('live Windows readiness uses saved desired intent without changing real host displays',{
  skip:process.platform!=='win32',timeout:50_000,
},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-readiness-'));
  const previous=process.env.NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR;
  process.env.NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR=root;
  try{
    const initial=(await inspectWindowsPrivateDisplayTopology()).data;
    const saved=await privateDisplayProfileSet({
      screen_count:3,width:1920,height:1080,dpi:144,
      layout:'horizontal',primary_index:1,
      per_monitor:[{index:2,width:1280,height:720,refresh_hz:144}],
    });
    assert.equal(saved.data.applied,false);
    const readiness=(await inspectWindowsPrivateDisplayReadiness()).data;
    assert.equal(readiness.configured,true);
    assert.equal(readiness.desiredScreenCount,3);
    assert.equal(readiness.desiredMonitors[2]?.width,1280);
    assert.equal(readiness.applied,false);
    assert.equal(readiness.canApplyDesiredIsolatedDisplays,false);
    assert.ok(readiness.blockers.length>=1);
    assert.equal(readiness.nativeHostMonitorsAreIndependentAiScreens,false);
    assert.equal(readiness.backend.vmInventoryStatus,
      (await inspectWindowsPrivateDisplayBackend()).data.vmInventoryStatus);
    assert.equal(readiness.hostMonitorCount,initial.monitorCount);
    assert.deepEqual(readiness.hostMonitors,initial.monitors);
    const ending=(await inspectWindowsPrivateDisplayTopology()).data;
    assert.deepEqual(ending.virtualBounds,initial.virtualBounds);
    assert.deepEqual(ending.monitors,initial.monitors);
    assert.equal(ending.inputDesktopBefore,ending.inputDesktopAfter);
  }finally{
    await privateDisplayProfileReset().catch(()=>undefined);
    if(previous===undefined)delete process.env.NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR;
    else process.env.NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR=previous;
    await fs.rm(root,{recursive:true,force:true});
  }
});
