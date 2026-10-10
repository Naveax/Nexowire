import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,readFileSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { inventoryReadOnlySourceTree } from '../src/security/privileged-stack-tree-audit.js';
import { auditBridgeGuardianFullSourceTree } from '../src/agent/bridge-guardian-source-tree-audit.js';

function fixture() {
  const root=mkdtempSync(path.join(os.tmpdir(),'nwx-guardian-src-audit-'));
  const nested=path.join(root,'lib','crypto');
  mkdirSync(nested,{recursive:true});
  writeFileSync(path.join(root,'launch.ps1'),'# fixture only\n');
  writeFileSync(path.join(nested,'verify.js'),'export const verify = true;\n');
  return {root,nested,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}

test('nested Guardian source files and each ancestor directory require ACL checks',()=>{
  const f=fixture();
  try {
    const checked:string[]=[];
    const inventory=inventoryReadOnlySourceTree(f.root,p=>{checked.push(p)},{
      maxEntries:12000,maxDepth:24,
    });
    assert.equal(inventory.scannedDirectories,3);
    assert.equal(inventory.scannedFiles,2);
    assert.equal(inventory.verifiedAclEntries,5);
    assert.deepEqual([...checked].sort(),[
      f.root,path.join(f.root,'lib'),f.nested,
      path.join(f.root,'launch.ps1'),path.join(f.nested,'verify.js'),
    ].sort());
    assert.equal(inventory.runtimeAttested,false);
    assert.equal(inventory.modificationsPerformed,false);
  } finally {f.cleanup()}
});

test('private launcher with user-writable imported dependency is rejected',()=>{
  const f=fixture();
  try{
    const dependency=path.join(f.nested,'verify.js');
    assert.throws(()=>inventoryReadOnlySourceTree(
      f.root,p=>{
        if(p===dependency)throw new Error('UNTRUSTED_WRITE_ACL');
      },
      {maxEntries:12000,maxDepth:24},
    ),/STACK_TREE_UNTRUSTED_ACL/);
  }finally{f.cleanup()}
});

test('symlinks, unreadable ACLs and excessive tree depth always deny trusted inventory',()=>{
  const f=fixture();
  try {
    assert.throws(()=>inventoryReadOnlySourceTree(f.root,()=>{},{
      maxEntries:12000,maxDepth:1,
    }),/STACK_TREE_DEPTH_LIMIT_EXCEEDED/);
    assert.throws(()=>inventoryReadOnlySourceTree(f.root,()=>{throw new Error('ACL_UNAVAILABLE')},{
      maxEntries:12000,maxDepth:24,
    }),/STACK_TREE_UNTRUSTED_ACL/);

    const symlink=path.join(f.root,'external-loader.js');
    try{symlinkSync(path.join(f.nested,'verify.js'),symlink,'file')}
    catch(err){
      if(process.platform==='win32' &&
          (err as NodeJS.ErrnoException).code==='EPERM') return;
      throw err;
    }
    assert.throws(()=>inventoryReadOnlySourceTree(f.root,()=>{},{
      maxEntries:12000,maxDepth:24,
    }),/STACK_TREE_REPARSE_OR_SYMLINK_DENIED/);
  }finally{f.cleanup()}
});

test('pinned Guardian production wrapper has no installer, actuation or caller-selected path',()=>{
  const source=readFileSync(
    new URL('../src/agent/bridge-guardian-source-tree-audit.ts',import.meta.url),
    'utf8',
  );
  assert.match(source,/verifyBridgeGuardianSourceAcl\(\)/);
  assert.match(source,/inventoryReadOnlySourceTree\(/);
  assert.match(source,/verifyWindowsPrivateAcl/);
  assert.match(source,/maxEntries:12000,maxDepth:24/);
  assert.match(source,/remoteActuationAuthorized:false/);
  assert.doesNotMatch(source,/Start-ScheduledTask|Stop-ScheduledTask|Register-ScheduledTask|icacls\.exe|chmodSync|chownSync|writeFileSync/);
  if (process.platform!=='win32') {
    assert.throws(()=>auditBridgeGuardianFullSourceTree(),
      /GUARDIAN_SOURCE_TREE_WINDOWS_ONLY/);
  }
});
