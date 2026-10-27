import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const inspect=readFileSync(new URL('../scripts/audit-windows-runtime-acl.ps1',import.meta.url),'utf8');
const runtime=readFileSync(new URL('../src/security/windows-privileged-runtime-trust.ts',import.meta.url),'utf8');
const outer=readFileSync(new URL('../src/security/windows-programdata-acl.ts',import.meta.url),'utf8');

test('three read-only elevated code/ancestor ACL gates cover generic Windows write/all rights',()=>{
 for(const [label,source] of ([['main readonly scan',inspect],['signed runtime',runtime]] as const)){
   assert.match(source,/\[int64\]0x40000000/,label+' omitted GENERIC_WRITE');
   assert.match(source,/\[int64\]0x10000000/,label+' omitted GENERIC_ALL');
   assert.match(source,/\[int64\]\$(?:rule|ace)\.FileSystemRights -band \$(?:writeMask|effectiveMask)/,
     label+' must apply 64-bit mask to ACEs');
 }
 assert.match(runtime,/\$ancestorMask=[^\n]*\[int64\]0x10000000/,
   'GENERIC_ALL on a shared ancestor includes replacement/delete powers');
 assert.doesNotMatch(runtime,/\$ancestorMask=[^\n]*0x40000000/,
   'generic write alone on common OS ancestor is not a child replacement power');
 assert.match(outer,/\$mask=[^\n]*\[int64\]0x10000000/);
 assert.match(outer,/\[int64\]\$ace\.FileSystemRights -band \$mask/);
});

test('runtime ACL gate does not waive effective CREATOR OWNER or caller principals',()=>{
 assert.match(runtime,/\$ace\.IdentityReference\.Value -eq 'S-1-3-0'/);
 assert.match(runtime,/PropagationFlags\]::InheritOnly/);
 assert.match(inspect,/\$rule\.IdentityReference\.Value -eq 'S-1-3-0'/);
 assert.match(inspect,/PropagationFlags\]::InheritOnly/);
 assert.match(runtime,/RUNTIME_OWNER_UNTRUSTED/);
 assert.match(inspect,/UNTRUSTED_OWNER/);
 assert.match(inspect,/mode='READ_ONLY'/);
 assert.match(inspect,/ownerApprovedElevatedExecution=\$false/);
});

test('real Windows CLR generic file rights preserve the unsafe bit masks',{
 skip:process.platform!=='win32',timeout:18000,
},()=>{
 const script=`$a=[System.Security.AccessControl.FileSystemRights];[pscustomobject]@{
  genericAll=(([int64]0x10000000 -band [int64]0x10000000) -ne 0);
  genericWrite=(([int64]0x40000000 -band [int64]0x40000000) -ne 0);
  deleteChild=(([int64]$a::DeleteSubdirectoriesAndFiles -band 0x40) -ne 0)
 }|ConvertTo-Json -Compress`;
 const process=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
   {encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:64*1024});
 assert.equal(process.status,0,process.stderr);
 const bits=JSON.parse(process.stdout.trim());
 assert.equal(bits.genericAll,true);
 assert.equal(bits.genericWrite,true);
 assert.equal(bits.deleteChild,true);
});
