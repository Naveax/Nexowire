import * as z from 'zod';
import {executeWindowsPrivateDesktopCapability} from './windows-private-desktop.js';

const Status=z.object({
  running:z.boolean(),
  shellPid:z.number().int().positive().optional(),
  launchedPids:z.array(z.number().int().positive()).max(1024).optional(),
  inputDesktop:z.string(),
  windowCount:z.number().int().nonnegative().nullable().optional(),
}).passthrough();
const WindowRecord=z.object({
  hwnd:z.string().min(1).max(32),
  processId:z.number().int().nonnegative(),
}).passthrough();
const WindowInventory=z.object({
  windows:z.array(WindowRecord).max(4096),
  inputDesktop:z.string(),
}).passthrough();

export type PrivateWindowAuditStatus=z.infer<typeof Status>;
export type PrivateWindowInventory=z.infer<typeof WindowInventory>;
export interface PrivateWindowProvenanceAudit {
  kind:'private_window_provenance_audit';
  running:boolean;
  inputDesktop:string;
  observedPrivateWindowCount:number;
  managedAppWindowCount:number;
  privateShellWindowCount:number;
  untrackedWindowCount:number;
  untrackedProcessIds:number[];
  untrackedProcessIdsTruncated:boolean;
  windowInventoryConsistent:boolean;
  observedWindowOwnersAllKnown:boolean;
  fullDescendantIsolationVerified:false;
  physicalDesktopLeakageExcluded:false;
  hostClipboardIsolated:false;
  requiresGuestSessionAcceptance:true;
  observationScope:'NEXOWIREPRIVATE_TOP_LEVEL_WINDOWS_ONLY';
}

/**
 * This is provenance of windows we can SEE on NexowirePrivate, not proof
 * that child programs did not also create GUI on the owner's Default
 * desktop, not a recursive process-tree audit, and not a VM isolation test.
 */
export function assessWindowsPrivateWindowProvenance(
  rawStatus:unknown,
  rawWindows:unknown,
):{data:PrivateWindowProvenanceAudit}{
  const state=Status.parse(rawStatus);
  const inventory=WindowInventory.parse(rawWindows);
  if(!state.running||!state.shellPid||!state.launchedPids){
    throw Object.assign(
      new Error('Private desktop is not running; window owner audit unavailable.'),
      {code:'PRIVATE_WINDOW_AUDIT_NOT_RUNNING'},
    );
  }
  const managed=new Set(state.launchedPids);
  const unknown=new Set<number>();
  let appWindows=0;
  let shellWindows=0;
  let untrackedWindows=0;
  for(const window of inventory.windows){
    if(managed.has(window.processId))appWindows++;
    else if(window.processId===state.shellPid)shellWindows++;
    else{
      untrackedWindows++;
      unknown.add(window.processId);
    }
  }
  const countMatches=state.windowCount===undefined||
    state.windowCount===null||state.windowCount===inventory.windows.length;
  const consistent=state.inputDesktop===inventory.inputDesktop&&countMatches;
  const sorted=[...unknown].sort((a,b)=>a-b);
  return {data:{
    kind:'private_window_provenance_audit',
    running:true,inputDesktop:inventory.inputDesktop,
    observedPrivateWindowCount:inventory.windows.length,
    managedAppWindowCount:appWindows,
    privateShellWindowCount:shellWindows,
    untrackedWindowCount:untrackedWindows,
    untrackedProcessIds:sorted.slice(0,64),
    untrackedProcessIdsTruncated:sorted.length>64,
    windowInventoryConsistent:consistent,
    observedWindowOwnersAllKnown:consistent&&untrackedWindows===0,
    fullDescendantIsolationVerified:false,
    physicalDesktopLeakageExcluded:false,
    hostClipboardIsolated:false,
    requiresGuestSessionAcceptance:true,
    observationScope:'NEXOWIREPRIVATE_TOP_LEVEL_WINDOWS_ONLY',
  }};
}

export async function inspectWindowsPrivateWindowProvenance():Promise<{
  data:PrivateWindowProvenanceAudit;
}>{
  const status=await executeWindowsPrivateDesktopCapability(
    'windows.private_desktop.status',{},
  ) as {data:unknown};
  const inventory=await executeWindowsPrivateDesktopCapability(
    'windows.private_desktop.windows',{},
  ) as {data:unknown};
  return assessWindowsPrivateWindowProvenance(status.data,inventory.data);
}
