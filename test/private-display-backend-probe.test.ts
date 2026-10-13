import test from 'node:test';
import assert from 'node:assert/strict';
import {ZodError} from 'zod';
import {isReadOnlyCapability} from '../src/protocol/capabilities.js';
import {MCP_TOOL_CAPABILITY_REQUIREMENTS} from '../src/mcp/tool-capabilities.js';
import {
  PrivateDisplayBackendProbeSchema,
  privateDisplayBackendReadOnlyProbeScript,
  inspectWindowsPrivateDisplayBackend,
} from '../src/agent/windows-private-display-backend-probe.js';
import {inspectWindowsPrivateDisplayTopology} from '../src/agent/windows-private-screen.js';

const result={
  platform:'win32' as const,hypervisorPresent:true,
  vmManagementServiceRunning:true,hyperVModuleAvailable:true,
  effectiveLocalAdministrator:false,effectiveHyperVAdministrator:false,
  vmManagementAccessGuidance:'REVIEW_AUTHORIZED_HYPERV_PERMISSIONS' as const,
  vmInventoryStatus:'access_denied_or_unavailable' as const,
  vmCount:null,runningVmCount:null,
  candidateHostVirtualDisplayAdapters:[
    {name:'Parsec Virtual Display Adapter',driverVersion:'0.45.0.0'},
  ],
  hostDisplayTopologyShared:true as const,
  isolatedAiDisplayBackendReady:false as const,
  osDisplaysProvisioned:false as const,
  touchesHostDisplaySettings:false as const,
  pendingRequirement:'ISOLATED_GUEST_DISPLAY_PROVIDER_AND_AUTHORIZATION' as const,
};

test('backend readiness remains a read-only, accurately blocked capability',()=>{
  assert.equal(isReadOnlyCapability('windows.private_display.backend_probe'),true);
  assert.equal(
    MCP_TOOL_CAPABILITY_REQUIREMENTS.windows_private_display_backend_probe,
    'windows.private_display.backend_probe',
  );
  const parsed=PrivateDisplayBackendProbeSchema.parse(result);
  assert.equal(parsed.isolatedAiDisplayBackendReady,false);
  assert.equal(parsed.vmCount,null);
  assert.equal(parsed.effectiveLocalAdministrator,false);
  assert.equal(parsed.effectiveHyperVAdministrator,false);
});

test('Hyper-V or Parsec virtual adapter can never be misreported as isolated AI screens',()=>{
  for(const invalid of [
    {...result,isolatedAiDisplayBackendReady:true},
    {...result,osDisplaysProvisioned:true},
    {...result,touchesHostDisplaySettings:true},
    {...result,hostDisplayTopologyShared:false},
    {...result,vmCount:3},
    {...result,vmManagementAccessGuidance:'VM_MANAGEMENT_AVAILABLE'},
    {...result,hyperVModuleAvailable:false},
    {...result,effectiveHyperVAdministrator:'yes'},
    {...result,effectiveLocalAdministrator:'true'},
    {...result,vmInventoryStatus:'available',vmCount:null,runningVmCount:null},
    {...result,vmInventoryStatus:'available',vmCount:1,runningVmCount:2},
    {...result,unexpectedCommand:'SetDisplayConfig'},
  ]){
    assert.throws(()=>PrivateDisplayBackendProbeSchema.parse(invalid),ZodError);
  }
});

test('probe script is inventory-only and contains no hypervisor/device/display mutation verbs',()=>{
  const script=privateDisplayBackendReadOnlyProbeScript;
  assert.match(script,/Get-CimInstance Win32_ComputerSystem/);
  assert.match(script,/Get-Service -Name vmms/);
  assert.match(script,/Get-VM -ErrorAction Stop/);
  assert.match(script,/Get-CimInstance Win32_VideoController/);
  for(const forbidden of [
    /\bSet-VM\b/,/\bNew-VM\b/,/\bStart-VM\b/,/\bStop-VM\b/,
    /\bAdd-VM\b/,/\bSetDisplayConfig\b/,
    /\bChangeDisplaySettingsEx\b/,/\bEnable-PnpDevice\b/,
    /\bDisable-PnpDevice\b/,/\bAdd-Computer\b/,
  ])assert.doesNotMatch(script,forbidden);
});

test('real DEV probes virtualization preconditions without changing host display topology',{
  skip:process.platform!=='win32',timeout:35_000,
},async()=>{
  const before=(await inspectWindowsPrivateDisplayTopology()).data;
  const {data}=await inspectWindowsPrivateDisplayBackend();
  assert.ok(data.effectiveLocalAdministrator===null ||
    typeof data.effectiveLocalAdministrator==='boolean');
  assert.ok(data.effectiveHyperVAdministrator===null ||
    typeof data.effectiveHyperVAdministrator==='boolean');
  assert.ok(data.vmManagementAccessGuidance.length>0);
  assert.equal(data.platform,'win32');
  assert.equal(data.hostDisplayTopologyShared,true);
  assert.equal(data.isolatedAiDisplayBackendReady,false);
  assert.equal(data.osDisplaysProvisioned,false);
  assert.equal(data.touchesHostDisplaySettings,false);
  if(data.vmInventoryStatus!=='available'){
    assert.equal(data.vmCount,null);
    assert.equal(data.runningVmCount,null);
  }
  const after=(await inspectWindowsPrivateDisplayTopology()).data;
  assert.deepEqual(after.monitors,before.monitors);
  assert.deepEqual(after.virtualBounds,before.virtualBounds);
  assert.equal(after.inputDesktopBefore,after.inputDesktopAfter);
});
