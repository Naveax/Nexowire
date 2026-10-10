import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {renderMachineCutoverScript} from '../src/update/machine-update.js';

const script=renderMachineCutoverScript({
  version:'1.0.5',buildId:'1.0.5-012345abcdef',
  targetRoot:'C:\\ProgramData\\Nexowire\\versions\\1.0.5-012345abcdef',
});
const lines=script.split(/\r?\n/);
const begin=lines.findIndex(s=>s.startsWith('function Assert-CutoverPlan {'));
const end=lines.indexOf('}',begin+1);
assert.ok(begin>=0&&end>begin,'missing isolated cutover plan guard');
const planFunction=lines.slice(begin,end+1).join('\r\n');

test('cutover validates target task plan before editing a launcher or stopping tasks',()=>{
  assert.match(script,/function Assert-CutoverPlan \{/);
  assert.match(script,/MACHINE_UPDATE_NO_ELIGIBLE_TASKS/);
  assert.match(script,/MACHINE_UPDATE_HUB_LAUNCHER_MISSING/);
  assert.match(script,/MACHINE_UPDATE_BROKER_LAUNCHER_MISSING/);
  const check=script.indexOf('  Assert-CutoverPlan');
  const patch=script.indexOf('  if($hasBoot){Patch-Launcher $BootLauncher}');
  assert.match(script,/if\(\$hasBroker\)\{Patch-Launcher \$BrokerLauncher\}/);
  const stop=script.indexOf('  if($hasBoot){Stop-ScheduledTask');
  assert.ok(check>=0&&patch>check&&stop>patch);
  assert.match(script,/if\(-not\(Test-Path -LiteralPath \$file -PathType Leaf\)\)\{throw/);
  assert.match(script,/Write-Status 'rolled_back'/);
});

const cases=[
  {name:'no tasks but launcher files exist is NOT success',boot:false,broker:false,bootFile:true,brokerFile:true,result:'MACHINE_UPDATE_NO_ELIGIBLE_TASKS'},
  {name:'Hub task without its launcher must not mutate tasks',boot:true,broker:false,bootFile:false,brokerFile:true,result:'MACHINE_UPDATE_HUB_LAUNCHER_MISSING'},
  {name:'Broker task without launcher must not mutate tasks',boot:false,broker:true,bootFile:true,brokerFile:false,result:'MACHINE_UPDATE_BROKER_LAUNCHER_MISSING'},
  {name:'both tasks require both launchers',boot:true,broker:true,bootFile:true,brokerFile:false,result:'MACHINE_UPDATE_BROKER_LAUNCHER_MISSING'},
  {name:'Hub-only task with its launcher is eligible',boot:true,broker:false,bootFile:true,brokerFile:false,result:'PASS'},
  {name:'Broker-only task with its launcher is eligible',boot:false,broker:true,bootFile:false,brokerFile:true,result:'PASS'},
  {name:'both tasks with both launchers are eligible',boot:true,broker:true,bootFile:true,brokerFile:true,result:'PASS'},
] as const;

for(const c of cases){
  test(c.name,{skip:process.platform!=='win32'},()=>{
    const fixture=[
      "$ErrorActionPreference='Stop'",
      '$hasBoot='+String(c.boot?'$true':'$false'),
      '$hasBroker='+String(c.broker?'$true':'$false'),
      "$BootLauncher='C:\\ProgramData\\Nexowire\\hub-boot\\launch.ps1'",
      "$BrokerLauncher='C:\\ProgramData\\Nexowire\\privileged-broker\\launch.ps1'",
      'function Test-Path {',
      '  param([string]$LiteralPath,[string]$PathType)',
      "  if($LiteralPath -eq $BootLauncher){return "+(c.bootFile?'$true':'$false')+'}',
      "  if($LiteralPath -eq $BrokerLauncher){return "+(c.brokerFile?'$true':'$false')+'}',
      '  return $false',
      '}',
      'function Assert-TaskIdentity { param([string]$name,[string]$launcher,[bool]$mustBeSystem) }',
      planFunction,
      "try { Assert-CutoverPlan; [Console]::WriteLine('PASS') }",
      'catch { [Console]::WriteLine($_.Exception.Message) }',
    ].join('\r\n');
    const command=Buffer.from(fixture,'utf16le').toString('base64');
    const output=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',command],{
        cwd:'C:\\Windows\\System32',
        env:{
          SystemRoot:'C:\\Windows',windir:'C:\\Windows',
          PATH:'C:\\Windows\\System32;C:\\Windows',
          PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
        },
        encoding:'utf8',timeout:10_000,maxBuffer:128*1024,
        windowsHide:true,
      });
    assert.equal(output.status,0,output.stderr);
    assert.equal(output.stdout.trim(),c.result);
  });
}
