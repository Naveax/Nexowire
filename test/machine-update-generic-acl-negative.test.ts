import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {inspectExistingMachineUpdateTreeReadOnly} from '../src/security/windows-machine-update-tree-trust.js';

const src=readFileSync(new URL('../src/security/windows-machine-update-tree-trust.ts',import.meta.url),'utf8');

test('signed machine update tree disallows generic Windows writer and generic all bits',()=>{
 const protectedMask=src.match(/\$writeMask=\([^\n]+/);
 const ancestorMask=src.match(/\$ancestorMask=\([^\n]+/);
 assert.ok(protectedMask,'no protected executable/tree write mask');
 assert.ok(ancestorMask,'no ancestor takeover mask');
 assert.match(protectedMask[0],/\[int64\]0x40000000/,'generic_write allows mutation of protected child');
 assert.match(protectedMask[0],/\[int64\]0x10000000/,'generic_all allows rewrite/delete');
 assert.match(ancestorMask[0],/\[int64\]0x10000000/,'generic_all on ancestor may replace protected child');
 assert.match(src,/\[int64\]\$ace\.FileSystemRights -band \$writeMask/);
 assert.match(src,/\[int64\]\$ace\.FileSystemRights -band \$ancestorMask/);
 assert.doesNotMatch(ancestorMask[0],/0x40000000/,'generic write on unrelated OS ancestor alone is not replacement proof');
});

test('machine update gate keeps actual owner, reparse and nonmutating controls',()=>{
 assert.match(src,/MACHINE_UPDATE_UNTRUSTED_OWNER/);
 assert.match(src,/MACHINE_UPDATE_ANCESTOR_OWNER_UNTRUSTED/);
 assert.match(src,/MACHINE_UPDATE_TREE_REPARSE_POINT/);
 assert.match(src,/MACHINE_UPDATE_AUDIT_OBJECT_CAP/);
 assert.match(src,/GetAccessRules\(\$true,\$true,\[Security\.Principal\.SecurityIdentifier\]\)/);
 assert.doesNotMatch(src,/Set-Acl|icacls\.exe|Register-ScheduledTask|Start-ScheduledTask/);
});

test('read-only signed machine-tree audit still refuses low trust temporary folders',{
 skip:process.platform!=='win32',
},()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'nexowire-genacl-native-'));
 try{assert.equal(inspectExistingMachineUpdateTreeReadOnly(dir),false)}
 finally{rmSync(dir,{recursive:true,force:true})}
});
