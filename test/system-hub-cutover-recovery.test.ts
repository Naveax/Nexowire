import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
test('rollback keeps a divergent running SYSTEM Hub online; shutdown must be rechecked',()=>{
  const first=SYSTEM_HUB_RECOVERY_PS.indexOf('& $validateState');
  const stop=SYSTEM_HUB_RECOVERY_PS.indexOf('Stop-ScheduledTask');
  const second=SYSTEM_HUB_RECOVERY_PS.indexOf('try{& $validateState}catch{');
  const resume=SYSTEM_HUB_RECOVERY_PS.indexOf('Start-ScheduledTask');
  const remove=SYSTEM_HUB_RECOVERY_PS.indexOf('Unregister-ScheduledTask');
  assert.ok(first>=0&&first<stop,'durable state must be compared before SYSTEM stop');
  assert.ok(stop<second&&second<resume&&resume<remove,
    'late write must be rechecked and SYSTEM resumed before task deletion');
  assert.match(SYSTEM_HUB_RECOVERY_PS,/AI04_RECOVERY_SYSTEM_TARGET_MISSING/);
  assert.match(SYSTEM_HUB_RECOVERY_PS,/AI04_RECOVERY_SYSTEM_RESUME_FAILED/);
  assert.match(SYSTEM_HUB_RECOVERY_PS,/throw \$divergence/);
});

test('Windows PowerShell 5.1 parses recovery script without executing it',
  {skip:process.platform!=='win32'},()=>{
  const temp=mkdtempSync(path.join(os.tmpdir(),'nx-ai02-recovery-parse-'));
  try{
    const inputFile=path.join(temp,'recovery-input.ps1');
    // Store the exact script in a disposable file with an explicit UTF-8 BOM.
    // Never pass a growing nested Base64 script through CreateProcessW.
    writeFileSync(inputFile,Buffer.concat([
      Buffer.from([0xef,0xbb,0xbf]),Buffer.from(SYSTEM_HUB_RECOVERY_PS,'utf8'),
    ]));
    const command=[
      "$ErrorActionPreference='Stop'",
      "$inputPath='"+inputFile.replaceAll("'","''")+"'",
      '$tokens=$null;$errors=$null',
      '[System.Management.Automation.Language.Parser]::ParseFile($inputPath,[ref]$tokens,[ref]$errors)|Out-Null',
      'if(@($errors).Count -ne 0){exit 17}',
      "'AI04_RECOVERY_PARSE_OK'",
    ].join(';');
    const encoded=Buffer.from(command,'utf16le').toString('base64');
    assert.ok(encoded.length<8192,'parser wrapper must stay small');
    const ps=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded],
      {encoding:'utf8',windowsHide:true,timeout:15000});
    assert.equal(ps.error,undefined);
    assert.equal(ps.status,0,ps.stderr);
    assert.match(ps.stdout,/AI04_RECOVERY_PARSE_OK/);
  }finally{rmSync(temp,{recursive:true,force:true})}
});
