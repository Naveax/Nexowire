import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';

const migration=readFileSync(
  new URL('../cloudflare/migrations/0021_core_console_native_claim_verified.sql',import.meta.url),
  'utf8',
);

type CoreOpState='reserved'|'dispatched'|'succeeded'|'denied'|'unknown';
function makeDb(preexisting:ReadonlyArray<readonly [string,CoreOpState]>=[]){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE device_core_console_operations(
    request_id TEXT PRIMARY KEY NOT NULL,
    device_id TEXT NOT NULL,installation_id TEXT NOT NULL,enrollment_id TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL,grant_generation INTEGER NOT NULL,revoke_epoch INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','succeeded','denied','unknown')),
    reserved_at_ms INTEGER NOT NULL
  )`);
  for(const [id,state] of preexisting)insert(db,id,state);
  db.exec(migration);
  return db;
}
function insert(db:DatabaseSync,id:string,state:CoreOpState='reserved'){
  return db.prepare(`INSERT INTO device_core_console_operations
    (request_id,device_id,installation_id,enrollment_id,
     owner_epoch,grant_generation,revoke_epoch,fingerprint,state,reserved_at_ms)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(id,'device','install','enroll',1,1,0,'a'.repeat(64),state,1000);
}
function row(db:DatabaseSync,id:string){
  // node:sqlite produces a null-prototype record. Normalize for strict assertions.
  const found=db.prepare('SELECT state,native_claim_verified AS nativeClaimVerified FROM device_core_console_operations WHERE request_id=?')
    .get(id);
  return found?{...found}:undefined;
}
function advance(db:DatabaseSync,id:string,state:CoreOpState){
  return db.prepare('UPDATE device_core_console_operations SET state=? WHERE request_id=?')
    .run(state,id);
}
function verify(db:DatabaseSync,id:string){
  return db.prepare(`UPDATE device_core_console_operations SET native_claim_verified=1
    WHERE request_id=? AND state='dispatched' AND native_claim_verified=0`).run(id);
}

test('migration defaults existing dispatched and succeeded rows to unverified, no success backfill',()=>{
  const db=makeDb([['old-dispatched','dispatched'],['old-succeeded','succeeded']]);
  try{
    assert.deepEqual(row(db,'old-dispatched'),{state:'dispatched',nativeClaimVerified:0});
    assert.deepEqual(row(db,'old-succeeded'),{state:'succeeded',nativeClaimVerified:0});
    assert.throws(()=>advance(db,'old-dispatched','succeeded'),/CORE_NATIVE_CLAIM_NOT_VERIFIED/);
  }finally{db.close();}
});

test('early signed complete cannot succeed while native readback is still pending',()=>{
  const db=makeDb();
  try{
    insert(db,'r1');
    advance(db,'r1','dispatched');
    assert.throws(()=>advance(db,'r1','succeeded'),/CORE_NATIVE_CLAIM_NOT_VERIFIED/);
    assert.throws(()=>advance(db,'r1','denied'),/CORE_NATIVE_CLAIM_NOT_VERIFIED/);
    assert.deepEqual(row(db,'r1'),{state:'dispatched',nativeClaimVerified:0});
    advance(db,'r1','unknown');
    assert.deepEqual(row(db,'r1'),{state:'unknown',nativeClaimVerified:0});
    assert.throws(()=>advance(db,'r1','dispatched'),/CORE_UNKNOWN_TERMINAL/);
    assert.throws(()=>verify(db,'r1'),/CORE_NATIVE_CLAIM_MARK_DENIED/);
  }finally{db.close();}
});

test('winning verified dispatch can complete but duplicate and late updates cannot replay',()=>{
  const db=makeDb();
  try{
    insert(db,'r2');
    advance(db,'r2','dispatched');
    assert.equal(verify(db,'r2').changes,1);
    assert.deepEqual(row(db,'r2'),{state:'dispatched',nativeClaimVerified:1});
    assert.throws(()=>verify(db,'r2'),/CORE_NATIVE_CLAIM_MARK_DENIED/);
    assert.equal(advance(db,'r2','succeeded').changes,1);
    assert.deepEqual(row(db,'r2'),{state:'succeeded',nativeClaimVerified:1});
    assert.throws(()=>advance(db,'r2','denied'),/CORE_NATIVE_CLAIM_NOT_VERIFIED/);
  }finally{db.close();}
});

test('a caller cannot seed verified grants at insert or mark a reserved operation',()=>{
  const db=makeDb();
  try{
    assert.throws(()=>db.prepare(`INSERT INTO device_core_console_operations
      (request_id,device_id,installation_id,enrollment_id,
       owner_epoch,grant_generation,revoke_epoch,fingerprint,state,reserved_at_ms,native_claim_verified)
      VALUES ('forged','device','install','enroll',1,1,0,'a','dispatched',1000,1)`).run(),
      /CORE_NATIVE_CLAIM_INSERT_DENIED/);
    insert(db,'r3');
    assert.throws(()=>db.prepare(`UPDATE device_core_console_operations
      SET native_claim_verified=1 WHERE request_id='r3'`).run(),
      /CORE_NATIVE_CLAIM_MARK_DENIED/);
  }finally{db.close();}
});

test('native readback verification cannot be silently cleared during dispatch',()=>{
  const db=makeDb();
  try{
    insert(db,'r4');
    advance(db,'r4','dispatched');
    verify(db,'r4');
    assert.throws(()=>db.prepare(`UPDATE device_core_console_operations
      SET native_claim_verified=0 WHERE request_id='r4'`).run(),
      /CORE_NATIVE_CLAIM_DOWNGRADE_DENIED/);
    db.prepare(`UPDATE device_core_console_operations
      SET state='unknown',native_claim_verified=0 WHERE request_id='r4'`).run();
    assert.deepEqual(row(db,'r4'),{state:'unknown',nativeClaimVerified:0});
  }finally{db.close();}
});

test('marking verified cannot change state to succeeded in the same SQL statement',()=>{
  const db=makeDb();
  try{
    insert(db,'r5');
    advance(db,'r5','dispatched');
    assert.throws(()=>db.prepare(`UPDATE device_core_console_operations
      SET state='succeeded',native_claim_verified=1 WHERE request_id='r5'`).run(),
      /CORE_NATIVE_CLAIM_MARK_DENIED|CORE_NATIVE_CLAIM_NOT_VERIFIED/);
    assert.deepEqual(row(db,'r5'),{state:'dispatched',nativeClaimVerified:0});
  }finally{db.close();}
});
