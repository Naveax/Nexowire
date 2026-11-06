import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {join,resolve} from 'node:path';

test('AI-05 exact additive 0020 -> 0021 -> 0022 migration chain and fail-closed triggers',()=>{
  const dir=resolve('cloudflare/migrations');
  const expected=[
    '0020_core_console_native_logon_binding.sql',
    '0021_core_console_native_claim_verified.sql',
    '0022_remote_agent_authorization_epoch.sql',
  ];
  const actual=readdirSync(dir).filter(n=>/^002[012]_.*\.sql$/.test(n)).sort();
  assert.deepEqual(actual,expected,'duplicate or unexpected CORE/remote authority migration');
  const db=new DatabaseSync(':memory:');
  try{
    // Disposable D1-subset fixture. No production migration is performed.
    db.exec(`
      CREATE TABLE device_core_console_authority (
        device_id TEXT PRIMARY KEY, owner_epoch INTEGER, grant_generation INTEGER,
        revoke_epoch INTEGER, installation_id TEXT,enrollment_id TEXT,public_key_spki TEXT);
      CREATE TABLE device_core_console_operations (
        request_id TEXT PRIMARY KEY, device_id TEXT, installation_id TEXT,enrollment_id TEXT,
        owner_epoch INTEGER,grant_generation INTEGER,revoke_epoch INTEGER,
        fingerprint TEXT,reserved_at_ms INTEGER,state TEXT);
      CREATE TABLE devices(
        id TEXT PRIMARY KEY,owner_account_id TEXT NOT NULL,
        credential_hash TEXT NOT NULL,access_mode TEXT NOT NULL);
      CREATE TABLE accounts(id TEXT PRIMARY KEY);
    `);
    for (const name of expected) db.exec(readFileSync(join(dir,name),'utf8'));
    db.prepare('INSERT INTO accounts(id) VALUES (?)').run('owner');
    db.prepare('INSERT INTO devices VALUES(?,?,?,?)').run('device','owner','credential1','full');
    function remote(){return db.prepare(
      'SELECT authorization_epoch AS epoch,active FROM device_remote_authorization WHERE device_id=?'
    ).get('device') as {epoch:number;active:number};}
    const first=remote();assert.equal(first.epoch,1);assert.equal(first.active,0);
    // Migration defaults FULL enrollments to disabled; SAFE -> FULL is explicit approval.
    db.prepare('UPDATE devices SET credential_hash=? WHERE id=?').run('credential2','device');
    assert.equal(remote().epoch,2);
    assert.equal(remote().active,0,'credential rotation must not grant remote access');
    db.prepare("UPDATE devices SET access_mode='safe' WHERE id='device'").run();
    assert.equal(remote().active,0);
    db.prepare("UPDATE devices SET access_mode='full' WHERE id='device'").run();
    assert.equal(remote().active,1);
    const beforeRevoke=remote().epoch;
    db.prepare("UPDATE device_remote_authorization SET authorization_epoch=authorization_epoch+1,active=0 WHERE device_id='device'").run();
    assert.equal(remote().epoch,beforeRevoke+1);
    assert.equal(remote().active,0);
    db.prepare("UPDATE devices SET access_mode='full' WHERE id='device'").run();
    assert.equal(remote().active,0,'unchanged FULL must not regrant');
    const tomb=remote().epoch;
    db.prepare("DELETE FROM devices WHERE id='device'").run();
    assert.ok(remote().epoch>tomb);assert.equal(remote().active,0);
    db.prepare('INSERT INTO devices VALUES(?,?,?,?)').run('device','owner','credential3','full');
    assert.ok(remote().epoch>tomb+1,'re-pair must never reuse old epoch');
    assert.equal(remote().active,0,'FULL re-pair must not auto-enable remote authority');
    db.prepare("UPDATE devices SET access_mode='safe' WHERE id='device'").run();
    db.prepare("UPDATE devices SET access_mode='full' WHERE id='device'").run();
    assert.equal(remote().active,1,'explicit SAFE to FULL permits remote authority');

    db.prepare(`INSERT INTO device_core_console_operations
      (request_id,device_id,installation_id,enrollment_id,owner_epoch,grant_generation,
       revoke_epoch,fingerprint,reserved_at_ms,state)
       VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      'claim','device','installation','enrollment',1,2,3,'digest',42,'reserved');
    db.prepare("UPDATE device_core_console_operations SET state='dispatched' WHERE request_id='claim'").run();
    assert.throws(()=>db.prepare("UPDATE device_core_console_operations SET state='succeeded' WHERE request_id='claim'").run(),
      /CORE_NATIVE_CLAIM_NOT_VERIFIED/);
    db.prepare("UPDATE device_core_console_operations SET native_claim_verified=1 WHERE request_id='claim'").run();
    db.prepare("UPDATE device_core_console_operations SET state='succeeded' WHERE request_id='claim'").run();
    assert.throws(()=>db.prepare("UPDATE device_core_console_operations SET state='reserved' WHERE request_id='claim'").run(),
      /CORE_COMPLETED_OPERATION_TERMINAL/);
    assert.throws(()=>db.prepare("UPDATE device_core_console_operations SET native_claim_verified=0 WHERE request_id='claim'").run(),
      /CORE_NATIVE_CLAIM_DOWNGRADE_DENIED/);
    assert.equal(db.prepare('PRAGMA quick_check').get()!['quick_check'],'ok');
  }finally{db.close();}
});
