import {spawn} from 'node:child_process';
import * as z from 'zod';
import {privateDesktopPowerShellEnvironment} from './windows-private-desktop.js';

export const PrivateDisplayBackendProbeSchema=z.object({
  platform:z.literal('win32'),
  hypervisorPresent:z.boolean().nullable(),
  vmManagementServiceRunning:z.boolean().nullable(),
  hyperVModuleAvailable:z.boolean(),
  effectiveLocalAdministrator:z.boolean().nullable(),
  effectiveHyperVAdministrator:z.boolean().nullable(),
  vmManagementAccessGuidance:z.enum([
    'VM_MANAGEMENT_AVAILABLE',
    'HYPERV_TOOLS_MISSING',
    'REVIEW_AUTHORIZED_HYPERV_PERMISSIONS',
  ]),
  vmInventoryStatus:z.enum(['available','access_denied_or_unavailable','not_installed']),
  vmCount:z.number().int().nonnegative().nullable(),
  runningVmCount:z.number().int().nonnegative().nullable(),
  candidateHostVirtualDisplayAdapters:z.array(z.object({
    name:z.string().min(1).max(256),
    driverVersion:z.string().max(128).nullable(),
  })).max(16),
  hostDisplayTopologyShared:z.literal(true),
  isolatedAiDisplayBackendReady:z.literal(false),
  osDisplaysProvisioned:z.literal(false),
  touchesHostDisplaySettings:z.literal(false),
  pendingRequirement:z.literal('ISOLATED_GUEST_DISPLAY_PROVIDER_AND_AUTHORIZATION'),
}).strict().superRefine((v,ctx)=>{
  const expectedGuidance=!v.hyperVModuleAvailable
    ?'HYPERV_TOOLS_MISSING'
    :v.vmInventoryStatus==='available'
      ?'VM_MANAGEMENT_AVAILABLE'
      :'REVIEW_AUTHORIZED_HYPERV_PERMISSIONS';
  if(v.vmManagementAccessGuidance!==expectedGuidance){
    ctx.addIssue({code:'custom',path:['vmManagementAccessGuidance'],
      message:'VM permission guidance is inconsistent with actual inventory access.'});
  }
  if(v.vmInventoryStatus==='available'){
    if(v.vmCount===null||v.runningVmCount===null||
      v.runningVmCount>v.vmCount){
      ctx.addIssue({code:'custom',path:['vmCount'],
        message:'Available VM inventory must report consistent counts.'});
    }
  } else if(v.vmCount!==null||v.runningVmCount!==null){
    ctx.addIssue({code:'custom',path:['vmCount'],
      message:'Unavailable VM inventory must not invent VM counts.'});
  }
});

export type WindowsPrivateDisplayBackendProbe=z.infer<
  typeof PrivateDisplayBackendProbeSchema
>;

export const privateDisplayBackendReadOnlyProbeScript=String.raw`
$ErrorActionPreference='Stop'
$vmInventoryStatus='not_installed'
$vmCount=$null
$runningCount=$null
$hypervisorPresent=$null
$vmmsRunning=$null
$virtualAdapters=@()
$effectiveLocalAdministrator=$null
$effectiveHyperVAdministrator=$null
try{
  # WindowsPrincipal.IsInRole tests ENABLED groups in this process token.
  # Being listed in BUILTIN Administrators as a deny-only UAC group
  # does NOT grant Hyper-V management permissions to the running Agent.
  $identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()
  $principal=[System.Security.Principal.WindowsPrincipal]::new($identity)
  $effectiveLocalAdministrator=$principal.IsInRole(
    [System.Security.Principal.WindowsBuiltInRole]::Administrator
  )
  $hypervSid=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-578')
  $effectiveHyperVAdministrator=$principal.IsInRole($hypervSid)
}catch{}
try {
  $computer=Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
  $hypervisorPresent=[bool]$computer.HypervisorPresent
}catch{}
try {
  $vmms=Get-Service -Name vmms -ErrorAction Stop
  $vmmsRunning=($vmms.Status -eq [System.ServiceProcess.ServiceControllerStatus]::Running)
}catch{}
$hyperVModuleAvailable=$false
try {
  $hyperVModuleAvailable=($null -ne (Get-Command Get-VM -ErrorAction SilentlyContinue))
}catch{}
if($hyperVModuleAvailable){
  try {
    $vmList=@(Get-VM -ErrorAction Stop)
    $vmInventoryStatus='available'
    $vmCount=$vmList.Count
    $runningCount=@($vmList|Where-Object {$_.State -eq 'Running'}).Count
  }catch{
    # Distinguish lack of VM inventory authorization from an actual zero-VM
    # result. Never return names, paths, VHDs or other guest metadata.
    $vmInventoryStatus='access_denied_or_unavailable'
    $vmCount=$null
    $runningCount=$null
  }
}
try {
  $video=@(Get-CimInstance Win32_VideoController -ErrorAction Stop)
  $virtualAdapters=@($video | Where-Object {
    ([string]$_.Name) -match '(?i)(virtual display|indirect display|parsec)'
  } | Select-Object -First 16 | ForEach-Object {
    [pscustomobject]@{
      name=([string]$_.Name).Substring(0,[Math]::Min(256,([string]$_.Name).Length))
      driverVersion=$(if($_.DriverVersion){[string]$_.DriverVersion}else{$null})
    }
  })
}catch{}
$vmManagementAccessGuidance='REVIEW_AUTHORIZED_HYPERV_PERMISSIONS'
if(-not $hyperVModuleAvailable){
  $vmManagementAccessGuidance='HYPERV_TOOLS_MISSING'
}elseif($vmInventoryStatus -eq 'available'){
  $vmManagementAccessGuidance='VM_MANAGEMENT_AVAILABLE'
}
[pscustomobject]@{
  platform='win32'
  hypervisorPresent=$hypervisorPresent
  vmManagementServiceRunning=$vmmsRunning
  hyperVModuleAvailable=$hyperVModuleAvailable
  effectiveLocalAdministrator=$effectiveLocalAdministrator
  effectiveHyperVAdministrator=$effectiveHyperVAdministrator
  vmManagementAccessGuidance=$vmManagementAccessGuidance
  vmInventoryStatus=$vmInventoryStatus
  vmCount=$vmCount
  runningVmCount=$runningCount
  candidateHostVirtualDisplayAdapters=@($virtualAdapters)
  hostDisplayTopologyShared=$true
  isolatedAiDisplayBackendReady=$false
  osDisplaysProvisioned=$false
  touchesHostDisplaySettings=$false
  pendingRequirement='ISOLATED_GUEST_DISPLAY_PROVIDER_AND_AUTHORIZATION'
} | ConvertTo-Json -Depth 5 -Compress
`;

/**
 * Safe capability discovery. Even a host with Hyper-V + a virtual display
 * adapter has NOT proved independent guest monitor isolation.
 */
export async function inspectWindowsPrivateDisplayBackend():Promise<{
  data:WindowsPrivateDisplayBackendProbe;
}>{
  if(process.platform!=='win32'){
    throw Object.assign(new Error('Windows display backend probe requires Windows.'),
      {code:'WINDOWS_REQUIRED'});
  }
  const stdout=await new Promise<string>((resolve,reject)=>{
    const child=spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',[
      '-NoLogo','-NoProfile','-NonInteractive','-Command',
      privateDisplayBackendReadOnlyProbeScript,
    ],{windowsHide:true,stdio:['ignore','pipe','pipe'],
      shell:false,env:privateDesktopPowerShellEnvironment()});
    let data='',errors='';
    const timer=setTimeout(()=>{
      child.kill();
      reject(Object.assign(new Error('Windows backend probe timed out.'),
        {code:'PRIVATE_DISPLAY_BACKEND_PROBE_TIMEOUT'}));
    },20_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data',(part:string)=>{
      data+=part;
      if(data.length>128_000)child.kill();
    });
    child.stderr.on('data',(part:string)=>{
      errors+=part;
      if(errors.length>16_000)child.kill();
    });
    child.once('error',(err)=>{
      clearTimeout(timer);reject(err);
    });
    child.once('close',(code)=>{
      clearTimeout(timer);
      if(code!==0||data.length>128_000){
        reject(Object.assign(
          new Error('Read-only Windows display backend probe could not complete.'),
          {code:'PRIVATE_DISPLAY_BACKEND_PROBE_FAILED'},
        ));
        return;
      }
      resolve(data.trim().replace(/^\uFEFF/,''));
    });
  });
  let json:unknown;
  try{json=JSON.parse(stdout);}
  catch{
    throw Object.assign(new Error('Display backend returned invalid JSON.'),
      {code:'PRIVATE_DISPLAY_BACKEND_PROBE_INVALID'});
  }
  return {data:PrivateDisplayBackendProbeSchema.parse(json)};
}
