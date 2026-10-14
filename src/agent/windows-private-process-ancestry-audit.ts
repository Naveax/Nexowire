import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import * as z from 'zod';
import {executeWindowsPrivateDesktopCapability} from './windows-private-desktop.js';

const execFileAsync=promisify(execFile);
const Status=z.object({
  running:z.boolean(),
  hostPid:z.number().int().positive().optional(),
  shellPid:z.number().int().positive().optional(),
  launchedPids:z.array(z.number().int().positive()).max(1024).optional(),
  startedAt:z.string().datetime().optional(),
  inputDesktop:z.string(),
});
const Process=z.object({
  pid:z.number().int().positive(),
  parentPid:z.number().int().nonnegative(),
  sessionId:z.number().int().nonnegative(),
  createdAt:z.string().datetime().nullable(),
});
type ProcessRow=z.infer<typeof Process>;
const Snapshot=z.object({
  processes:z.array(Process).max(4096),
  inventoryTruncated:z.boolean(),
});

export interface PrivateProcessAncestryAudit {
  kind:'private_process_ancestry_audit';
  running:true;
  inputDesktop:string;
  trackedRootPids:number[];
  rootsMissingFromSnapshot:number[];
  observedDescendantCount:number;
  observedDescendantPids:number[];
  reportedDescendantsTruncated:boolean;
  suspiciousPidReusePids:number[];
  crossSessionDescendantPids:number[];
  processInventoryTruncated:boolean;
  ancestryComplete:false;
  independentSessionVerified:false;
  physicalDesktopLeakageExcluded:false;
  noUntrackedChildrenProven:false;
  scope:'OBSERVED_WIN32_PROCESS_PARENT_LINKS_ONLY';
}

/** No executable paths, command lines, window titles or user profile data. */
export function assessWindowsPrivateProcessAncestry(
  rawStatus:unknown,rawSnapshot:unknown,
):{data:PrivateProcessAncestryAudit}{
  const s=Status.parse(rawStatus);
  if(!s.running||!s.hostPid||!s.shellPid||!s.launchedPids||!s.startedAt){
    throw Object.assign(new Error('Private desktop not running; ancestry audit unavailable.'),{
      code:'PRIVATE_PROCESS_AUDIT_NOT_RUNNING',
    });
  }
  const {processes,inventoryTruncated}=Snapshot.parse(rawSnapshot);
  const byPid=new Map(processes.map(p=>[p.pid,p]));
  if(byPid.size!==processes.length)throw new Error('Duplicate PIDs in process snapshot.');
  const roots=[...new Set([s.shellPid,...s.launchedPids])];
  const missing=roots.filter(pid=>!byPid.has(pid));
  const processStartMs=Date.parse(s.startedAt);
  const rootCreationThreshold=processStartMs-30_000;
  const reused=new Set<number>();
  for(const root of roots){
    const record=byPid.get(root);
    // launchedPids should never predate the private desktop startup by 30s.
    if(record&&record.pid!==s.shellPid&&record.createdAt&&
       Date.parse(record.createdAt)<rootCreationThreshold)reused.add(root);
  }
  const childrenByParent=new Map<number,ProcessRow[]>();
  for(const row of processes){
    const children=childrenByParent.get(row.parentPid)??[];
    children.push(row);
    childrenByParent.set(row.parentPid,children);
  }
  const descendants=new Set<number>();
  const crossSession=new Set<number>();
  const queue=roots.filter(pid=>byPid.has(pid)&&!reused.has(pid));
  for(let head=0;head<queue.length&&head<4096;head++){
    const parentPid=queue[head];
    if(parentPid===undefined)break;
    const parent=byPid.get(parentPid);
    if(!parent)continue;
    for(const child of childrenByParent.get(parentPid)??[]){
      if(child.pid===parentPid||roots.includes(child.pid)||descendants.has(child.pid))continue;
      if(child.createdAt&&parent.createdAt&&
         Date.parse(child.createdAt)<Date.parse(parent.createdAt)){
        reused.add(child.pid);
        continue;
      }
      descendants.add(child.pid);
      queue.push(child.pid);
      if(child.sessionId!==parent.sessionId)crossSession.add(child.pid);
    }
  }
  const sorted=[...descendants].sort((a,b)=>a-b);
  return{data:{
    kind:'private_process_ancestry_audit',
    running:true,inputDesktop:s.inputDesktop,
    trackedRootPids:roots.sort((a,b)=>a-b),
    rootsMissingFromSnapshot:missing.sort((a,b)=>a-b),
    observedDescendantCount:descendants.size,
    observedDescendantPids:sorted.slice(0,128),
    reportedDescendantsTruncated:sorted.length>128,
    suspiciousPidReusePids:[...reused].sort((a,b)=>a-b).slice(0,128),
    crossSessionDescendantPids:[...crossSession].sort((a,b)=>a-b).slice(0,128),
    processInventoryTruncated:inventoryTruncated,
    ancestryComplete:false,
    independentSessionVerified:false,
    physicalDesktopLeakageExcluded:false,
    noUntrackedChildrenProven:false,
    scope:'OBSERVED_WIN32_PROCESS_PARENT_LINKS_ONLY',
  }};
}

const windowsCimScript=String.raw`
$ErrorActionPreference='Stop'
$rows=@(Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, SessionId, CreationDate FROM Win32_Process' -ErrorAction Stop)
$count=$rows.Count
$items=@($rows|Where-Object {[int]$_.ProcessId -gt 0}|Select-Object -First 4096|ForEach-Object{
  [pscustomobject]@{
    pid=[int]$_.ProcessId
    parentPid=[int]$_.ParentProcessId
    sessionId=[int]$_.SessionId
    createdAt=if($_.CreationDate){([datetime]$_.CreationDate).ToUniversalTime().ToString('o')}else{$null}
  }
})
@{processes=$items;inventoryTruncated=($count -gt 4096)}|ConvertTo-Json -Depth 5 -Compress
`;

/**
 * Centralized read-only native Windows audit helper. This is not a GUI
 * sandbox: callers must provide only internal, constant inspection scripts.
 */
export async function runReadOnlyWindowsAuditPowerShell(
  script:string,
  extraEnvironment:Record<string,string>={},
  timeoutMs=15_000,
  maxBufferBytes=1_500_000,
):Promise<string>{
  const{stdout}=await execFileAsync('powershell.exe',[
    '-NoLogo','-NoProfile','-NonInteractive','-Command',script,
  ],{
    windowsHide:true,timeout:timeoutMs,maxBuffer:maxBufferBytes,
    env:{...process.env,...extraEnvironment},
  });
  return stdout;
}

export async function inspectWindowsPrivateProcessAncestry(){
  if(process.platform!=='win32')throw new Error('Windows process ancestry is Windows-only.');
  const first=await executeWindowsPrivateDesktopCapability(
    'windows.private_desktop.status',{},
  ) as{data:unknown};
  const initial=Status.parse(first.data);
  if(!initial.running||!initial.hostPid||!initial.shellPid||
     !initial.launchedPids||!initial.startedAt){
    throw Object.assign(new Error('Private desktop not running.'),{
      code:'PRIVATE_PROCESS_AUDIT_NOT_RUNNING',
    });
  }
  const stdout=await runReadOnlyWindowsAuditPowerShell(windowsCimScript);
  const second=await executeWindowsPrivateDesktopCapability(
    'windows.private_desktop.status',{},
  ) as{data:unknown};
  const latest=Status.parse(second.data);
  if(!latest.running||latest.startedAt!==initial.startedAt||
    latest.hostPid!==initial.hostPid||latest.shellPid!==initial.shellPid){
    throw Object.assign(new Error('Private desktop changed during process audit.'),{
      code:'PRIVATE_PROCESS_AUDIT_STATE_CHANGED',
    });
  }
  return assessWindowsPrivateProcessAncestry(
    latest,Snapshot.parse(JSON.parse(stdout.replace(/^\uFEFF/,''))),
  );
}
