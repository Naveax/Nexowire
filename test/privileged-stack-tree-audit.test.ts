import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,readFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  inventoryReadOnlySourceTree,
  auditPrivilegedStackDependencyTree,
} from '../src/security/privileged-stack-tree-audit.js';

function fixture(){
  const root=mkdtempSync(path.join(os.tmpdir(),'nwx-stack-audit-'));
  const lib=path.join(root,'node_modules');
  mkdirSync(lib);
  writeFileSync(path.join(root,'entry.js'),'module.exports = 1\n');
  writeFileSync(path.join(lib,'helper.js'),'exports.x = true\n');
  return {root,lib,cleanup:()=>rmSync(root,{force:true,recursive:true})};
}

test('every directory and nested imported source file is enumerated and ACL-checked',()=>{
  const f=fixture();
  try {
    const checked:string[]=[];
    const audit=inventoryReadOnlySourceTree(f.root,p=>{checked.push(p)});
    assert.equal(audit.scannedDirectories,2);
    assert.equal(audit.scannedFiles,2);
    assert.equal(audit.verifiedAclEntries,4);
    assert.deepEqual([...checked].sort(),[
      f.root,f.lib,path.join(f.root,'entry.js'),path.join(f.lib,'helper.js'),
    ].sort());
    assert.equal(audit.symlinksFollowed,false);
    assert.equal(audit.modificationsPerformed,false);
    assert.equal(audit.runtimeAttested,false);
    assert.equal(Object.isFrozen(audit),true);
  } finally {f.cleanup()}
});

test('reject user-writable dependency even when entrypoint itself is protected',()=>{
  const f=fixture();
  try {
    assert.throws(()=>inventoryReadOnlySourceTree(f.root,p=>{
      if(p===path.join(f.lib,'helper.js'))throw new Error('WORLD_WRITABLE');
    }),/STACK_TREE_UNTRUSTED_ACL/);
  } finally {f.cleanup()}
});

test('fail closed on entry count, depth limit, invalid base and missing files',()=>{
  const f=fixture();
  try {
    assert.throws(()=>inventoryReadOnlySourceTree(f.root,()=>{},{
      maxEntries:3,
    }),/STACK_TREE_LIMIT_EXCEEDED/);
    assert.throws(()=>inventoryReadOnlySourceTree(f.root,()=>{},{
      maxDepth:0,
    }),/STACK_TREE_DEPTH_LIMIT_EXCEEDED/);
    assert.throws(()=>inventoryReadOnlySourceTree(f.root,()=>{},{
      maxEntries:200000,
    }),/STACK_TREE_LIMIT_INVALID/);
    assert.throws(()=>inventoryReadOnlySourceTree('relative',()=>{}),
      /STACK_TREE_ROOT_NONCANONICAL/);
    assert.throws(()=>inventoryReadOnlySourceTree(path.join(f.root,'missing'),()=>{}));
  } finally {f.cleanup()}
});

test('links to external unverified source cannot be followed',()=>{
  const f=fixture();
  try {
    const link=path.join(f.lib,'redirected.js');
    try {
      symlinkSync(path.join(f.root,'entry.js'),link,'file');
    } catch (err) {
      // Windows without Developer Mode may refuse creating test symlinks.
      if(process.platform==='win32' &&
          (err as NodeJS.ErrnoException).code==='EPERM')return;
      throw err;
    }
    assert.throws(()=>inventoryReadOnlySourceTree(f.root,()=>{}),
      /STACK_TREE_REPARSE_OR_SYMLINK_DENIED/);
  } finally {f.cleanup()}
});

test('production auditor pins full Stack root; no local or cloud mutation pathways',()=>{
  const src=readFileSync(
    new URL('../src/security/privileged-stack-tree-audit.ts',import.meta.url),'utf8',
  );
  assert.match(src,/auditPrivilegedStackSource\(\)/);
  assert.match(src,/verifyWindowsPrivateAcl/);
  assert.match(src,/PRODUCTION_STACK_ROOT/);
  assert.doesNotMatch(src,/(?:writeFileSync|mkdirSync|rmSync|chmodSync|chownSync|Start-ScheduledTask|hardenPrivilegedBrokerAcl)/);
  if(process.platform!=='win32'){
    assert.throws(()=>auditPrivilegedStackDependencyTree(),
      /STACK_TREE_AUDIT_WINDOWS_ONLY/);
  }
});
