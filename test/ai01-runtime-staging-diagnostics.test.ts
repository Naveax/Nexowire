import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

const installer=path.join(process.cwd(),'scripts','Install-Nexowire-SystemHubRuntime.ps1');
const source=readFileSync(installer,'utf8');
const win=process.platform==='win32';
const shell=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');

test('AI-01 installer emits precise stage failure without changing fail-closed trust',()=>{
  const ordered=[
    "$phase='CHECK_PARENT'",
    "$phase='SET_NEW_PARENT_DACL'",
    "$phase='PIN_NEW_PARENT_OWNER'",
    "$phase='VERIFY_PARENT_ACL'",
    "$phase='CREATE_PRIVATE_STAGE'",
    "$phase='SET_PRIVATE_STAGE_DACL'",
    "$phase='COPY_RUNTIME'",
    "$phase='VERIFY_STAGED_HASH'",
    "$phase='PIN_STAGED_OWNER'",
    "$phase='VERIFY_STAGED_ACL'",
    "$phase='PROMOTE_RUNTIME'",
    "throw ('AI01_INSTALL_PHASE_'+$phase+': '+$reason)",
  ];
  let cursor=-1;
  for(const marker of ordered){
    const next=source.indexOf(marker,cursor+1);
    assert.ok(next>cursor,'Missing/misordered protected stage '+marker);
    cursor=next;
  }
  assert.match(source,/Assert-PrivateTree \$parent/);
  assert.match(source,/Assert-PrivateTree \$staging/);
  assert.match(source,/if\(\$copied\.digest -cne \$tree\.digest\)/);
  assert.match(source,/\(\$stageItem\.Attributes -band \[IO\.FileAttributes\]::ReparsePoint\) -eq 0/);
  assert.match(source,/AI01_ADMINISTRATOR_TOKEN_REQUIRED/);
  assert.match(source,/AI01_TARGET_RACE/);
  assert.match(source,/TARGET_EXISTENCE_UNVERIFIED/);
  assert.match(source,/taskChanged=\$false;sqliteChanged=\$false/);
});

test('AI-01 ACL verifier casts FileSystemRights before Int64 bitmask (real Windows PowerShell 5.1)',{
  skip:!win,
},()=>{
  assert.match(source,/\(\[int64\]\$ace\.FileSystemRights -band \$writeMask\)/);
  assert.doesNotMatch(source,/\(\$ace\.FileSystemRights -band \$writeMask\)/);
  const command=[
    "$ErrorActionPreference='Stop'",
    "$acl=Get-Acl -LiteralPath $env:TEMP",
    "$mask=[int64]0x40000000 -bor [int64]0x10000000 -bor [int64]0x10000 -bor [int64]0x40000 -bor [int64]0x80000 -bor [int64]2 -bor [int64]4",
    "$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))",
    "if($rules.Count -lt 1){throw 'NO_ACL_RULES'}",
    "$count=0;foreach($ace in $rules){$v=([int64]$ace.FileSystemRights -band $mask);if($v -ne 0){$count++}}",
    "Write-Output ('ACL_INT64_CAST_PASS='+$count)",
  ].join('; ');
  const result=spawnSync(shell,['-NoProfile','-NonInteractive','-Command',command],{
    encoding:'utf8',windowsHide:true,timeout:15000,
  });
  assert.equal(result.status,0,result.stderr+' '+result.stdout);
  assert.match(result.stdout,/ACL_INT64_CAST_PASS=\d+/);
});

test('AI-01 runtime powershell 5.1 source parses without running installer',{
  skip:!win,
},()=>{
  const safe=installer.replaceAll("'","''");
  const cmd=`$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${safe}',[ref]$t,[ref]$e);if($e.Count -gt 0){$e|ForEach-Object{$_.Message};exit 1}`;
  const r=spawnSync(shell,['-NoProfile','-NonInteractive','-Command',cmd],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(r.status,0,r.stderr+' '+r.stdout);
});

test('AI-01 Plan remains read-only and never stages or claims readiness without pin',{
  skip:!win,
},()=>{
  const target='C:\\Program Files\\Nexowire\\SystemHub';
  const before=existsSync(target);
  const r=spawnSync(shell,['-NoProfile','-NonInteractive','-File',installer,'-Action','Plan'],{
    encoding:'utf8',windowsHide:true,timeout:20000,
  });
  assert.equal(r.status,0,r.stderr);
  const plan=JSON.parse(r.stdout);
  assert.equal(plan.action,'Plan');
  assert.equal(plan.ready,false);
  assert.ok(plan.blockers.includes('SOURCE_DIRECTORY_REQUIRED'));
  assert.ok(plan.blockers.includes('PINNED_TREE_SHA256_REQUIRED'));
  assert.equal(existsSync(target),before,'Plan must never stage or mutate Program Files');
});
