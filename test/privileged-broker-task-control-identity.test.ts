import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {privilegedBrokerTaskControlPreflightScript} from '../src/agent/privileged-broker-lifecycle.js';

test('Broker start/stop check task identity before mutation', () => {
  const source=readFileSync(new URL('../src/agent/privileged-broker-lifecycle.ts',import.meta.url),'utf8');
  const start=source.indexOf('export async function startPrivilegedBrokerTask');
  const stop=source.indexOf('export async function stopPrivilegedBrokerTask');
  assert.ok(start>0 && stop>start);
  for(const script of [source.slice(start,stop),source.slice(stop,source.indexOf('export async function uninstallPrivilegedBrokerTask'))]) {
    const task=script.indexOf('Get-ScheduledTask -TaskName $name -ErrorAction Stop');
    const gate=script.indexOf('$'+'{privilegedBrokerTaskControlPreflightScript}');
    const action=script.search(/(?:Start|Stop)-ScheduledTask -TaskName \$name -ErrorAction Stop/);
    assert.ok(task>=0 && gate>task && action>gate);
  }
  for(const code of ['ACTION_COUNT','EXECUTABLE','ARGUMENTS','RUNLEVEL','LOGON','OWNER']) {
    assert.ok(privilegedBrokerTaskControlPreflightScript.includes('BROKER_TASK_'+code+'_MISMATCH'),code);
  }
});

test('Broker task guard rejects unexpected actions and principal identity on real Windows PowerShell', {
  skip:process.platform!=='win32',
},()=>{
  const exe='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const cases=[
    ['trusted','valid',true],
    ['multiple-actions','extra',false],
    ['wrong-executable','exe',false],
    ['wrong-arguments','args',false],
    ['wrong-runlevel','level',false],
    ['wrong-logon','logon',false],
    ['foreign-owner','user',false],
  ] as const;
  for(const [label,kind,expected] of cases) {
    const lines=[
      "$ErrorActionPreference='Stop'",
      "$env:NEXOWIRE_BROKER_LAUNCHER='C:\\ProgramData\\Nexowire\\privileged-broker\\launch.ps1'",
      "$argsExpected='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"' + $env:NEXOWIRE_BROKER_LAUNCHER + '\"'",
      "$exe='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
      "$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name",
      ...(kind==='exe'?["$exe='C:\\Temp\\powershell.exe'"]:[]),
      ...(kind==='args'?["$argsExpected='-File C:\\Temp\\hijack.ps1'"]:[]),
      ...(kind==='user'?["$user='NT AUTHORITY\\SYSTEM'"]:[]),
      "$actions=@([pscustomobject]@{Execute=$exe;Arguments=$argsExpected})",
      ...(kind==='extra'?["$actions+=([pscustomobject]@{Execute=$exe;Arguments=$argsExpected})"]:[]),
      "$task=[pscustomobject]@{Actions=$actions;Principal=[pscustomobject]@{RunLevel='"+(kind==='level'?'Limited':'Highest')+"';LogonType='"+(kind==='logon'?'S4U':'Interactive')+"';UserId=$user}}",
      privilegedBrokerTaskControlPreflightScript,
      "'TRUSTED'",
    ];
    const run=spawnSync(exe,['-NoLogo','-NoProfile','-NonInteractive','-Command',lines.join('\n')],{
      encoding:'utf8',windowsHide:true,timeout:20000,
    });
    assert.equal(run.status===0,expected,label+': '+(run.stderr||run.stdout).slice(0,350));
    if(expected)assert.match(run.stdout,/TRUSTED/,label);
  }
});
