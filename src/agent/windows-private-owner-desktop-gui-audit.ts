import * as z from 'zod';
import {inspectWindowsPrivateProcessAncestry,runReadOnlyWindowsAuditPowerShell} from './windows-private-process-ancestry-audit.js';
import {executeWindowsPrivateDesktopCapability} from './windows-private-desktop.js';

const Ancestry=z.object({
  running:z.literal(true),
  inputDesktop:z.string().max(256),
  trackedRootPids:z.array(z.number().int().positive()).max(1025),
  observedDescendantPids:z.array(z.number().int().positive()).max(128),
  reportedDescendantsTruncated:z.boolean(),
  processInventoryTruncated:z.boolean(),
  rootsMissingFromSnapshot:z.array(z.number().int().positive()).max(1025),
  ancestryComplete:z.literal(false),
  physicalDesktopLeakageExcluded:z.literal(false),
});
const DesktopScan=z.object({
  desktop:z.literal('Default'),
  candidateWindows:z.array(z.object({
    pid:z.number().int().positive(),
    count:z.number().int().positive().max(16384),
  })).max(512),
  enumeratedTopLevelWindows:z.number().int().nonnegative().max(16385),
  enumerationTruncated:z.boolean(),
});

type RawAncestry=z.infer<typeof Ancestry>;
type RawDesktopScan=z.infer<typeof DesktopScan>;

export function assessPrivateDefaultGuiOwnership(
  ancestryRaw:unknown,scanRaw:unknown,
  candidatesRaw:unknown,
){
  const ancestry=Ancestry.parse(ancestryRaw);
  const scan=DesktopScan.parse(scanRaw);
  const candidates=z.array(z.number().int().positive()).min(1).max(512)
    .parse(candidatesRaw);
  const allowed=new Set(candidates);
  if(allowed.size!==candidates.length)throw new Error('Duplicate audited process IDs.');
  for(const entry of scan.candidateWindows){
    if(!allowed.has(entry.pid))throw new Error('Default window scan returned an unrelated PID.');
  }
  const observed=scan.candidateWindows
    .filter(record=>record.count>0)
    .sort((a,b)=>a.pid-b.pid);
  const all=[...new Set([...ancestry.trackedRootPids,
    ...ancestry.observedDescendantPids])];
  return{data:{
    kind:'private_default_desktop_gui_ownership_audit' as const,
    scope:'CALLER_WINDOW_STATION_DEFAULT_TOP_LEVEL_WINDOWS' as const,
    candidateProcessCount:candidates.length,
    candidateProcessesTruncated:all.length>candidates.length,
    observedDefaultWindowOwnerPids:observed.map(x=>x.pid),
    observedDefaultWindowCount:observed.reduce((sum,x)=>sum+x.count,0),
    enumeratedTopLevelWindows:scan.enumeratedTopLevelWindows,
    enumerationTruncated:scan.enumerationTruncated,
    ancestryProcessInventoryTruncated:ancestry.processInventoryTruncated,
    ancestryDescendantsTruncated:ancestry.reportedDescendantsTruncated,
    ancestryRootsMissing:ancestry.rootsMissingFromSnapshot.length,
    observedCandidateGuiOnDefault:observed.length>0,
    ownerWindowStationVerified:false as const,
    crossSessionCoverageVerified:false as const,
    allIntermediateEventsObserved:false as const,
    physicalDesktopLeakageExcluded:false as const,
    ancestryComplete:false as const,
    noDefaultGuiProven:false as const,
    queriedDesktop:'Default' as const,
    inputDesktop:ancestry.inputDesktop,
    inspectedWindowTitles:false as const,
    inspectedWindowContents:false as const,
    mutatedPhysicalInput:false as const,
  }};
}

// OpenDesktop and EnumDesktopWindows are read-only; no SetThreadDesktop,
// SwitchDesktop, GetWindowText, GetClassName or GUI input API is called.
const ownerDefaultScanScript=String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class NxDefaultOwnerScan {
  delegate bool Visitor(IntPtr hwnd,IntPtr arg);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern IntPtr OpenDesktop(string name,uint flags,bool inherit,uint desired);
  [DllImport("user32.dll",SetLastError=true)]
  static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll",SetLastError=true)]
  static extern bool EnumDesktopWindows(IntPtr desktop,Visitor visitor,IntPtr arg);
  [DllImport("user32.dll",SetLastError=true)]
  static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  public sealed class Result {
    public int Count;
    public bool Truncated;
    public Dictionary<int,int> Matches=new Dictionary<int,int>();
  }
  public static Result Observe(int[] expected) {
    var target=new HashSet<int>(expected);
    var result=new Result();
    // DESKTOP_READOBJECTS | DESKTOP_ENUMERATE.
    var handle=OpenDesktop("Default",0,false,0x0041);
    if(handle==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      Visitor visit=delegate(IntPtr hwnd,IntPtr unused) {
        result.Count++;
        if(result.Count>16384){result.Truncated=true;return false;}
        uint rawPid;
        GetWindowThreadProcessId(hwnd,out rawPid);
        int pid=(int)rawPid;
        if(pid>0&&target.Contains(pid)){
          int count;
          result.Matches.TryGetValue(pid,out count);
          result.Matches[pid]=count+1;
        }
        return true;
      };
      bool completed=EnumDesktopWindows(handle,visit,IntPtr.Zero);
      if(!completed&&!result.Truncated)
        throw new Win32Exception(Marshal.GetLastWin32Error());
      return result;
    }finally {
      CloseDesktop(handle);
    }
  }
}
'@
[int[]]$targetPids=ConvertFrom-Json -InputObject $env:NEXOWIRE_OWNER_GUI_AUDIT_PIDS
$scan=[NxDefaultOwnerScan]::Observe($targetPids)
$matches=@($scan.Matches.GetEnumerator()|Sort-Object Key|ForEach-Object{
  [pscustomobject]@{pid=[int]$_.Key;count=[int]$_.Value}
})
@{desktop='Default';candidateWindows=$matches;
  enumeratedTopLevelWindows=[int]$scan.Count;
  enumerationTruncated=[bool]$scan.Truncated
}|ConvertTo-Json -Depth 5 -Compress
`;

export async function inspectPrivateDefaultGuiOwnership(){
  if(process.platform!=='win32')
    throw new Error('Default-desktop GUI owner inspection requires Windows.');
  const ancestry=(await inspectWindowsPrivateProcessAncestry()).data;
  const validated=Ancestry.parse(ancestry);
  const all=[...new Set([...validated.trackedRootPids,
    ...validated.observedDescendantPids])].sort((a,b)=>a-b);
  if(all.length===0)throw new Error('No private process PID candidates observed.');
  const candidates=all.slice(0,512);
  let output:string;
  try{
    output=await runReadOnlyWindowsAuditPowerShell(ownerDefaultScanScript,
      {NEXOWIRE_OWNER_GUI_AUDIT_PIDS:JSON.stringify(candidates)},
      20_000,65_536);
  }catch(cause){
    throw Object.assign(new Error(
      'Default-desktop ownership read-only scan unavailable; no negative assurance.',
    ),{code:'PRIVATE_DEFAULT_OWNER_SCAN_UNAVAILABLE',cause});
  }
  const current=await executeWindowsPrivateDesktopCapability(
    'windows.private_desktop.status',{},
  ) as {data:{running?:boolean;shellPid?:number}};
  if(!current.data.running||
     !validated.trackedRootPids.includes(current.data.shellPid??-1)){
    throw Object.assign(new Error('Private desktop changed during owner GUI audit.'),{
      code:'PRIVATE_DEFAULT_OWNER_AUDIT_STATE_CHANGED',
    });
  }
  return assessPrivateDefaultGuiOwnership(validated,
    JSON.parse(output.replace(/^\uFEFF/,'')) as unknown,candidates);
}
