import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {RecoveryAuthorizationUseLedger} from '../../src/security/recovery-authorization-use-ledger.js';

function fixture(t:TestContext){
  const root=mkdtempSync(path.join(os.tmpdir(),'nx-ai02-auth-use-'));
  const file=path.join(root,'authority.sqlite');
  const authorityId=randomUUID(),storeId=randomUUID();
  const connections:DatabaseSync[]=[];
  t.after(()=>{for(const db of connections)if(db.isOpen)db.close();rmSync(root,{recursive:true,force:true});});
  const open=()=>{const db=new DatabaseSync(file);connections.push(db);db.exec('PRAGMA synchronous=FULL');return db;};
  const db=open();db.exec(readFileSync(new URL('../../sql/recovery-authorization-ledger.sql',import.meta.url),'utf8'));
  db.prepare('INSERT INTO recovery_authority_metadata VALUES(1,?,?)').run(authorityId,storeId);
  const ledger=new RecoveryAuthorizationUseLedger(db,authorityId,storeId);
  const id={authorizationId:randomUUID(),deviceId:randomUUID(),transactionSha256:'a'.repeat(64),bindingSha256:'b'.repeat(64)};
  return {db,ledger,open,authorityId,storeId,id};
}
const envelope=Buffer.from('inert fixture bytes, NOT a signed production authorization');
test('one durable transaction reservation cannot be reissued with another authorization ID',t=>{
  const f=fixture(t),r=f.ledger.reserve(f.id);
  const second=new RecoveryAuthorizationUseLedger(f.open(),f.authorityId,f.storeId);
  assert.throws(()=>second.reserve({...f.id,authorizationId:randomUUID()}),/RESERVATION_ALREADY_USED/);
  assert.throws(()=>second.reserve({...f.id,transactionSha256:'c'.repeat(64)}),/RESERVATION_ALREADY_USED/);
  assert.equal(r.expiresAtMs-r.reservedAtMs,30000);
});
test('exact sealed bytes and immutable scope are required; consume is one use across connections',t=>{
  const f=fixture(t),r=f.ledger.reserve(f.id),second=new RecoveryAuthorizationUseLedger(f.open(),f.authorityId,f.storeId);
  assert.throws(()=>second.consume(r,envelope),/CONSUME_DENIED/);
  f.ledger.seal(r,envelope);
  assert.throws(()=>second.seal(r,envelope),/SEAL_DENIED/);
  assert.throws(()=>second.consume({...r,bindingSha256:'c'.repeat(64)},envelope),/CONSUME_DENIED/);
  assert.throws(()=>second.consume({...r,deviceId:randomUUID()},envelope),/CONSUME_DENIED/);
  assert.throws(()=>second.consume(r,Buffer.from('different bytes')),/CONSUME_DENIED/);
  second.consume(r,envelope);
  assert.throws(()=>f.ledger.consume(r,envelope),/CONSUME_DENIED/);
  assert.equal(f.db.prepare('SELECT state FROM recovery_authorization_uses').get()?.state,'CONSUMED');
});
test('expiration and clock-before-reservation deny without reissue',t=>{
  const f=fixture(t),r=f.ledger.reserve(f.id);
  const original=Date.now;
  try{
    Date.now=()=>r.reservedAtMs-1;
    assert.throws(()=>f.ledger.seal(r,envelope),/SEAL_DENIED/);
    Date.now=()=>r.expiresAtMs-1;f.ledger.seal(r,envelope);
    Date.now=()=>r.expiresAtMs;
    assert.throws(()=>f.ledger.consume(r,envelope),/CONSUME_DENIED/);
    assert.throws(()=>f.ledger.reserve({...f.id,authorizationId:randomUUID()}),/RESERVATION_ALREADY_USED/);
  }finally{Date.now=original;}
});
test('unprovisioned storage, wrong identity and uncommitted outer transaction deny',t=>{
  const memory=new DatabaseSync(':memory:');
  try{assert.throws(()=>new RecoveryAuthorizationUseLedger(memory,randomUUID(),randomUUID()),/STORE_UNPROVISIONED/);}finally{memory.close();}
  const f=fixture(t);
  assert.throws(()=>new RecoveryAuthorizationUseLedger(f.open(),f.authorityId,randomUUID()),/STORE_IDENTITY_MISMATCH/);
  f.db.exec('BEGIN');
  try{assert.throws(()=>f.ledger.reserve(f.id),/STORE_UNPROVISIONED/);}finally{f.db.exec('ROLLBACK');}
  f.db.exec('PRAGMA synchronous=NORMAL');
  assert.throws(()=>f.ledger.reserve(f.id),/STORE_UNPROVISIONED/);
});
test('reopening the dedicated store preserves reserved and consumed identities',t=>{
  const f=fixture(t),r=f.ledger.reserve(f.id);
  f.db.close();
  const reopened=f.open(),second=new RecoveryAuthorizationUseLedger(reopened,f.authorityId,f.storeId);
  assert.throws(()=>second.reserve(f.id),/RESERVATION_ALREADY_USED/);
  second.seal(r,envelope);second.consume(r,envelope);reopened.close();
  const third=new RecoveryAuthorizationUseLedger(f.open(),f.authorityId,f.storeId);
  assert.throws(()=>third.consume(r,envelope),/CONSUME_DENIED/);
  assert.throws(()=>third.reserve({...f.id,authorizationId:randomUUID()}),/RESERVATION_ALREADY_USED/);
});
