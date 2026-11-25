import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync,readFileSync,linkSync,renameSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {inspectOfflineSqliteStatus,assertOfflineSqliteNoUnresolvedOperations}
  from '../../src/hub/sqlite-rollback-offline-evidence.js';
function fixture(t:TestContext,statuses:string[],schema='1'){
  const root=realpathSync(mkdtempSync(path.join(os.tmpdir(),'nx-ai02-status-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'idempotency-records.sqlite');
  const db=new DatabaseSync(file);
  try{
    db.exec('CREATE TABLE idempotency_records(key TEXT PRIMARY KEY,status TEXT); CREATE TABLE idempotency_meta(key TEXT PRIMARY KEY,value TEXT)');
    db.prepare("INSERT INTO idempotency_meta VALUES('schema_version',?)").run(schema);
    for(const [i,status] of statuses.entries())db.prepare('INSERT INTO idempotency_records VALUES(?,?)').run(String(i),status);
  }finally{db.close()}
  const sha=()=>createHash('sha256').update(readFileSync(file)).digest('hex');
  return {root,file,sha};
}
test('actual offline SQLite statuses are counted without rewriting UNKNOWN or in-progress rows',t=>{
  const f=fixture(t,['succeeded','failed','unknown','in_progress','unknown']);
  const before=f.sha(),result=inspectOfflineSqliteStatus(f.root);
  assert.deepEqual(result,{schemaVersion:1,sqliteRecords:5,succeeded:1,failed:1,unknown:2,inProgress:1});
  assert.throws(()=>assertOfflineSqliteNoUnresolvedOperations(result),/UNRESOLVED_OPERATIONS/);
  assert.equal(f.sha(),before);
});
test('each unresolved status independently prevents offline approval; resolved rows remain intact',t=>{
  for(const statuses of [['unknown'],['in_progress'],['succeeded','failed'],[]]){
    const f=fixture(t,statuses),before=f.sha(),result=inspectOfflineSqliteStatus(f.root);
    if(statuses.includes('unknown')||statuses.includes('in_progress'))
      assert.throws(()=>assertOfflineSqliteNoUnresolvedOperations(result),/UNRESOLVED_OPERATIONS/);
    else assert.doesNotThrow(()=>assertOfflineSqliteNoUnresolvedOperations(result));
    assert.equal(f.sha(),before);
  }
});
test('unreviewed SQLite schema or status is denied without a ledger write',t=>{
  for(const [statuses,schema,expected] of [
    [['succeeded'],'2',/SCHEMA_UNREVIEWED/],
    [['unrecognized'],'1',/STATUS_UNREVIEWED/],
  ] as const){
    const f=fixture(t,[...statuses],schema),before=f.sha();
    assert.throws(()=>inspectOfflineSqliteStatus(f.root),expected);
    assert.equal(f.sha(),before);
  }
});
test('hardlinked ledger is denied before read-only open',t=>{
  const f=fixture(t,['succeeded']),before=f.sha();
  const original=path.join(f.root,'original.db');
  renameSync(f.file,original);linkSync(original,f.file);
  assert.throws(()=>inspectOfflineSqliteStatus(f.root),/FILE_UNTRUSTED/);
  assert.equal(f.sha(),before);
});
