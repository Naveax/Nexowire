import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';

const path = resolve('scripts/broker-handoff-preflight.ps1');
const script = readFileSync(path, 'utf8');

test('isolated maintenance preflight never mutates protected Windows services or tasks',()=>{
  assert.match(script, /safeToChangeProcesses = \$false/);
  assert.match(script, /actionsPerformed = 'READ_ONLY'/);
  assert.match(script, /AUTHENTICATED_ELEVATED_TASK_AND_ROLLBACK_NOT_YET_VERIFIED/);
  assert.match(script, /Get-NetTCPConnection/);
  assert.match(script, /Get-FileHash/);
  assert.match(script, /Get-ScheduledTaskInfo/);
  assert.match(script, /Get-RouteCode \$BrokerPort/);
  assert.match(script, /distinctHubAndBrokerPids/);
  assert.match(script, /legacySupervisorWillAvoidRespawnWhenTaskPresent/);
  assert.match(script, /stagedWindowsBundleChecksumMatches/);
  assert.match(script, /stagedArchiveChecksumMatches/);
  for(const text of [
    'Stop-Process', 'Start-Process', 'Stop-ScheduledTask', 'Start-ScheduledTask',
    'Unregister-ScheduledTask', 'Register-ScheduledTask', 'Set-ScheduledTask',
    'Restart-Service', 'Start-Service', 'Stop-Service', 'Remove-Item',
    'Invoke-Expression', 'Start-Job', 'Set-Item',
  ]) {
    assert.equal(script.includes(text),false, 'Mutating command not permitted: '+text);
  }
  assert.doesNotMatch(script, /\$env:(?:.+?TOKEN|.+?SECRET)|Get-Content[^\r\n]*\.dpapi\.json/i);
});

test('hardened report does not grant elevated authority from unauthenticated 401 response',()=>{
  assert.match(script, /Get-RouteCode/);
  assert.match(script, /unauthenticatedHealthStatus/);
  assert.match(script, /safeToChangeProcesses = \$false/);
  assert.doesNotMatch(script, /safeToChangeProcesses = \$true/);
});

test('PowerShell parser accepts maintenance preflight without executing it',{
  skip:process.platform!=='win32',
},()=>{
  const ps = [
    '$file=' + "'" + path.replaceAll("'", "''") + "';",
    '$errors=$null; $tokens=$null;',
    '[System.Management.Automation.Language.Parser]::ParseFile(',
    '$file, [ref]$tokens, [ref]$errors) | Out-Null;',
    'if($errors.Count -gt 0) {',
    '$errors | ForEach-Object { Write-Error $_.Message }; exit 5',
    '}'
  ].join(' ');
  const result = execFileSync('powershell.exe',[
    '-NoProfile','-NonInteractive','-Command',ps,
  ],{encoding:'utf8',timeout:15000,windowsHide:true});
  assert.equal(result.trim(),'');
});
