import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const script=path.resolve('scripts/backup-legacy-scheduled-task.ps1');
const source=readFileSync(script,'utf8');

test('legacy backup only encrypts task XML in memory and never invokes task mutation',()=>{
  assert.match(source,/Export-ScheduledTask/);
  assert.match(source,/ProtectedData\]::Protect/);
  assert.match(source,/ProtectedData\]::Unprotect/);
  assert.match(source,/CurrentUser/);
  assert.match(source,/FileMode\]::CreateNew/);
  assert.match(source,/RECOVERY_UNTRUSTED_WRITE_GRANT/);
  assert.match(source,/safeToCutover=\$false/);
  assert.match(source,/plaintextWrittenToDisk=\$false/);
  for(const mutation of ['Register-ScheduledTask','Unregister-ScheduledTask','Set-ScheduledTask',
    'Stop-ScheduledTask','Start-ScheduledTask','Start-Process','Set-Acl','icacls.exe',
    'schtasks.exe','Set-Content','Out-File','Import-Clixml']){
    assert.equal(source.includes(mutation),false,mutation);
  }
});

test('recovery script syntax and invalid backup traversal fail closed on Windows',{
  skip:process.platform!=='win32',
},()=>{
  const powershell='powershell.exe';
  const expr='$file=\''+script.replaceAll("'","''")+'\'';
  const check=spawnSync(powershell,['-NoProfile','-NonInteractive','-Command',expr+
    ';$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){exit 9}'],{
    encoding:'utf8',timeout:20000,windowsHide:true,
  });
  assert.equal(check.status,0,check.stderr+' '+check.stdout);
  const bad=spawnSync(powershell,['-NoProfile','-NonInteractive','-File',script,
    '-Mode','Verify','-BackupFile','..\\secret.xml'],{
    encoding:'utf8',timeout:15000,windowsHide:true,
  });
  assert.notEqual(bad.status,0);
  assert.doesNotMatch(bad.stdout,/xml version|Actions|Arguments|Password/i);
});

test('current-user DPAPI encrypts and verifies without persistence on Windows',{
  skip:process.platform!=='win32',
},()=>{
  const expression=[
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    "$x=[Text.Encoding]::UTF8.GetBytes('synthetic-test-not-real-task')",
    "$entropy=[Text.Encoding]::UTF8.GetBytes('Nexowire.LegacyTask.Recovery.CurrentUser.v1')",
    '$y=[Security.Cryptography.ProtectedData]::Protect($x,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '$z=[Security.Cryptography.ProtectedData]::Unprotect($y,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
    "if([Convert]::ToBase64String($x) -ne [Convert]::ToBase64String($z)){exit 7}",
    '[array]::Clear($x,0,$x.Length)',
    '[array]::Clear($z,0,$z.Length)',
  ].join(';');
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',expression],{
    encoding:'utf8',timeout:20000,windowsHide:true,
  });
  assert.equal(result.status,0,result.stderr+' '+result.stdout);
});
