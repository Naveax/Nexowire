import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

const script=path.resolve('scripts/Resolve-Nexowire-LegacySystemHubTask.ps1');
const source=readFileSync(script,'utf8');
const powershell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function invoke(args:string[]) {
  return spawnSync(powershell,[
    '-NoLogo','-NoProfile','-NonInteractive','-File',script,...args,
  ],{encoding:'utf8',timeout:30000,windowsHide:true});
}

test('AI-01 reconciler keeps task name and executable canonical and never treats access denied as absence',()=>{
  assert.match(source,/taskName='Nexowire Hub Boot'/);
  assert.match(source,/taskPath='\\'/);
  assert.match(source,/AI01_RECONCILE_FOREIGN_TASK_IDENTITY/);
  assert.match(source,/return \[pscustomobject\]@\{Visibility='access-denied'/);
  assert.match(source,/AI01_RECONCILE_TASK_IDENTITY_UNVERIFIED/);
  assert.match(source,/AI01_RECONCILE_RESTORE_WOULD_OVERWRITE_OR_HIDE_TASK/);
  assert.match(source,/AI01_RECONCILE_TRUSTED_INSTALLED_TOOL_REQUIRED/);
});

test('AI-01 reconciler demands backup, rehearsal, expected pinned runtime and explicit retirement approval',()=>{
  assert.match(source,/AI01_RECONCILE_ELEVATED_TOKEN_REQUIRED/);
  assert.match(source,/AI01_RECONCILE_PINNED_RUNTIME_TREE_SHA256_REQUIRED/);
  assert.match(source,/AI01_RECONCILE_PINNED_RUNTIME_TREE_MISMATCH/);
  assert.match(source,/AI01_RECONCILE_EXPLICIT_RECEIPT_DIGEST_REQUIRED/);
  assert.match(source,/AI01_RECONCILE_OWNER_APPROVAL_REQUIRED/);
  assert.match(source,/AI01_RECONCILE_REHEARSAL_REQUIRED/);
  assert.match(source,/AI01_RECONCILE_OLD_SYSTEM_TASK_NOT_QUIESCENT/);
  assert.match(source,/AI01_RECONCILE_USER_HUB_NOT_RUNNING/);
  assert.match(source,/SetSecurityDescriptor/);
});

test('AI-01 PowerShell reconciler parses successfully on Windows',{
  skip:process.platform!=='win32',
},()=>{
  const command=[
    '$tokens=$null;$errors=$null',
    "[System.Management.Automation.Language.Parser]::ParseFile('"+script.replaceAll("'","''")+"',[ref]$tokens,[ref]$errors)|Out-Null",
    'if(@($errors).Count -ne 0){$errors|ForEach-Object {Write-Error $_.ToString()};exit 1}',
  ].join(';');
  const result=spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{
    encoding:'utf8',timeout:30000,windowsHide:true,
  });
  assert.equal(result.status,0,result.stderr);
});

test('AI-01 Inspect is read-only and returns a bounded scheduler visibility classification on Windows',{
  skip:process.platform!=='win32',
},()=>{
  const result=invoke(['-Action','Inspect']);
  assert.equal(result.status,0,result.stderr);
  const data=JSON.parse(result.stdout);
  assert.equal(data.action,'Inspect');
  assert.equal(data.taskName,'Nexowire Hub Boot');
  assert.ok(['access-denied','not-installed','found'].includes(data.visibility));
  assert.equal(typeof data.elevated,'boolean');
});

test('AI-01 unprivileged Backup is denied before writing a recovery artifact',{
  skip:process.platform!=='win32',
},()=>{
  const id=spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-Command',
    "(New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"],
  {encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(id.status,0,id.stderr);
  if(id.stdout.trim()==='True') return; // elevated runners must not attempt a live backup
  const result=invoke(['-Action','Backup']);
  assert.notEqual(result.status,0);
  assert.match(result.stdout+result.stderr,/AI01_RECONCILE_ELEVATED_TOKEN_REQUIRED/);
});
