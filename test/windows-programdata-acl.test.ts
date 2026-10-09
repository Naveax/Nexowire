import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsProgramDataAclArguments,verifyWindowsPrivateAcl,protectedWindowsAclEnvironment } from '../src/security/windows-programdata-acl.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readFileSync} from 'node:fs';

test('protected ACL subprocess environment cannot inherit attacker-controlled module or executable paths',()=>{
  const env=protectedWindowsAclEnvironment('C:\\ProgramData\\Nexowire\\hub-boot');
  assert.deepEqual(Object.keys(env).sort(),[
    'SystemRoot','windir','ComSpec','PATH','PSModulePath',
    'NEXOWIRE_PROTECTED_ACL_TARGET',
  ].sort());
  assert.equal(env.SystemRoot,'C:\\Windows');
  assert.equal(env.PSModulePath,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
  assert.equal(env.PATH,'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0');
  for(const key of ['APPDATA','LOCALAPPDATA','USERPROFILE','TEMP','TMP','NODE_OPTIONS','NODE_PATH',
    'PSModuleAnalysisCachePath','PSExecutionPolicyPreference','HOME','POWERSHELL_UPDATECHECK']){
    assert.equal(env[key],undefined,key);
  }
  assert.equal(protectedWindowsAclEnvironment().NEXOWIRE_PROTECTED_ACL_TARGET,undefined);
});

test('protected ACL code pins the executable binary and PowerShell security module, and checks exact success marker',()=>{
  const src=readFileSync(new URL('../src/security/windows-programdata-acl.ts',import.meta.url),'utf8');
  assert.match(src,/WINDOWS_ICACLS=WINDOWS_SYSTEM32\+'\\\\icacls\.exe'/);
  assert.match(src,/spawnSync\(\s*WINDOWS_ICACLS,/);
  assert.match(src,/env:protectedWindowsAclEnvironment\(\)/);
  assert.match(src,/env:protectedWindowsAclEnvironment\(target\)/);
  assert.match(src,/shell:false,cwd:WINDOWS_SYSTEM32/);
  assert.match(src,/Import-Module -Name 'C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\Modules\\Microsoft\.PowerShell\.Security\\Microsoft\.PowerShell\.Security\.psd1'/);
  assert.match(src,/result\.stdout\.trim\(\)!=='PRIVATE_ACL_VERIFIED'/);
  assert.doesNotMatch(src,/spawnSync\(\s*['"]icacls\.exe['"]/);
  assert.doesNotMatch(src,/env:\{\.\.\.process\.env/);
});

test('private ACL verifier remains fail-closed with polluted caller PATH and PowerShell module search',{
  skip:process.platform!=='win32',
},()=>{
  const root=mkdtempSync(path.join(tmpdir(),'nexowire-acl-polluted-'));
  const before={PATH:process.env.PATH,PSModulePath:process.env.PSModulePath};
  try{
    process.env.PATH=root+';'+(process.env.PATH||'');
    process.env.PSModulePath=root;
    assert.throws(()=>verifyWindowsPrivateAcl(root),/PROTECTED_ACL_INTEGRITY_FAILURE/);
  }finally{
    if(before.PATH===undefined)delete process.env.PATH; else process.env.PATH=before.PATH;
    if(before.PSModulePath===undefined)delete process.env.PSModulePath; else process.env.PSModulePath=before.PSModulePath;
    rmSync(root,{recursive:true,force:true});
  }
});

test('ProgramData directory grants only SYSTEM and Administrators with inheritance', () => {
  const args = windowsProgramDataAclArguments('C:\\ProgramData\\Nexowire\\hub-boot', true);
  assert.ok(args.includes('*S-1-5-18:(OI)(CI)F'));
  assert.ok(args.includes('*S-1-5-32-544:(OI)(CI)F'));
  assert.ok(args.includes('/inheritance:r'));
  assert.ok(args.includes('/remove:g'));
  assert.ok(args.includes('*S-1-5-32-545'));
  assert.ok(args.includes('*S-1-5-11'));
  assert.ok(args.includes('*S-1-1-0'));
  assert.ok(args.includes('*S-1-5-4'));
  assert.equal(args.some((arg) => /^\/t$/i.test(arg)), false);
});

test('ProgramData child files get explicit ACL entries instead of recursive inheritance removal', () => {
  const args = windowsProgramDataAclArguments('C:\\ProgramData\\Nexowire\\hub-boot\\launch.ps1', false);
  assert.ok(args.includes('*S-1-5-18:F'));
  assert.ok(args.includes('*S-1-5-32-544:F'));
  assert.equal(args.some((arg) => arg.includes('(OI)') || arg.includes('(CI)')), false);
  assert.equal(args.some((arg) => /^\/t$/i.test(arg)), false);
});

test('protected install checks final ACL after hardening, before task registration',()=>{
  const source=readFileSync(new URL('../src/security/windows-programdata-acl.ts',import.meta.url),'utf8');
  assert.match(source,/applyAcl\(root, true\);\s*verifyWindowsPrivateAcl\(root\)/);
  assert.match(source,/applyAcl\(child, false\);\s*verifyWindowsPrivateAcl\(child\)/);
  assert.match(source,/PRIVATE_ACL_VERIFIED/);
  for(const forbidden of ['Set-Acl','Register-ScheduledTask','Stop-Process','Get-Credential']){
    assert.equal(source.includes(forbidden),false,forbidden);
  }
});

test('read-only protected ACL validation rejects an ordinary user-owned temporary directory',{
  skip:process.platform!=='win32',
},()=>{
  const root=mkdtempSync(path.join(tmpdir(),'nexowire-private-acl-'));
  try{
    assert.throws(()=>verifyWindowsPrivateAcl(root),/PROTECTED_ACL_INTEGRITY_FAILURE/);
  }finally{
    rmSync(root,{recursive:true,force:true});
  }
});
