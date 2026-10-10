import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,writeFileSync,rmSync,symlinkSync,readFileSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  auditGuardianSqliteSidecars,
} from '../src/agent/guardian-sqlite-sidecar-preflight.js';

function fixture() {
  const root=mkdtempSync(path.join(os.tmpdir(),'nwx-guardian-sidecar-'));
  const database=path.join(root,'replay.sqlite');
  writeFileSync(database,Buffer.from('fixture-not-a-real-sqlite-db'));
  return {
    root,database,
    cleanup:()=>rmSync(root,{recursive:true,force:true}),
  };
}

test('no sidecars is read-only and does not certify storage or OS execution',()=>{
  const f=fixture();
  try {
    const checked:string[]=[];
    const result=auditGuardianSqliteSidecars(f.database,p=>checked.push(p));
    assert.deepEqual(checked,[]);
    assert.equal(result.journalPresent,false);
    assert.equal(result.unexpectedWalOrShmPresent,false);
    assert.equal(result.auditOnly,true);
    assert.equal(result.storageAttested,false);
    assert.equal(result.privilegedOperationAuthorized,false);
    assert.equal(Object.isFrozen(result),true);
  } finally {f.cleanup()}
});

test('existing rollback journal must have independently verified private ACL',()=>{
  const f=fixture();
  try {
    const journal=f.database+'-journal';
    writeFileSync(journal,'fixture');
    const checked:string[]=[];
    const result=auditGuardianSqliteSidecars(f.database,p=>checked.push(p));
    assert.equal(result.journalPresent,true);
    assert.deepEqual(checked,[journal]);
    assert.throws(()=>auditGuardianSqliteSidecars(f.database,p=>{
      if(p===journal)throw new Error('EVERYONE_MODIFY');
    }),/GUARDIAN_SQLITE_SIDECAR_UNTRUSTED_ACL/);
  } finally {f.cleanup()}
});

test('WAL and shared memory remain forbidden with rollback DELETE configuration',()=>{
  const f=fixture();
  try {
    for(const suffix of ['-wal','-shm']) {
      const file=f.database+suffix;
      writeFileSync(file,'unexpected');
      assert.throws(()=>auditGuardianSqliteSidecars(f.database,()=>{}),
        /GUARDIAN_SQLITE_SIDECAR_UNEXPECTED_WAL_MODE/);
      rmSync(file);
    }
  } finally {f.cleanup()}
});

test('journal reparse/symlink and malformed paths are rejected',()=>{
  const f=fixture();
  try {
    assert.throws(()=>auditGuardianSqliteSidecars('replay.sqlite',()=>{}),
      /GUARDIAN_SQLITE_SIDECAR_PATH_INVALID/);
    assert.throws(()=>auditGuardianSqliteSidecars(f.root,()=>{}),
      /GUARDIAN_SQLITE_SIDECAR_PATH_INVALID/);
    const link=f.database+'-journal';
    try {symlinkSync(f.database,link,'file')}
    catch(err){
      if(process.platform==='win32' &&
          (err as NodeJS.ErrnoException).code==='EPERM')return;
      throw err;
    }
    assert.throws(()=>auditGuardianSqliteSidecars(f.database,()=>{}),
      /GUARDIAN_SQLITE_SIDECAR_LINK_OR_NODE_UNTRUSTED/);
  } finally {f.cleanup()}
});

test('pinned production SQLite wrapper always checks sidecar ACL, no install mutation',()=>{
  const source=readFileSync(
    new URL('../src/agent/guardian-sqlite-replay-ledger.ts',import.meta.url),
    'utf8',
  );
  assert.match(source,/auditGuardianSqliteSidecars\(DATABASE_PATH,verifyWindowsPrivateAcl\)/);
  assert.match(source,/verifyBridgeGuardianSourceAcl\(\)/);
  assert.doesNotMatch(source,/Start-ScheduledTask|Stop-ScheduledTask|Register-ScheduledTask|icacls\.exe/);
});
