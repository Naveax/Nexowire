import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {test} from 'node:test';

const script=path.resolve('scripts/Resolve-Nexowire-LegacySystemHubTask.ps1');
const source=readFileSync(script,'utf8');
const powershell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

test('AI-01 rehearsal requires independent COM absence before persisting proof',()=>{
  const rehearsal=source.indexOf('function Rehearse($b) {');
  const finalizer=source.indexOf('} finally {',rehearsal);
  const comReadback=source.indexOf('Assert-RehearsalProbeAbsent { param($name) $folder.GetTask($name) }',finalizer);
  const proof=source.indexOf("Write-PrivateText (Join-Path $b.Root 'rehearsal.txt')",finalizer);
  assert.ok(rehearsal>=0&&finalizer>rehearsal&&comReadback>finalizer&&proof>comReadback,
    'rehearsal proof must be written only after COM confirms probe absence');
  assert.match(source,/AI01_RECONCILE_REHEARSAL_PROBE_VISIBILITY_UNVERIFIED/);
  assert.match(source,/AI01_RECONCILE_REHEARSAL_PROBE_STILL_REGISTERED/);
});

type VisibilityCase='not-found'|'access-denied'|'present'|'null'|'unexpected'|'empty-name';
function invokeFixture(mode:VisibilityCase):string{
  const lines=[
    "$ErrorActionPreference='Stop'",
    "$file="+String.fromCharCode(39)+script.replaceAll(String.fromCharCode(39),String.fromCharCode(39,39))+String.fromCharCode(39),
    '$tokens=$null;$errors=$null',
    '$ast=[System.Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)',
    "if(@($errors).Count -ne 0){throw 'PARSER_FAILURE'}",
    "$nodes=@($ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-RehearsalProbeAbsent'},$true))",
    "if($nodes.Count -ne 1){throw 'HELPER_NOT_FOUND'}",
    '. ([scriptblock]::Create($nodes[0].Extent.Text))',
    "$mode="+JSON.stringify(mode),
    "$query={param($name)",
    "  switch($mode){",
    "    'not-found' {throw ([System.Runtime.InteropServices.COMException]::new('not found',-2147024894))}",
    "    'access-denied' {throw ([System.Runtime.InteropServices.COMException]::new('denied',-2147024891))}",
    "    'present' {return [pscustomobject]@{Name=$name}}",
    "    'null' {return $null}",
    "    default {throw 'Unexpected Task Scheduler fault'}",
    '  }',
    '}',
    "try{Assert-RehearsalProbeAbsent $query $(if($mode -eq 'empty-name'){''}else{'Nexowire Hub Restore Probe synthetic'});'ACCEPT'}catch{'DENY:'+$_.Exception.Message}",
  ].join('\n');
  const result=spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive',
    '-EncodedCommand',Buffer.from(lines,'utf16le').toString('base64')],{
    encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:128*1024,
  });
  assert.equal(result.status,0,result.stderr);
  return result.stdout.trim();
}

for(const [mode,expected] of [
  ['not-found','ACCEPT'],
  ['access-denied','DENY:AI01_RECONCILE_REHEARSAL_PROBE_VISIBILITY_UNVERIFIED'],
  ['present','DENY:AI01_RECONCILE_REHEARSAL_PROBE_STILL_REGISTERED'],
  ['null','DENY:AI01_RECONCILE_REHEARSAL_PROBE_VISIBILITY_UNVERIFIED'],
  ['unexpected','DENY:AI01_RECONCILE_REHEARSAL_PROBE_VISIBILITY_UNVERIFIED'],
  ['empty-name','DENY:AI01_RECONCILE_PROBE_NAME_UNTRUSTED'],
] as const){
  test('AI-01 rehearsal COM absence fixture '+mode,{skip:process.platform!=='win32'},()=>{
    assert.equal(invokeFixture(mode),expected);
  });
}