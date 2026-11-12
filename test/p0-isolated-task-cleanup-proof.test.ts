import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {test} from 'node:test';

const script=path.resolve('scripts/rehearse-isolated-scheduled-task-restore.ps1');
const source=readFileSync(script,'utf8');
const powershell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

test('P0 disabled restore fixture requires independent COM absence before creation and after cleanup',()=>{
  const helper=source.indexOf('function Assert-FixtureAbsent(');
  const check=source.indexOf('function Confirm-FixtureAbsent(){',helper);
  const pre=source.indexOf(' Confirm-FixtureAbsent',source.indexOf("if($prior){throw 'FIXTURE_NAME_COLLISION'}"));
  const registration=source.indexOf('Register-ScheduledTask -TaskPath',pre);
  const cleanup=source.indexOf(' Confirm-FixtureAbsent',source.indexOf('}finally{'));
  const receipt=source.indexOf('fixtureRemovedAfterTest=$true',cleanup);
  assert.ok(helper>0&&check>helper&&pre>check&&registration>pre&&cleanup>registration&&receipt>cleanup,
    'only post-cleanup COM proof may authorize removal receipt');
  assert.match(source,/FIXTURE_ABSENCE_VISIBILITY_UNVERIFIED/);
  assert.match(source,/FIXTURE_TASK_STILL_REGISTERED/);
  assert.doesNotMatch(source,/\$cleanupComplete=\(-not \(Get-ScheduledTask/);
  assert.doesNotMatch(source,/Start-ScheduledTask|Enable-ScheduledTask/);
});

test('P0 absence helper denies hidden, protected and unknown fixtures without registering any task',{
  skip:process.platform!=='win32',
},()=>{
  const ps=[
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    '$tokens=$null;$errors=$null',
    "$ast=[Management.Automation.Language.Parser]::ParseFile('"+
       script.replaceAll("'","''")+"',[ref]$tokens,[ref]$errors)",
    "if(@($errors).Count){throw 'SCRIPT_PARSE_FAILED'}",
    "$nodes=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-FixtureAbsent'},$true))",
    "if($nodes.Count -ne 1){throw 'HELPER_MISSING'}",
    '. ([scriptblock]::Create($nodes[0].Extent.Text))',
    "$name='Nexowire-P0-Restore-Fixture-'+'a'*32",
    "foreach($mode in @('absent','present','denied','null','unexpected','invalid-name')){",
    '  $script:mode=$mode',
    '  $lookup={ param($taskName)',
    "    if($script:mode -eq 'absent' -or $script:mode -eq 'invalid-name'){throw ([Runtime.InteropServices.COMException]::new('not found',-2147024894))}",
    "    if($script:mode -eq 'present'){return [pscustomobject]@{Name=$taskName}}",
    "    if($script:mode -eq 'denied'){throw ([Runtime.InteropServices.COMException]::new('denied',-2147024891))}",
    "    if($script:mode -eq 'null'){return $null}",
    "    throw 'SYNTHETIC_COM_ERROR'",
    '  }',
    "  $actual='PASS'",
    "  $checked=if($mode -eq 'invalid-name'){'Nexowire Hub Boot'}else{$name}",
    '  try{Assert-FixtureAbsent $lookup $checked}catch{$actual=$_.Exception.Message}',
    '  [pscustomobject]@{mode=$mode;result=$actual}|ConvertTo-Json -Compress',
    '}',
  ].join('\r\n');
  const run=spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive',
    '-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')],{
      windowsHide:true,encoding:'utf8',timeout:15000,maxBuffer:128*1024,
    });
  assert.equal(run.status,0,run.stderr);
  const cases=run.stdout.trim().split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x) as {
    mode:string;result:string;
  });
  const expected:Record<string,string>={
    absent:'PASS',
    present:'FIXTURE_TASK_STILL_REGISTERED',
    denied:'FIXTURE_ABSENCE_VISIBILITY_UNVERIFIED',
    null:'FIXTURE_ABSENCE_VISIBILITY_UNVERIFIED',
    unexpected:'FIXTURE_ABSENCE_VISIBILITY_UNVERIFIED',
    'invalid-name':'FIXTURE_ABSENCE_NAME_UNTRUSTED',
  };
  assert.equal(cases.length,Object.keys(expected).length);
  for(const item of cases)assert.equal(item.result,expected[item.mode],item.mode);
});