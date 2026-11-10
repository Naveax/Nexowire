import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {SYSTEM_HUB_RECOVERY_PS} from '../scripts/ai04-controlled-system-hub-cutover.js';

test('rollback task only touches exact owner marker and checks for divergent writes',()=>{
  assert.match(SYSTEM_HUB_RECOVERY_PS,/AI04_RECOVERY_BOOT_TASK_NOT_OURS/);
  assert.match(SYSTEM_HUB_RECOVERY_PS,/AI04_RECOVERY_BOOT_ACTION_UNTRUSTED/);
  assert.match(SYSTEM_HUB_RECOVERY_PS,/AI04_ROLLBACK_UNRECONCILED_SYSTEM_WRITES/);
  assert.match(SYSTEM_HUB_RECOVERY_PS,/Get-FileHash/);
  assert.match(SYSTEM_HUB_RECOVERY_PS,/AI04_RECOVERY_BOOT_VISIBILITY_UNVERIFIED/);
  assert.match(SYSTEM_HUB_RECOVERY_PS,/AI04_RECOVERY_LEGACY_TASK_REPLACED/);
  assert.doesNotMatch(SYSTEM_HUB_RECOVERY_PS,/Remove-Item|rmdir|rd \/s/i);
});
test('Windows PowerShell 5.1 parses recovery script without executing it',
  {skip:process.platform!=='win32'},()=>{
  const ps=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from([
        '$encoded='+JSON.stringify(Buffer.from(SYSTEM_HUB_RECOVERY_PS).toString('base64')),
        '$script=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))',
        '$tokens=$null;$errors=$null',
        '[System.Management.Automation.Language.Parser]::ParseInput($script,[ref]$tokens,[ref]$errors)|Out-Null',
        'if(@($errors).Count -ne 0){exit 17}',
      ].join(';'),'utf16le').toString('base64')],
    {encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(ps.status,0,ps.stderr);
});
