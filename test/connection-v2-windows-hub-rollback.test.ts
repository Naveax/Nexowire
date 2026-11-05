import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// This test owns ONLY its randomly named disposable Task Scheduler fixture.
// Never run on a self-hosted Actions runner or on NAVEAX / Work-PC.
const hosted=process.platform==='win32' && process.env.GITHUB_ACTIONS==='true' &&
  process.env.RUNNER_OS==='Windows' && process.env.RUNNER_ENVIRONMENT==='github-hosted';
const manualVm=process.platform==='win32' && process.env.GITHUB_ACTIONS!=='true' &&
  process.env.NEXOWIRE_V2_04_DISPOSABLE_WINDOWS_VM==='YES';
const enabled=hosted||manualVm;
const PS='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

test('V2-04 native VM guarded rollback preserves task principal, triggers and synthetic credential',{
  skip:!enabled,timeout:150000,
},async t=>{
  const name='Nexowire V204 Rollback VM '+randomUUID();
  const root=await mkdtemp(path.join(os.tmpdir(),'nwx-v204-rollback-'));
  const credential=path.join(root,'fixture-credential.txt');
  await writeFile(credential,'synthetic-credential-unchanged');
  const invoke=(lines:string[],xml?:string)=>{
    const input=lines.join('\n');
    return spawnSync(PS,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(input,'utf16le').toString('base64')],{
      windowsHide:true,encoding:'utf8',timeout:30000,
      env:{...process.env,NWX_V204_NAME:name,...(xml?{NWX_V204_ORIGINAL_XML:xml}:{})},
    });
  };
  const install=invoke([
    "$ErrorActionPreference='Stop'",
    "Import-Module 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\ScheduledTasks\\ScheduledTasks.psd1' -ErrorAction Stop",
    "$u=[Security.Principal.WindowsIdentity]::GetCurrent().Name",
    "$a=New-ScheduledTaskAction -Execute 'C:\\Windows\\System32\\cmd.exe' -Argument '/c exit 0'",
    "$p=New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Limited",
    "$tr=New-ScheduledTaskTrigger -AtLogOn -User $u",
    "$s=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)",
    "Register-ScheduledTask -TaskName $env:NWX_V204_NAME -TaskPath '\\' -Action $a -Principal $p -Trigger $tr -Settings $s -ErrorAction Stop | Out-Null",
  ]);
  // Keep the cleanup confined to the exact random fixture even if an assertion fails.
  if(install.status===0){
    t.after(()=>{
      const remove=invoke([
        "$ErrorActionPreference='Stop'",
        "Unregister-ScheduledTask -TaskName $env:NWX_V204_NAME -TaskPath '\\' -Confirm:$false -ErrorAction Stop",
      ]);
      assert.equal(remove.status,0,'fixture-only unregister');
    });
  }
  t.after(async()=>{await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:150});});
  assert.equal(install.status,0,'fixture-only registration must succeed');

  const exportTask=()=>{
    const result=invoke([
      "$ErrorActionPreference='Stop'",
      "Export-ScheduledTask -TaskName $env:NWX_V204_NAME -TaskPath '\\' -ErrorAction Stop",
    ]);
    assert.equal(result.status,0,'native XML export');
    return result.stdout.trim();
  };
  const readState=()=>{
    const result=invoke([
      "$ErrorActionPreference='Stop'",
      "$t=Get-ScheduledTask -TaskName $env:NWX_V204_NAME -TaskPath '\\' -ErrorAction Stop",
      "$a=@($t.Actions);$tr=@($t.Triggers)",
      "[pscustomobject]@{actionCount=$a.Count;execute=[string]$a[0].Execute;args=[string]$a[0].Arguments;workingDirectory=[string]$a[0].WorkingDirectory;userId=[string]$t.Principal.UserId;logon=[string]$t.Principal.LogonType;runLevel=[string]$t.Principal.RunLevel;triggerCount=$tr.Count;triggerType=[string]$tr[0].CimClass.CimClassName;triggerUser=[string]$tr[0].UserId;multiple=[string]$t.Settings.MultipleInstances;restartCount=[int]$t.Settings.RestartCount;restartInterval=[string]$t.Settings.RestartInterval} | ConvertTo-Json -Compress",
    ]);
    assert.equal(result.status,0,'native task readback');
    return JSON.parse(result.stdout.trim()) as Record<string,string|number>;
  };
  const originalXml=exportTask();
  assert.ok(originalXml.includes('<Task'));
  const original=readState();
  const xmlSha256=createHash('sha256').update(originalXml).digest('hex');
  const setAction=(execute:string,argument:string)=>{
    const result=invoke([
      "$ErrorActionPreference='Stop'",
      "$a=New-ScheduledTaskAction -Execute '"+execute.replaceAll("'","''")+"' -Argument '"+argument.replaceAll("'","''")+"'",
      "Set-ScheduledTask -TaskName $env:NWX_V204_NAME -TaskPath '\\' -Action $a -ErrorAction Stop | Out-Null",
    ]);
    assert.equal(result.status,0,'modify only disposable fixture');
  };
  const guardedRestore=[
    "$ErrorActionPreference='Stop'",
    "$t=Get-ScheduledTask -TaskName $env:NWX_V204_NAME -TaskPath '\\' -ErrorAction Stop",
    "$a=@($t.Actions);$tr=@($t.Triggers)",
    "if($a.Count -ne 1 -or $a[0].Execute -cne 'C:\\Windows\\System32\\cmd.exe' -or $a[0].Arguments -cne '/c exit 1'){throw 'V204_FOREIGN_ACTION'}",
    "if([string]$t.Principal.LogonType -ne 'Interactive' -or [string]$t.Principal.RunLevel -ne 'Limited'){throw 'V204_FOREIGN_PRINCIPAL'}",
    "if($tr.Count -ne 1 -or [string]$tr[0].CimClass.CimClassName -ne 'MSFT_TaskLogonTrigger'){throw 'V204_FOREIGN_TRIGGER'}",
    "if([string]$t.Settings.MultipleInstances -ne 'IgnoreNew'){throw 'V204_FOREIGN_INSTANCE_POLICY'}",
    "Register-ScheduledTask -TaskName $env:NWX_V204_NAME -TaskPath '\\' -Xml $env:NWX_V204_ORIGINAL_XML -Force -ErrorAction Stop | Out-Null",
  ];
  setAction('C:\\Windows\\System32\\notepad.exe','/A');
  const foreignState=readState();
  const rejected=invoke(guardedRestore,originalXml);
  assert.notEqual(rejected.status,0,'foreign task action must fail closed');
  assert.deepEqual(readState(),foreignState,'foreign definition remains untouched');

  setAction('C:\\Windows\\System32\\cmd.exe','/c exit 1');
  const restored=invoke(guardedRestore,originalXml);
  assert.equal(restored.status,0,'guarded fixture rollback succeeds');
  assert.deepEqual(readState(),original,'original principal/action/triggers/settings restored');
  assert.equal(await readFile(credential,'utf8'),'synthetic-credential-unchanged');
  process.stdout.write(JSON.stringify({event:'V2_04_NATIVE_VM_ROLLBACK_PASS',
    taskXmlSha256:xmlSha256,foreignActionRefused:true,
    principalActionTriggersRestored:true,credentialFixturePreserved:true})+'\n');
});
