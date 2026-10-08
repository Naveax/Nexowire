import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsProgramDataAclArguments,verifyWindowsPrivateAcl } from '../src/security/windows-programdata-acl.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readFileSync} from 'node:fs';

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
