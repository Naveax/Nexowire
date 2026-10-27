import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyWindowsPrivateAcl} from '../src/security/windows-programdata-acl.js';

const src=readFileSync(new URL('../src/security/windows-programdata-acl.ts',import.meta.url),'utf8');

test('private protected ACL verifier rejects unexpanded GENERIC_WRITE and GENERIC_ALL rights',()=>{
  assert.match(src,/\$writeMask=[^\n]*\[int64\]0x40000000 -bor \[int64\]0x10000000/);
  assert.match(src,/\[int64\]\$ace.FileSystemRights -band \$writeMask/);
  assert.match(src,/\$ace.IdentityReference.Value -eq 'S-1-3-0'/);
  assert.match(src,/PropagationFlags\]::InheritOnly/);
  assert.match(src,/UNTRUSTED_OWNER/);
  assert.match(src,/UNTRUSTED_WRITE_ACE/);
  assert.doesNotMatch(src,/Write-Output 'PRIVATE_ACL_VERIFIED'\s*;\s*Set-Acl/);
});

test('real Windows private ACL verifier never promotes user-owned scratch code', {
  skip:process.platform!=='win32',timeout:30000,
},()=>{
  const scratch=mkdtempSync(join(tmpdir(),'nexowire-private-acl-generic-'));
  try {
    const file=join(scratch,'agent.js');
    writeFileSync(file,'// test only\n');
    assert.throws(()=>verifyWindowsPrivateAcl(file),/PROTECTED_ACL_INTEGRITY_FAILURE/);
  }finally{rmSync(scratch,{recursive:true,force:true})}
});
