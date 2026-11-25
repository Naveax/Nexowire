import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {renderMachineCutoverScript} from '../../src/update/machine-update.js';

const newRoot='C:\\ProgramData\\Nexowire\\versions\\1.0.5-012345abcdef';
const oldRoot='C:\\ProgramData\\Nexowire\\versions\\1.0.4-012345abcdef';
const script=renderMachineCutoverScript({version:'1.0.5',buildId:'1.0.5-012345abcdef',targetRoot:newRoot});
const helpers=script.slice(script.indexOf('function Get-ActivationTask('),script.indexOf('function Wait-Service('));
const q=(s:string)=>"'"+s.replaceAll("'","''")+"'";
const env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(PATH|PSMODULEPATH|SYSTEMROOT|WINDIR)$/i.test(k))),
 SystemRoot:'C:\\Windows',windir:'C:\\Windows',PATH:'C:\\Windows\\System32;C:\\Windows',
 PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'};
const exe='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
function run(root:string,name:string,body:string){
 const file=path.join(root,name+'.ps1');
 writeFileSync(file,'\ufeff'+body,'utf8');
 const child=spawnSync(exe,['-NoLogo','-NoProfile','-NonInteractive','-File',file],{
  cwd:'C:\\Windows\\System32',env,encoding:'utf8',timeout:30000,maxBuffer:256*1024,windowsHide:true,
 });
 assert.equal(child.error,undefined,JSON.stringify({status:child.status,signal:child.signal,stderr:child.stderr,stdout:child.stdout}));
 assert.equal(child.signal,null);
 assert.equal(child.status,0,child.stderr+'\n'+child.stdout);
 return child.stdout.trim();
}
const bootHeader=[
 "$ErrorActionPreference='Stop'",
 "Import-Module -Name 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1' -ErrorAction Stop",
 "Import-Module -Name 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1' -ErrorAction Stop",
];
test('scheduler fence is persistent and cannot be cleared or enabled from the failure tail',()=>{
 const tail=script.slice(script.indexOf('Start-Sleep -Seconds 3'));
 const at=(s:string)=>{const i=tail.indexOf(s);assert.ok(i>=0,s);return i};
 assert.ok(at('New-ActivationFence')<at('Disable-ActivationTask $BootTask'));
 assert.ok(at('Disable-ActivationTask $BrokerTask')<at('Stop-ScheduledTask -TaskName $BootTask'));
 assert.ok(at('Assert-ActivationDisabled $BrokerTask')<at('Patch-Launcher $BootLauncher'));
 assert.ok(at('Patch-Launcher $BrokerLauncher')<at('Enable-ForwardActivation $BootTask'));
 assert.ok(at("Write-Status 'succeeded'")<at('Clear-ActivationFence'));
 const failure=tail.slice(tail.lastIndexOf('\r\n} catch {\r\n'));
 assert.match(failure,/Disable-ActivationTask/);
 assert.match(failure,/ACTIVATION_FENCE_UNVERIFIED/);
 assert.doesNotMatch(failure,/Enable-ForwardActivation|Clear-ActivationFence|Start-ScheduledTask/);
 assert.match(helpers,/\[IO\.FileMode\]::CreateNew/);
 assert.match(helpers,/\$stream\.Flush\(\$true\)/);
});
test('actual persisted admission rejects duplicate creation and forward hash rejects stale or mixed launchers',{skip:process.platform!=='win32'},()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'nx-ai05-fence-files-'));
 try{
  const marker=path.join(root,'machine-activation-fence.json'),boot=path.join(root,'boot.ps1'),broker=path.join(root,'broker.ps1');
  const launcher=(r:string)=>"& '"+r+"\\runtime\\node.exe' '"+r+"\\app\\dist\\src\\cli.js' 'http'\r\n";
  writeFileSync(boot,launcher(newRoot));writeFileSync(broker,launcher(oldRoot));
  const init=[...bootHeader,'$ActivationFence='+q(marker),'$NewRoot='+q(newRoot),"$BuildId='1.0.5-012345abcdef'",
   '$BootLauncher='+q(boot),'$BrokerLauncher='+q(broker),'$hasBoot=$true','$hasBroker=$true',
   '$fenceOwned=$false','$fenceHash=$null',"$fenceIdentities=@{Boot='fixture-owner';Broker='fixture-owner'}",'$forwardHashes=@{}',helpers];
  const first=run(root,'first',[...init,'New-ActivationFence',
   '$forwardHashes[$BootLauncher]=Read-ForwardLauncherHash $BootLauncher',
   'try{[void](Read-ForwardLauncherHash $BrokerLauncher);throw "UNEXPECTED"}catch{if($_.Exception.Message -ne "MACHINE_UPDATE_FORWARD_LAUNCHER_UNVERIFIED"){throw}}',
   '[Console]::WriteLine("PERSISTED")'].join('\r\n'));
  assert.equal(first,'PERSISTED');const before=readFileSync(marker);
  const next=run(root,'second',[...init,
   'try{New-ActivationFence;throw "UNEXPECTED"}catch{if($fenceOwned -or $_.Exception.Message -eq "UNEXPECTED"){throw}}',
   'try{Clear-ActivationFence;throw "UNEXPECTED"}catch{if($_.Exception.Message -ne "MACHINE_UPDATE_ACTIVATION_FENCE_LOST"){throw}}',
   '[Console]::WriteLine("DENIED")'].join('\r\n'));
  assert.equal(next,'DENIED');assert.deepEqual(readFileSync(marker),before);
  assert.equal(readFileSync(broker,'utf8'),launcher(oldRoot));
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('hosted Windows scheduler retains Disabled across independent process and denies activation of inert test task',{
 skip:process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted',
},()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'nx-ai05-real-task-fence-'));
 const name='Nexowire-AI05-Fence-'+randomUUID();
 const marker=path.join(root,'machine-activation-fence.json');
 const header=[...bootHeader,
  "Import-Module -Name 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\ScheduledTasks\\ScheduledTasks.psd1' -ErrorAction Stop",
  "if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted'){throw 'HOSTED_ONLY'}",
  '$name='+q(name),
  '$ActivationFence='+q(marker),'$NewRoot='+q(newRoot),"$BuildId='1.0.5-012345abcdef'",
  '$fenceOwned=$false','$fenceHash=$null','$fenceIdentities=@{}',
  // Fixture identity validation restricts all mutations to a fresh inert task.
  // Real Nexowire task identity checks are covered by the separate tests.
  'function Assert-TaskIdentity {param([string]$n,[string]$launcher,[bool]$system,[switch]$ReturnTask)',
  ' if($n -cne $name){throw "FOREIGN_TASK"}',
  " $t=Get-ScheduledTask -TaskName $n -TaskPath '\\' -ErrorAction Stop",
  " if(@($t.Actions).Count -ne 1 -or [string]$t.Actions[0].Execute -cne 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -or [string]$t.Actions[0].Arguments -cne '-NoProfile -NonInteractive -Command \"exit 0\"'){throw 'FOREIGN_ACTION'}",
  ' if($ReturnTask){return $t}',
  '}',helpers];
 try{
  const result=run(root,'disable',[...header,
   '$principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited',
   "$action=New-ScheduledTaskAction -Execute 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -Argument '-NoProfile -NonInteractive -Command \"exit 0\"'",
   '$trigger=New-ScheduledTaskTrigger -AtStartup',
   "Register-ScheduledTask -TaskName $name -TaskPath '\\' -Action $action -Trigger $trigger -Principal $principal -ErrorAction Stop|Out-Null",
   'Capture-ActivationTask $name "fixture" $false',
   'New-ActivationFence',
   'Disable-ActivationTask $name "fixture" $false',
   'Assert-ActivationDisabled $name "fixture" $false',
   '[Console]::WriteLine("DISABLED")'].join('\r\n'));
  assert.equal(result,'DISABLED');assert.equal(existsSync(marker),true);
  const before=readFileSync(marker);
  const result2=run(root,'fresh-readback',[...header,
   '$record=[IO.File]::ReadAllText($ActivationFence)|ConvertFrom-Json',
   '$fenceIdentities[$name]=[string]$record.principals.PSObject.Properties[$name].Value',
   'Assert-ActivationDisabled $name "fixture" $false',
   // Scheduler itself must refuse a direct activation of the disabled task;
   // the task's action is inert even if the assertion exposes an OS defect.
   '$denied=$false',
   "try{Start-ScheduledTask -TaskName $name -TaskPath '\\' -ErrorAction Stop}catch{$denied=$true}",
   'if(-not $denied){throw "DISABLED_TASK_START_ACCEPTED"}',
   'Assert-ActivationDisabled $name "fixture" $false',
   '[Console]::WriteLine("RETAINED_DISABLED")'].join('\r\n'));
  assert.equal(result2,'RETAINED_DISABLED');assert.deepEqual(readFileSync(marker),before);
 }finally{
  try{
   run(root,'cleanup',[...header,
    "if(@(Get-ScheduledTask -TaskPath '\\' -ErrorAction Stop|Where-Object{$_.TaskName -ceq $name}).Count -eq 1){",
    " [void](Assert-TaskIdentity $name 'fixture' $false -ReturnTask)",
    " Unregister-ScheduledTask -TaskName $name -TaskPath '\\' -Confirm:$false -ErrorAction Stop",
    " if(@(Get-ScheduledTask -TaskPath '\\' -ErrorAction Stop|Where-Object{$_.TaskName -ceq $name}).Count -ne 0){throw 'FIXTURE_CLEANUP_FAILED'}",
    '}','[Console]::WriteLine("CLEANED")'].join('\r\n'));
  }finally{rmSync(root,{recursive:true,force:true});}
 }
});
