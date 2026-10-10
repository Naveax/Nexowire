import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {
  privilegedBrokerModeTransitionScript,
  isolatedPrivilegedBrokerTaskEnvironment,
  reconcilePrivilegedBrokerMode,
} from '../src/agent/privileged-broker-lifecycle.js';

test('mode environment accepts only enumerated values without caller shell hooks',()=>{
  for(const mode of ['auto','on','off']){
    const env=isolatedPrivilegedBrokerTaskEnvironment({
      NEXOWIRE_BROKER_TASK_NAME:'Nexowire Privileged Broker',
      NEXOWIRE_BROKER_LAUNCHER:'C:\\ProgramData\\Nexowire\\privileged-broker\\launch.ps1',
      NEXOWIRE_BROKER_DESIRED_MODE:mode,
      NODE_OPTIONS:'--require C:\\tmp\\inject.js',
      PATH:'C:\\untrusted\\bin',
    });
    assert.equal(env.NEXOWIRE_BROKER_DESIRED_MODE,mode);
    assert.equal(env.NODE_OPTIONS,undefined);
    assert.equal(env.PATH,'C:\\Windows\\System32;C:\\Windows');
  }
  assert.throws(()=>isolatedPrivilegedBrokerTaskEnvironment({
    NEXOWIRE_BROKER_TASK_NAME:'Nexowire Privileged Broker',
    NEXOWIRE_BROKER_LAUNCHER:'C:\\ProgramData\\Nexowire\\privileged-broker\\launch.ps1',
    NEXOWIRE_BROKER_DESIRED_MODE:'arbitrary',
  }),/PRIVILEGED_BROKER_TASK_MODE_INVALID/);
});

test('mode reconciler requires explicit local confirmation and canonical task',async()=>{
  await assert.rejects(
    reconcilePrivilegedBrokerMode('off','WRONG'),
    /BROKER_MODE_CONFIRMATION_REQUIRED/,
  );
  await assert.rejects(
    reconcilePrivilegedBrokerMode('on','ADMIN BRIDGE MODE CONFIRMED',{taskName:'Foreign task'}),
    /BROKER_MODE_NONCANONICAL_TASK_DENIED/,
  );
  await assert.rejects(
    reconcilePrivilegedBrokerMode('execute' as 'on','ADMIN BRIDGE MODE CONFIRMED'),
    /BROKER_MODE_INVALID/,
  );
});

test('mode script is identity guarded, disables recovery before stopping and verifies result',()=>{
  const script=privilegedBrokerModeTransitionScript;
  assert.match(script,/BROKER_TASK_ACTION_COUNT_MISMATCH/);
  assert.match(script,/BROKER_TASK_OWNER_MISMATCH/);
  assert.match(script,/BROKER_MODE_OFF_NOT_VERIFIED/);
  assert.match(script,/BROKER_MODE_RUNNING_NOT_VERIFIED/);
  assert.ok(script.indexOf('Disable-ScheduledTask -TaskName $name')<
    script.indexOf('Stop-ScheduledTask -TaskName $name'));
  assert.ok(script.indexOf('Enable-ScheduledTask -TaskName $name')<
    script.indexOf('Start-ScheduledTask -TaskName $name'));
  assert.match(script,/brokerHealthVerified=\$false/);
  assert.doesNotMatch(script,/(?:Unregister-ScheduledTask|Register-ScheduledTask|Remove-Item|icacls\.exe)/);
  const source=readFileSync(new URL('../src/agent/privileged-broker-lifecycle.ts',import.meta.url),'utf8');
  assert.ok(source.indexOf('await verifyBrokerTaskStartFiles(options)',source.indexOf('export async function reconcilePrivilegedBrokerMode'))>0);
  assert.match(source,/BROKER_MODE_LOCAL_ELEVATION_REQUIRED/);
});

test('mocked PowerShell Scheduled Task transitions are deterministic and never use real task APIs',{
  skip:process.platform!=='win32',
},()=>{
  const powershell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const scenarios=[
    {mode:'off',from:'Running',events:['disable','stop'],final:'Disabled'},
    {mode:'off',from:'Disabled',events:[],final:'Disabled'},
    {mode:'off',from:'Ready',events:['disable'],final:'Disabled'},
    {mode:'on',from:'Disabled',events:['enable','start'],final:'Running'},
    {mode:'auto',from:'Ready',events:['start'],final:'Running'},
    {mode:'auto',from:'Running',events:[],final:'Running'},
  ] as const;
  for(const {mode,from,events,final} of scenarios) {
    const setup=[
      "$ErrorActionPreference='Stop'",
      "$env:NEXOWIRE_BROKER_TASK_NAME='Nexowire Privileged Broker'",
      "$env:NEXOWIRE_BROKER_LAUNCHER='C:\\ProgramData\\Nexowire\\privileged-broker\\launch.ps1'",
      "$env:NEXOWIRE_BROKER_DESIRED_MODE='"+mode+"'",
      "$script:state='"+from+"'",
      '$script:events=@()',
      '$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name',
      "$exe='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
      "$arg='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"C:\\ProgramData\\Nexowire\\privileged-broker\\launch.ps1\"'",
      'function Get-ScheduledTask {[CmdletBinding()]param([string]$TaskName) [pscustomobject]@{State=$script:state;Actions=@([pscustomobject]@{Execute=$exe;Arguments=$arg});Principal=[pscustomobject]@{RunLevel="Highest";LogonType="Interactive";UserId=$user}}}',
      'function Disable-ScheduledTask {[CmdletBinding()]param([string]$TaskName) $script:events+= "disable"; $script:state="Disabled"}',
      'function Stop-ScheduledTask {[CmdletBinding()]param([string]$TaskName) $script:events+= "stop"}',
      'function Enable-ScheduledTask {[CmdletBinding()]param([string]$TaskName) $script:events+= "enable"; $script:state="Ready"}',
      'function Start-ScheduledTask {[CmdletBinding()]param([string]$TaskName) $script:events+= "start"; $script:state="Running"}',
    ].join('\n');
    const script=setup+'\n'+privilegedBrokerModeTransitionScript+'\n'+
      "'EVENTS=' + ($script:events -join ',')";
    const result=spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(script,'utf16le').toString('base64')],{
      encoding:'utf8',windowsHide:true,timeout:20000,
    });
    assert.equal(result.status,0,mode+' from '+from+': '+(result.stderr||result.stdout).slice(0,500));
    assert.match(result.stdout,new RegExp('EVENTS='+events.join(',')),mode+' from '+from);
    assert.match(result.stdout,new RegExp('"finalState":"'+final+'"'),mode+' from '+from);
    assert.match(result.stdout,/"brokerHealthVerified":false/);
  }
});

test('mocked task failure never returns a verified success record', {
  skip:process.platform!=='win32',
},()=>{
  const powershell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  for(const scenario of [
    {mode:'off',initial:'Running',fault:'disable',error:'SYNTHETIC_DISABLE_DENIED'},
    {mode:'on',initial:'Disabled',fault:'start',error:'SYNTHETIC_START_DENIED'},
    {mode:'auto',initial:'Ready',fault:'start',error:'SYNTHETIC_START_DENIED'},
  ] as const){
    const setup=[
      "$ErrorActionPreference='Stop'",
      "$env:NEXOWIRE_BROKER_TASK_NAME='Nexowire Privileged Broker'",
      "$env:NEXOWIRE_BROKER_LAUNCHER='C:\\ProgramData\\Nexowire\\privileged-broker\\launch.ps1'",
      "$env:NEXOWIRE_BROKER_DESIRED_MODE='"+scenario.mode+"'",
      "$script:state='"+scenario.initial+"'",
      "$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name",
      "$exe='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
      "$arg='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"C:\\ProgramData\\Nexowire\\privileged-broker\\launch.ps1\"'",
      'function Get-ScheduledTask {[CmdletBinding()]param([string]$TaskName) [pscustomobject]@{State=$script:state;Actions=@([pscustomobject]@{Execute=$exe;Arguments=$arg});Principal=[pscustomobject]@{RunLevel="Highest";LogonType="Interactive";UserId=$user}}}',
      'function Disable-ScheduledTask {[CmdletBinding()]param([string]$TaskName)'+(scenario.fault==='disable'?' throw "SYNTHETIC_DISABLE_DENIED"':' $script:state="Disabled"')+'}',
      'function Stop-ScheduledTask {[CmdletBinding()]param([string]$TaskName) throw "SYNTHETIC_UNEXPECTED_STOP"}',
      'function Enable-ScheduledTask {[CmdletBinding()]param([string]$TaskName) $script:state="Ready"}',
      'function Start-ScheduledTask {[CmdletBinding()]param([string]$TaskName) throw "SYNTHETIC_START_DENIED"}',
      privilegedBrokerModeTransitionScript,
    ].join('\n');
    const result=spawnSync(powershell,[
      '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(setup,'utf16le').toString('base64'),
    ],{encoding:'utf8',windowsHide:true,timeout:20000});
    assert.notEqual(result.status,0,scenario.mode+' should reject the mutation failure');
    assert.match(result.stderr+result.stdout,new RegExp(scenario.error));
    assert.doesNotMatch(result.stdout,/"taskVerified":true/);
  }
});
