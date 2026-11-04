/** CLEAN-12 P0 source-only negative tests. Disposable SQLite, no native device or grant. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const migration=readFileSync(new URL('../cloudflare/migrations/0021_core_console_native_claim_verified.sql',import.meta.url),'utf8');
function create(db:DatabaseSync,apply=true){
  db.exec("CREATE TABLE device_core_console_operations ("+
    "request_id TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL, device_id TEXT NOT NULL,"+
    "installation_id TEXT NOT NULL, enrollment_id TEXT NOT NULL, owner_epoch INTEGER NOT NULL,"+
    "grant_generation INTEGER NOT NULL, revoke_epoch INTEGER NOT NULL,"+
    "state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','succeeded','denied','unknown')),"+
    "reserved_at_ms INTEGER NOT NULL)");
  if(apply)db.exec(migration);
}
function reserve(db:DatabaseSync,id='id-1',fingerprint='a'.repeat(64)){
  return db.prepare("INSERT INTO device_core_console_operations "+
    "(request_id,fingerprint,device_id,installation_id,enrollment_id,owner_epoch,grant_generation,revoke_epoch,state,reserved_at_ms) "+
    "VALUES(?,?,'dev','install','enroll',1,1,0,'reserved',1000) ON CONFLICT(request_id) DO NOTHING")
    .run(id,fingerprint);
}
function claim(db:DatabaseSync,id='id-1'){
  return db.prepare("UPDATE device_core_console_operations SET state='dispatched' "+
    "WHERE request_id=? AND fingerprint=? AND state='reserved'").run(id,'a'.repeat(64));
}
function mark(db:DatabaseSync,id='id-1'){
  return db.prepare("UPDATE device_core_console_operations SET native_claim_verified=1 "+
    "WHERE request_id=? AND fingerprint=? AND device_id='dev' AND installation_id='install' "+
    "AND enrollment_id='enroll' AND owner_epoch=1 AND grant_generation=1 AND revoke_epoch=0 "+
    "AND state='dispatched' AND native_claim_verified=0").run(id,'a'.repeat(64));
}
function complete(db:DatabaseSync,id='id-1'){
  return db.prepare("UPDATE device_core_console_operations SET state='succeeded' "+
    "WHERE request_id=? AND fingerprint=? AND state='dispatched' AND native_claim_verified=1")
    .run(id,'a'.repeat(64));
}
function status(db:DatabaseSync,id='id-1'){
  return {...db.prepare('SELECT state,native_claim_verified FROM device_core_console_operations WHERE request_id=?').get(id)};
}

test('CLEAN-12: missing 0021 schema cannot accidentally ACK success',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    create(db,false);reserve(db);claim(db);
    assert.throws(()=>complete(db),/no such column: native_claim_verified/);
    assert.equal(db.prepare("SELECT state FROM device_core_console_operations").get()?.state,'dispatched');
  }finally{db.close();}
});

test('CLEAN-12: native readback pending prevents terminal success and deny ACK',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    create(db);reserve(db);claim(db);
    assert.throws(()=>db.exec("UPDATE device_core_console_operations SET state='succeeded'"),/CORE_NATIVE_CLAIM_NOT_VERIFIED/);
    assert.throws(()=>db.exec("UPDATE device_core_console_operations SET state='denied'"),/CORE_NATIVE_CLAIM_NOT_VERIFIED/);
    assert.deepEqual(status(db),{state:'dispatched',native_claim_verified:0});
    db.exec("UPDATE device_core_console_operations SET state='unknown'");
    assert.throws(()=>db.exec("UPDATE device_core_console_operations SET state='reserved'"),/CORE_UNKNOWN_TERMINAL/);
    assert.equal(mark(db).changes,0);
  }finally{db.close();}
});

test('CLEAN-12: unique claimant and post-readback CAS win exactly once',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    create(db);reserve(db);
    assert.equal(claim(db).changes,1);
    assert.equal(claim(db).changes,0,'second claimant must not consume same UUID');
    assert.equal(complete(db).changes,0,'unverified winner cannot complete');
    assert.equal(mark(db).changes,1);
    assert.equal(mark(db).changes,0);
    assert.deepEqual(status(db),{state:'dispatched',native_claim_verified:1});
    assert.equal(complete(db).changes,1);
    assert.equal(complete(db).changes,0,'duplicate completion is not accepted');
    assert.throws(()=>db.exec("UPDATE device_core_console_operations SET state='reserved'"),/CORE_COMPLETED_OPERATION_TERMINAL/);
  }finally{db.close();}
});

test('CLEAN-12: revoke or session generation change before CAS denies winner',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    create(db);
    db.exec("CREATE TABLE current_scope(device_id TEXT PRIMARY KEY, epoch INTEGER, allowed INTEGER)");
    db.exec("INSERT INTO current_scope VALUES ('dev',1,1)");
    reserve(db);claim(db);
    db.exec("UPDATE current_scope SET epoch=2,allowed=0");
    const result=db.prepare("UPDATE device_core_console_operations SET native_claim_verified=1 "+
      "WHERE request_id='id-1' AND state='dispatched' AND native_claim_verified=0 "+
      "AND EXISTS (SELECT 1 FROM current_scope WHERE device_id='dev' AND epoch=1 AND allowed=1)").run();
    assert.equal(result.changes,0,'revoked or changed scope must not mark verified');
    assert.throws(()=>db.exec("UPDATE device_core_console_operations SET state='succeeded'"),/CORE_NATIVE_CLAIM_NOT_VERIFIED/);
    db.exec("UPDATE device_core_console_operations SET state='unknown'");
    assert.equal(mark(db).changes,0);
  }finally{db.close();}
});

test('CLEAN-12: lost reservation ACK and same UUID different fingerprint do not re-admit',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    create(db);
    assert.equal(reserve(db).changes,1);
    assert.equal(reserve(db).changes,0);
    assert.equal(reserve(db,'id-1','f'.repeat(64)).changes,0);
    assert.deepEqual(status(db),{state:'reserved',native_claim_verified:0});
    assert.equal(claim(db).changes,1);
    assert.equal(db.prepare("UPDATE device_core_console_operations SET native_claim_verified=1 "+
      "WHERE request_id='id-1' AND fingerprint=? AND state='dispatched' AND native_claim_verified=0")
      .run('f'.repeat(64)).changes,0);
    assert.equal(mark(db).changes,1);
  }finally{db.close();}
});

test('CLEAN-12: restart persists verified marker, UNKNOWN stays terminal',()=>{
  const folder=mkdtempSync(join(tmpdir(),'nw-clean12-'));
  const file=join(folder,'disposable.sqlite');
  let db:DatabaseSync|undefined;
  try{
    db=new DatabaseSync(file);
    create(db);reserve(db);claim(db);mark(db);
    db.close();db=undefined;
    db=new DatabaseSync(file);
    assert.deepEqual(status(db),{state:'dispatched',native_claim_verified:1});
    assert.equal(complete(db).changes,1);
    assert.equal(claim(db).changes,0);
    db.exec("UPDATE device_core_console_operations SET state='unknown',native_claim_verified=0");
    assert.equal(claim(db).changes,0);
    assert.throws(()=>db.exec("UPDATE device_core_console_operations SET state='dispatched'"),/CORE_UNKNOWN_TERMINAL/);
  }finally{db?.close();rmSync(folder,{recursive:true,force:true});}
});

test('CLEAN-12: historic succeeded rows are not retroactively native-verified',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    create(db,false);
    reserve(db);
    db.exec("UPDATE device_core_console_operations SET state='succeeded'");
    db.exec(migration);
    assert.deepEqual(status(db),{state:'succeeded',native_claim_verified:0});
    assert.throws(()=>db.exec("UPDATE device_core_console_operations SET state='reserved'"),/CORE_COMPLETED_OPERATION_TERMINAL/);
    assert.equal(mark(db).changes,0);
  }finally{db.close();}
});
