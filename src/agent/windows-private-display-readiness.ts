import {
  inspectWindowsPrivateDisplayTopology,
  type WindowsPrivateDisplayTopology,
} from './windows-private-screen.js';
import {
  inspectWindowsPrivateDisplayBackend,
  type WindowsPrivateDisplayBackendProbe,
} from './windows-private-display-backend-probe.js';
import {
  privateDisplayProfileStatus,
  type PrivateDisplayProfileStatus,
} from './windows-private-display-profile.js';

export type AiDisplayReadinessBlocker =
  | 'PROFILE_NOT_CONFIGURED'
  | 'HYPERVISOR_NOT_VERIFIED'
  | 'HYPERV_MANAGEMENT_NOT_VERIFIED'
  | 'VM_INVENTORY_NOT_ACCESSIBLE'
  | 'ISOLATED_DISPLAY_PROVIDER_NOT_INSTALLED';

export interface AiDisplayReadiness {
  kind:'private_ai_display_readiness';
  configured:boolean;
  desiredScreenCount:number|null;
  desiredMonitors:NonNullable<PrivateDisplayProfileStatus['plan']>['monitors'];
  hostMonitorCount:number;
  hostMonitors:WindowsPrivateDisplayTopology['monitors'];
  hostNativeLayoutMatchesRequestedResolution:boolean|null;
  nativeHostMonitorsAreIndependentAiScreens:false;
  backend:{
    hypervisorPresent:boolean|null;
    vmManagementServiceRunning:boolean|null;
    hyperVModuleAvailable:boolean;
    vmInventoryStatus:WindowsPrivateDisplayBackendProbe['vmInventoryStatus'];
    vmCount:number|null;
    runningVmCount:number|null;
    candidateHostVirtualDisplayAdapters:WindowsPrivateDisplayBackendProbe['candidateHostVirtualDisplayAdapters'];
  };
  blockers:AiDisplayReadinessBlocker[];
  canApplyDesiredIsolatedDisplays:false;
  applied:false;
  osMonitorsProvisioned:false;
  changesHostDisplaySettings:false;
  defaultCapture:'all_private_windows_on_host_monitors';
  independentAiMonitorCaptureAvailable:false;
  nextAction:'PROVISION_SEPARATE_AUTHORIZED_GUEST_PROVIDER';
}

/**
 * Joins only observed read-only facts. We deliberately do not interpret
 * matching physical host resolutions as evidence that a requested AI display
 * plan was applied or that a separate Windows session exists.
 */
export function assessWindowsPrivateDisplayReadiness(
  profile:PrivateDisplayProfileStatus,
  topology:WindowsPrivateDisplayTopology,
  probe:WindowsPrivateDisplayBackendProbe,
):{data:AiDisplayReadiness}{
  const plan=profile.plan;
  const blockers:AiDisplayReadinessBlocker[]=[];
  if(!profile.configured||!plan)blockers.push('PROFILE_NOT_CONFIGURED');
  if(probe.hypervisorPresent!==true)blockers.push('HYPERVISOR_NOT_VERIFIED');
  if(probe.vmManagementServiceRunning!==true||!probe.hyperVModuleAvailable){
    blockers.push('HYPERV_MANAGEMENT_NOT_VERIFIED');
  }
  if(probe.vmInventoryStatus!=='available'){
    blockers.push('VM_INVENTORY_NOT_ACCESSIBLE');
  }
  blockers.push('ISOLATED_DISPLAY_PROVIDER_NOT_INSTALLED');
  const match=plan===null?null:
    plan.monitors.length===topology.monitors.length &&
    plan.monitors.every((expected,index)=>{
      const actual=topology.monitors[index];
      return !!actual &&
        expected.width===actual.width &&
        expected.height===actual.height &&
        expected.primary===actual.primary;
    });

  return {data:{
    kind:'private_ai_display_readiness',
    configured:profile.configured,
    desiredScreenCount:plan?.requestedScreenCount??null,
    desiredMonitors:plan?.monitors??[],
    hostMonitorCount:topology.monitorCount,
    hostMonitors:topology.monitors,
    hostNativeLayoutMatchesRequestedResolution:match,
    nativeHostMonitorsAreIndependentAiScreens:false,
    backend:{
      hypervisorPresent:probe.hypervisorPresent,
      vmManagementServiceRunning:probe.vmManagementServiceRunning,
      hyperVModuleAvailable:probe.hyperVModuleAvailable,
      vmInventoryStatus:probe.vmInventoryStatus,
      vmCount:probe.vmCount,
      runningVmCount:probe.runningVmCount,
      candidateHostVirtualDisplayAdapters:probe.candidateHostVirtualDisplayAdapters,
    },
    blockers,
    canApplyDesiredIsolatedDisplays:false,
    applied:false,
    osMonitorsProvisioned:false,
    changesHostDisplaySettings:false,
    defaultCapture:'all_private_windows_on_host_monitors',
    independentAiMonitorCaptureAvailable:false,
    nextAction:'PROVISION_SEPARATE_AUTHORIZED_GUEST_PROVIDER',
  }};
}

export async function inspectWindowsPrivateDisplayReadiness():Promise<{
  data:AiDisplayReadiness;
}>{
  // A failure in any source must fail closed. Never infer readiness by
  // pretending a missing profile or an inaccessible VM inventory is valid.
  const profile=(await privateDisplayProfileStatus()).data;
  const topology=(await inspectWindowsPrivateDisplayTopology()).data;
  const probe=(await inspectWindowsPrivateDisplayBackend()).data;
  return assessWindowsPrivateDisplayReadiness(profile,topology,probe);
}
