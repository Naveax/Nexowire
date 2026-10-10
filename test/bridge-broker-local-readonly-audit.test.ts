import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const script=readFileSync(
  new URL('../scripts/inspect-bridge-broker-local-readonly.ps1',import.meta.url),
  'utf8',
);

test('read-only Broker inspector cannot start/stop/register tasks or modify ACLs',()=>{
  assert.doesNotMatch(script,
    /\b(?:Start|Stop|Enable|Disable|Register|Unregister)-ScheduledTask\b/i);
  assert.doesNotMatch(script,
    /\b(?:Set|New|Remove)-(?:ScheduledTask|Acl|NetTCPConnection|Process|Item|Service)\b/i);
  assert.doesNotMatch(script, /\b(?:Invoke-Expression|iex|Add-Type|Start-Process)\b/i);
  assert.match(script,/\$ErrorActionPreference='Stop'/);
  assert.match(script,/privilegedOperationPerformed=\$false/);
  assert.match(script,/remoteActuationAuthorized=\$false/);
  assert.match(script,/guardianTransportVerified=\$false/);
  assert.match(script,/brokerProcessImageAndOwnerVerified=\$false/);
});

test('fails closed on incomplete task/process/port inspection and guards elevated visibility',()=>{
  assert.match(script,/IsInRole\(/);
  assert.match(script,/if \(-not \$admin\)/);
  assert.match(script,/Get-ScheduledTask -TaskName \$taskName -TaskPath/);
  assert.match(script,/Get-NetTCPConnection -State Listen -ErrorAction Stop/);
  assert.match(script,/Get-CimInstance -ClassName Win32_Process -ErrorAction Stop/);
  assert.match(script,/\$unverifiable=\$true/);
  assert.match(script,/Write-BoundedReport -Status 'UNVERIFIED'/);
  assert.match(script,/Get-NetTCPConnection[^\n]+-ErrorAction Stop/);
});

test('never exports process command lines, SID, executable, token or secrets in diagnostics',()=>{
  const outputFields=script.match(/\[pscustomobject\]@\{([\s\S]*?)\}\s*\| ConvertTo-Json/)?.[1]??'';
  assert.ok(outputFields);
  assert.doesNotMatch(outputFields, /(?:commandLine|exePath|secret|token|sid|pid|processId)\s*=/i);
  assert.match(outputFields,/potentialBrokerProcessCount=/);
  assert.match(outputFields,/uniqueListenerOwnerCount=/);
});

test('native Windows PowerShell inspector runs without modifying scheduled tasks',()=>{
  if(process.platform!=='win32')return;
  const ps='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const result=spawnSync(ps,[
    '-NoLogo','-NoProfile','-NonInteractive','-File',
    new URL('../scripts/inspect-bridge-broker-local-readonly.ps1',import.meta.url)
      .pathname.replace(/^\//,'').replaceAll('/','\\'),
  ],{timeout:20000,encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  const audit=JSON.parse(result.stdout.trim());
  assert.equal(audit.auditOnly,true);
  assert.equal(audit.privilegedOperationPerformed,false);
  assert.equal(audit.remoteActuationAuthorized,false);
  assert.equal(audit.taskActionVerified,false);
  assert.equal(audit.sourceAclVerified,false);
  assert.equal(audit.listenerPort,43112);
  assert.ok(['SNAPSHOT_ONLY','UNVERIFIED'].includes(audit.status));
});
