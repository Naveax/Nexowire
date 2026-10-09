import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  installerProgramDataRoot,
  protectedInstallerChildEnvironment,
} from '../src/agent/windows-installer-job.js';

test('high-integrity verified installer root cannot be redirected by env',()=>{
  assert.equal(installerProgramDataRoot('C:\\ProgramData'),
    'C:\\ProgramData\\Nexowire\\verified-installers');
  assert.equal(installerProgramDataRoot('c:\\programdata'),
    'C:\\ProgramData\\Nexowire\\verified-installers');
  for(const p of [
    '', '.', 'C:\\Users\\Public',
    'D:\\ProgramData',
    '\\\\attacker\\share',
    '\\\\?\\C:\\ProgramData',
    'C:\\ProgramData\\..',
    'C:\\ProgramData\\Nexowire',
  ])assert.throws(()=>installerProgramDataRoot(p),
    /PROTECTED_INSTALLER_UNTRUSTED_PROGRAMDATA/,p);
  const before=process.env.ProgramData;
  try{
    process.env.ProgramData='C:\\Users\\Public';
    assert.throws(()=>installerProgramDataRoot(),
      /PROTECTED_INSTALLER_UNTRUSTED_PROGRAMDATA/);
  }finally{
    if(before===undefined)delete process.env.ProgramData;
    else process.env.ProgramData=before;
  }
});
test('verified installer PowerShell and icacls subprocesses inherit no untrusted execution paths',()=>{
  const prevPath=process.env.PATH;
  const prevMods=process.env.PSModulePath;
  try{
    process.env.PATH='C:\\untrusted\\evil';
    process.env.PSModulePath='C:\\untrusted\\modules';
    assert.deepEqual(protectedInstallerChildEnvironment(),{
      SystemRoot:'C:\\Windows',
      windir:'C:\\Windows',
      ComSpec:'C:\\Windows\\System32\\cmd.exe',
      PATH:'C:\\Windows\\System32;C:\\Windows',
      PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
    });
  }finally{
    if(prevPath===undefined)delete process.env.PATH;else process.env.PATH=prevPath;
    if(prevMods===undefined)delete process.env.PSModulePath;else process.env.PSModulePath=prevMods;
  }
});
test('installer approval and protected runner pin Windows system executables and modules',()=>{
  const source=readFileSync(new URL('../src/agent/windows-installer-job.ts',import.meta.url),'utf8');
  assert.ok(source.includes("INSTALLER_POWERSHELL=INSTALLER_SYSTEM32+'\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe'"));
  assert.ok(source.includes("INSTALLER_ICACLS=INSTALLER_SYSTEM32+'\\\\icacls.exe'"));
  assert.ok(source.includes("Import-Module -Name 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'"));
  assert.ok(source.includes('spawnSync(INSTALLER_POWERSHELL, ['));
  assert.equal((source.match(/    INSTALLER_ICACLS,/g)||[]).length,2);
  assert.ok(source.includes('      INSTALLER_POWERSHELL,'));
  assert.equal((source.match(/env:protectedInstallerChildEnvironment\(\)/g)||[]).length,4);
  assert.doesNotMatch(source,/spawnSync\('powershell\.exe'/);
  assert.doesNotMatch(source,/spawnSync\(\s*'icacls\.exe'/);
  assert.doesNotMatch(source,/spawn\(\s*'powershell\.exe'/);
  assert.ok(source.includes('path.win32.dirname(installerProgramDataRoot())'));
});
