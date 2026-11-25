import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

const script=path.resolve('scripts/Resolve-Nexowire-LegacySystemHubTask.ps1');
const contents=readFileSync(script,'utf8');
const powershell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

test('AI01 reconciler separates COM absence evidence from cmdlet visibility',()=>{
  const method=contents.slice(contents.indexOf('function Get-TaskOrVisibility('),
    contents.indexOf('function Assert-LegacyIdentity('));
  const com=method.indexOf('$registered=& $ComTaskLookup');
  const cmdlet=method.indexOf('$task=& $CmdletTaskLookup');
  assert.ok(com>0&&cmdlet>com,'independent COM presence must be checked first');
  const missing=method.indexOf("Visibility='not-installed'");
  assert.ok(missing>com&&missing<cmdlet,'only COM GetTask not-found can prove absence');
  assert.match(method,/while\(\$null -ne \$errorCode\.InnerException\)/);
  assert.match(method,/AI01_RECONCILE_TASK_CMDLET_VISIBILITY_UNVERIFIED/);
  assert.doesNotMatch(method,/Start-ScheduledTask|Stop-ScheduledTask|Register-ScheduledTask|Unregister-ScheduledTask/);
});

test('AI01 real PowerShell handles COM and cmdlet disagreement fail-closed',{
  skip:process.platform!=='win32',
},()=>{
  const fixture=[
    '$ErrorActionPreference="Stop"',
    '$ProgressPreference="SilentlyContinue"',
    '$tokens=$null;$errors=$null',

    '$ast=[System.Management.Automation.Language.Parser]::ParseFile('+
      "'"+script.replaceAll("'","''")+"',[ref]$tokens,[ref]$errors)",
    "if(@($errors).Count){throw 'AI01_SCRIPT_PARSE_FAILED'}",
    "$functions=@($ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-TaskOrVisibility'},$true))",
    "if($functions.Count -ne 1){throw 'AI01_GET_VISIBILITY_NOT_FOUND'}",
    '. ([scriptblock]::Create($functions[0].Extent.Text))',
    "$modes=@('absent','denied','found','cmdlet-notfound','cmdlet-denied','cmdlet-null','com-null','com-fault')",
    'foreach($mode in $modes){',
    '  $script:case=$mode',
    '  $com={',
    "    if($script:case -eq 'absent'){throw ([Runtime.InteropServices.COMException]::new('not found',-2147024894))}",
    "    if($script:case -eq 'denied'){throw ([Runtime.InteropServices.COMException]::new('access denied',-2147024891))}",
    "    if($script:case -eq 'com-null'){return $null}",
    "    if($script:case -eq 'com-fault'){throw 'SYNTHETIC_COM_UNEXPECTED'}",
    "    return [pscustomobject]@{Name='Nexowire Hub Boot'}",
    '  }',
    '  $cmdlet={',
    "    if($script:case -eq 'cmdlet-notfound'){throw ([Runtime.InteropServices.COMException]::new('not found',-2147024894))}",
    "    if($script:case -eq 'cmdlet-denied'){throw ([Runtime.InteropServices.COMException]::new('access denied',-2147024891))}",
    "    if($script:case -eq 'cmdlet-null'){return $null}",
    "    return [pscustomobject]@{TaskName='Nexowire Hub Boot'}",
    '  }',
    "  $result='UNKNOWN'",
    '  try{$r=Get-TaskOrVisibility -ComTaskLookup $com -CmdletTaskLookup $cmdlet;$result=$r.Visibility}',
    "  catch{$result='ERROR:'+$_.Exception.Message}",
    '  [pscustomobject]@{case=$mode;result=$result}|ConvertTo-Json -Compress',
    '}',
  ].join('\r\n');
  const run=spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive',
    '-EncodedCommand',Buffer.from(fixture,'utf16le').toString('base64')],{
    encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:128*1024,
  });
  assert.equal(run.status,0,run.stderr);
  const lines=run.stdout.trim().split(/\r?\n/).filter(Boolean);
  const found=lines.map(line=>JSON.parse(line) as {case:string;result:string});
  const expected:Record<string,string>={
    absent:'not-installed',denied:'access-denied',found:'found',
    'cmdlet-notfound':'ERROR:AI01_RECONCILE_TASK_CMDLET_VISIBILITY_UNVERIFIED',
    'cmdlet-denied':'ERROR:AI01_RECONCILE_TASK_CMDLET_VISIBILITY_UNVERIFIED',
    'cmdlet-null':'ERROR:AI01_RECONCILE_TASK_CMDLET_VISIBILITY_UNVERIFIED',
    'com-null':'ERROR:AI01_RECONCILE_TASK_VISIBILITY_UNVERIFIED',
    'com-fault':'ERROR:AI01_RECONCILE_TASK_VISIBILITY_UNVERIFIED',
  };
  assert.equal(found.length,Object.keys(expected).length);
  for(const item of found)assert.equal(item.result,expected[item.case],item.case);
});