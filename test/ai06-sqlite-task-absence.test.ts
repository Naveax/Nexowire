import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

const script=path.resolve('scripts/ai06-hub-sqlite-cutover-preflight.ps1');
const contents=readFileSync(script,'utf8');
const powershell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

test('AI06 SQLite cutover requires independent Task Scheduler absence proof before ledger access',()=>{
  const branch=contents.indexOf('if($RequireTaskAbsent)');
  const guard=contents.indexOf('Assert-HubTaskAbsent -TaskLookup',branch);
  const com=contents.indexOf("$folder.GetTask('Nexowire Hub')",guard);
  const journal=contents.indexOf("$sqlite=Join-Path",branch);
  assert.ok(branch>0&&guard>branch&&com>guard&&journal>com,
    'task absence must be proven before journal acceptance');
  assert.match(contents,/Get-ScheduledTask -TaskName 'Nexowire Hub'.*-ErrorAction Stop/);
  assert.match(contents,/IDEMPOTENCY_HUB_TASK_VISIBILITY_UNVERIFIED/);
  assert.doesNotMatch(contents,/Start-ScheduledTask|Stop-ScheduledTask|Register-ScheduledTask/);
});

test('SQLite cutover rejects hidden, inaccessible and duplicate tasks on real Windows PowerShell',{
  skip:process.platform!=='win32',
},()=>{
  const ps=[
    '$ErrorActionPreference="Stop"',
    '$ProgressPreference="SilentlyContinue"',
    '$tokens=$null;$errors=$null',
    "$ast=[System.Management.Automation.Language.Parser]::ParseFile('"+
       script.replaceAll("'","''")+"',[ref]$tokens,[ref]$errors)",
    "if(@($errors).Count){throw 'SCRIPT_PARSE_INVALID'}",
    "$nodes=@($ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-HubTaskAbsent'},$true))",
    "if($nodes.Count -ne 1){throw 'HELPER_MISSING'}",
    '. ([scriptblock]::Create($nodes[0].Extent.Text))',
    "$modes=@('absent','cmdlet-null','present','hidden','access-denied','com-null','unexpected')",
    'foreach($mode in $modes){',
    '  $script:mode=$mode',
    '  $taskQuery={',
    "    if($script:mode -eq 'present'){return [pscustomobject]@{Name='Nexowire Hub'}}",
    "    if($script:mode -eq 'cmdlet-null'){return $null}",
    "    throw 'SYNTHETIC_TASK_CMDLET_NOT_FOUND_OR_DENIED'",
    '  }',
    '  $comQuery={',
    "    if($script:mode -in @('absent','cmdlet-null')){throw ([System.Runtime.InteropServices.COMException]::new('not found',-2147024894))}",
    "    if($script:mode -eq 'hidden'){return [pscustomobject]@{Name='Nexowire Hub'}}",
    "    if($script:mode -eq 'access-denied'){throw ([System.Runtime.InteropServices.COMException]::new('denied',-2147024891))}",
    "    if($script:mode -eq 'com-null'){return $null}",
    "    throw 'SYNTHETIC_UNEXPECTED_COM_FAULT'",
    '  }',
    "  $actual='PASS'",
    '  try{Assert-HubTaskAbsent -TaskLookup $taskQuery -ComLookup $comQuery}catch{$actual=$_.Exception.Message}',
    '  [pscustomobject]@{mode=$mode;actual=$actual}|ConvertTo-Json -Compress',
    '}',
  ].join('\r\n');
  const result=spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive',
    '-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')],{
    encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:128*1024,
  });
  assert.equal(result.status,0,result.stderr);
  const rows=result.stdout.trim().split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x) as {
    mode:string;actual:string;
  });
  const expected:Record<string,string>={
    absent:'PASS',
    'cmdlet-null':'PASS',
    present:'IDEMPOTENCY_HUB_TASK_ALREADY_PRESENT',
    hidden:'IDEMPOTENCY_HUB_TASK_STILL_REGISTERED_OR_HIDDEN',
    'access-denied':'IDEMPOTENCY_HUB_TASK_VISIBILITY_UNVERIFIED',
    'com-null':'IDEMPOTENCY_HUB_TASK_STILL_REGISTERED_OR_HIDDEN',
    unexpected:'IDEMPOTENCY_HUB_TASK_VISIBILITY_UNVERIFIED',
  };
  assert.equal(rows.length,Object.keys(expected).length);
  for(const row of rows)assert.equal(row.actual,expected[row.mode],row.mode);
});