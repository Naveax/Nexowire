import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

const script=path.resolve('scripts/audit-windows-restore-token.ps1');
const content=readFileSync(script,'utf8');
const windowsPs='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function execute(engine:string,extraArgs:string[]=[]){
  return spawnSync(engine,[
    '-NoLogo','-NoProfile','-NonInteractive','-File',script,...extraArgs,
  ],{
    windowsHide:true,shell:false,encoding:'utf8',timeout:45000,
    env:{...process.env,PSModulePath:path.dirname(script)},
  });
}
test('token privilege auditor is a non-mutating Win32 TOKEN_QUERY only',()=>{
  for(const marker of [
    'OpenProcessToken(GetCurrentProcess(),0x0008,out token)',
    'GetTokenInformation(token,3,buffer,needed,out outputLength)',
    'LookupPrivilegeValue',
    'SeBackupPrivilege','SeRestorePrivilege',
    'SeSecurityPrivilege','SeTakeOwnershipPrivilege',
    'P0_TOKEN_AUDIT_UNEXPECTED_ARGS',
    'privilegedRestoreAttempted=$false',
    'isolatedAclRestoreVerified=$false',
    'safeToRestoreProduction=$false',
    'safeToCutover=$false',
    'canDemonstrateAdminRecoveryWithThisToken=$false',
  ])assert.ok(content.includes(marker),marker);
  for(const forbidden of [
    /\bAdjustTokenPrivileges\b/gi,
    /\bSet-Acl\b/gi,/\bicacls(?:\.exe)?\b/gi,
    /\bUnregister-ScheduledTask\b/gi,
    /\bRegister-ScheduledTask\b/gi,
    /\bStart-ScheduledTask\b/gi,
    /\bWriteAllText\b/gi,
    /\bRemove-Item\b/gi,
  ])assert.doesNotMatch(content,forbidden);
});
test('token privilege audit is consistent in inbox PowerShell 5.1 and Core',{
  skip:process.platform!=='win32',
},()=>{
  const a=execute(windowsPs);
  const b=execute('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  for(const run of [a,b])assert.equal(run.status,0,run.stderr+' '+run.stdout);
  const reports=[JSON.parse(a.stdout),JSON.parse(b.stdout)];
  for(const result of reports){
    assert.equal(result.schemaVersion,1);
    assert.equal(result.mode,'READ_ONLY_CURRENT_TOKEN_PRIVILEGES');
    for(const name of [
      'SeBackupPrivilege','SeRestorePrivilege','SeSecurityPrivilege',
      'SeTakeOwnershipPrivilege',
    ]){
      assert.equal(typeof result.privilegeStates[name].present,'boolean');
      assert.equal(typeof result.privilegeStates[name].enabled,'boolean');
      if(result.privilegeStates[name].enabled)
        assert.equal(result.privilegeStates[name].present,true);
    }
    for(const name of [
      'privilegedRestoreAttempted','isolatedAclRestoreVerified',
      'productionTaskRestoreVerified','protectedSecretsRestored',
      'productionModified','authorizedToElevate',
      'canDemonstrateAdminRecoveryWithThisToken',
      'safeToRestoreProduction','safeToCutover',
    ])assert.equal(result[name],false,name);
    const backup=result.privilegeStates.SeBackupPrivilege;
    const restore=result.privilegeStates.SeRestorePrivilege;
    assert.equal(result.backupAndRestorePrivilegesPresent,
      backup.present&&restore.present);
    assert.equal(result.enabledBackupRestorePrerequisites,
      (result.isSystem||result.elevatedAdministratorMembership)&&backup.enabled&&restore.enabled);
  }
  assert.deepEqual(reports[0].privilegeStates,reports[1].privilegeStates);
});
test('token preflight refuses caller supplied task names or command switches',{
  skip:process.platform!=='win32',
},()=>{
  const r=execute(windowsPs,['-TaskName','Nexowire Stack']);
  assert.notEqual(r.status,0);
  assert.doesNotMatch(r.stdout,/"safeToRestoreProduction":true/);
  assert.match(r.stderr+r.stdout,/P0_TOKEN_AUDIT_UNEXPECTED_ARGS|NamedParameterNotFound|parameter.*TaskName/i);
});
