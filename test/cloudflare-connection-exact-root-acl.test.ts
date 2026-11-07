import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {windowsConnectionControllerSourceForTest} from '../src/mcp/cloudflare-connection-lifecycle.js';

const PS='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
function powershell(script:string,env:NodeJS.ProcessEnv){
  return spawnSync(PS,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
    Buffer.from(script,'utf16le').toString('base64')],{
    windowsHide:true,encoding:'utf8',timeout:25000,env:{...process.env,...env},
  });
}

// Only a disposable randomized directory is touched; no scheduled task created.
// A preexisting unexpected ACE must not use the exact-ACL reinstall shortcut.
test('Cloudflare exact-ACL shortcut cannot accept an extra writable ACE',{
  skip:process.platform!=='win32',timeout:45000,
},async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'nw-cf-acl-extra-'));
  const launcher=path.join(root,'launch.ps1');
  await writeFile(launcher,'# disposable fake launcher\n');
  await writeFile(launcher+'.sha256','A'.repeat(64)+'\n');
  t.after(async()=>{await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
  const env={NW_FIXTURE_ROOT:root};
  const setup=powershell([
    "$ErrorActionPreference='Stop'",
    "$p=$env:NW_FIXTURE_ROOT",
    "$a=Get-Acl -LiteralPath $p -ErrorAction Stop",
    "$a.SetAccessRuleProtection($true,$false)",
    "foreach($ace in @($a.Access)){[void]$a.RemoveAccessRuleAll($ace)}",
    "$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit",
    "foreach($sid in @($owner.Value,'S-1-5-18','S-1-5-32-544')){",
    " $s=[Security.Principal.SecurityIdentifier]::new($sid)",
    " $r=[Security.AccessControl.FileSystemAccessRule]::new($s,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)",
    " [void]$a.AddAccessRule($r)",
    "}",
    "$everyone=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')",
    "$extra=[Security.AccessControl.FileSystemAccessRule]::new($everyone,[Security.AccessControl.FileSystemRights]::Write,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)",
    "[void]$a.AddAccessRule($extra)",
    "$a.SetOwner($owner)",
    "Set-Acl -LiteralPath $p -AclObject $a -ErrorAction Stop",
  ].join('\n'),env);
  assert.equal(setup.status,0,'fixture ACL initialization failed: '+(setup.stderr??'').slice(-350));
  const precondition=powershell([
    "$ErrorActionPreference='Stop'",
    "$a=Get-Acl -LiteralPath $env:NW_FIXTURE_ROOT",
    "$extras=@($a.Access|Where-Object {",
    "  $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-1-0'",
    "})",
    "if($extras.Count -lt 1 -or !$a.AreAccessRulesProtected){exit 3}",
  ].join('\n'),env);
  assert.equal(precondition.status,0,'fixture must contain the protected extra ACE');

  const result=powershell(windowsConnectionControllerSourceForTest(),{
    NEXOWIRE_CONNECTION_ACTION:'protect',
    NEXOWIRE_CONNECTION_TASK:'Nexowire CF ACL Negative '+randomUUID(),
    NEXOWIRE_CONNECTION_LAUNCHER:launcher,
  });
  const audit=powershell([
    "$ErrorActionPreference='Stop'",
    "$a=Get-Acl -LiteralPath $env:NW_FIXTURE_ROOT",
    "$aces=@($a.Access|Where-Object {",
    "  $sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value",
    "  $sid -eq 'S-1-1-0' -and $_.AccessControlType -eq 'Allow'",
    "})",
    "[pscustomobject]@{broadAllow=($aces.Count -gt 0);protected=$a.AreAccessRulesProtected}|ConvertTo-Json -Compress",
  ].join('\n'),env);
  assert.equal(audit.status,0,'ACL readback failed: '+(audit.stderr??'').slice(-350));
  const readback=JSON.parse(audit.stdout.trim()) as {broadAllow:boolean;protected:boolean};
  assert.equal(readback.protected,true);
  if(result.status===0){
    assert.equal(readback.broadAllow,false,'controller accepted an extra Everyone allow ACE');
  }else{
    assert.match(result.stderr??'',/CONNECTION_PROTECT_ACL_COMMIT|CONNECTION_PROTECT_ACL_PREPARE/,
      'the controller must explicitly refuse a non-exact protected ACL');
  }
});
