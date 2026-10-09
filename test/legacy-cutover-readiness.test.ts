import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

const script=path.resolve('scripts/inspect-legacy-cutover-readiness.ps1');
const source=readFileSync(script,'utf8');

test('cutover readiness script is read only and cannot claim clearance',()=>{
  for(const unsafe of ['Set-Acl','icacls.exe','Start-Process','Stop-Process',
    'Register-ScheduledTask','Stop-ScheduledTask','Start-ScheduledTask',
    'Unregister-ScheduledTask','Set-Content','Copy-Item','Move-Item',
    'Remove-Item','Out-File','Export-ScheduledTask','ConvertFrom-SecureString']){
    assert.equal(source.includes(unsafe),false,unsafe);
  }
  assert.match(source,/safeToCutover=\$false/);
  assert.match(source,/credentialsInspected=\$false/);
  assert.match(source,/protectedRollbackVerified=\$false/);
  assert.match(source,/READ_ONLY/);
  assert.match(source,/MaxObjects/);
});

test('Windows cutover report inventories fixture and retains mandatory blockers',{
  skip:process.platform!=='win32',
},()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'nw-handoff-readonly-'));
  const root=path.join(dir,'runtime');
  const launcherRoot=path.join(dir,'launcher');
  const nodeRoot=path.join(dir,'host');
  for(const d of [root,launcherRoot,nodeRoot])mkdirSync(d);
  const cli=path.join(root,'cli.js');
  const launcher=path.join(launcherRoot,'launch.ps1');
  const node=path.join(nodeRoot,'node.exe');
  writeFileSync(cli,'// fixture only\n');
  writeFileSync(launcher,'# fixture only\n');
  writeFileSync(node,'not a signed binary\n');
  const before=createHash('sha256').update(readFileSync(cli)).digest('hex');
  try {
    const parser="$e=$null;$t=$null;[System.Management.Automation.Language.Parser]::ParseFile('"+
      script.replaceAll("'","''")+"',[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|ForEach-Object{$_.Message};exit 5}";
    const parsed=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',parser],{
      encoding:'utf8',timeout:20000,windowsHide:true
    });
    assert.equal(parsed.status,0,parsed.stderr+' '+parsed.stdout);
    const run=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',script,
      '-RuntimeRoot',root,'-Entrypoint',cli,
      '-LauncherRoot',launcherRoot,'-Launcher',launcher,
      '-NodeExecutable',node,
      '-TaskName','Nexowire-Never-Installed-ReadOnly-Fixture',
      '-HubPort','49318','-BrokerPort','49319','-MaxObjects','100'],{
      encoding:'utf8',timeout:90000,windowsHide:true,
    });
    assert.equal(run.status,0,run.stderr+' '+run.stdout);
    const report=JSON.parse(run.stdout);
    assert.equal(report.mode,'READ_ONLY');
    assert.equal(report.schemaVersion,1);
    assert.equal(report.safeToCutover,false);
    assert.equal(report.privilegedOperationPerformed,false);
    assert.equal(report.credentialsInspected,false);
    assert.equal(report.taskXmlBackedUp,false);
    assert.equal(report.protectedRollbackVerified,false);
    assert.equal(report.audits.length,3);
    assert.ok(report.audits.every((a:{completed:boolean})=>a.completed));
    assert.ok(report.blockers.includes('TRUSTED_REPLACEMENT_NOT_ACCEPTED'));
    assert.ok(report.blockers.includes('TASK_AND_SECRET_ROLLBACK_UNVERIFIED'));
    assert.ok(report.blockers.includes('OWNER_AUTH_AND_SESSION_ACCEPTANCE_PENDING'));
    assert.equal(report.sha256.legacyCliSha256,before);
    assert.equal(createHash('sha256').update(readFileSync(cli)).digest('hex'),before);
    assert.equal(run.stdout.includes(dir),false,'no raw absolute filesystem paths in output');
    const invalid=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',script,
      '-RuntimeRoot',launcherRoot,'-Entrypoint',cli,
      '-LauncherRoot',launcherRoot,'-Launcher',launcher,
      '-NodeExecutable',node,
      '-TaskName','Nexowire-Never-Installed-ReadOnly-Fixture'],{
      encoding:'utf8',timeout:30000,windowsHide:true,
    });
    assert.notEqual(invalid.status,0,'out-of-scope inputs fail before audit');
  } finally {
    rmSync(dir,{recursive:true,force:true});
  }
});
