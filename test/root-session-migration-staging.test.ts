import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync, type StatementSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import type {
  D1DatabaseLike,D1PreparedStatementLike,
} from '../src/product/d1-control-plane-store.js';
import {D1ControlPlaneStore} from '../src/product/d1-control-plane-store.js';
import {assertRootSessionMigrationStaged} from '../src/product/root-session-migration-preflight.js';

class Statement implements D1PreparedStatementLike {
  constructor(private readonly stmt:StatementSync,private readonly args:unknown[]=[]){}
  bind(...args:unknown[]){return new Statement(this.stmt,args)}
  async first<T>(){return (this.stmt.get(...(this.args as Parameters<StatementSync['get']>))??null) as T|null}
  async all<T>(){return {success:true,results:this.stmt.all(...(this.args as Parameters<StatementSync['all']>)) as T[]}}
  async run<T>(){const r=this.stmt.run(...(this.args as Parameters<StatementSync['run']>));return {success:true,meta:{changes:Number(r.changes)}}}
}
class Adapter implements D1DatabaseLike {
  constructor(private readonly db:DatabaseSync){}
  prepare(sql:string){return new Statement(this.db.prepare(sql))}
  async batch(items:D1PreparedStatementLike[]){
    this.db.exec('BEGIN');
    try {const values=[];for(const stmt of items)values.push(await stmt.run());this.db.exec('COMMIT');return values}
    catch(error){this.db.exec('ROLLBACK');throw error}
  }
}
const migration=readFileSync(path.join(process.cwd(),'cloudflare','migrations',
  '0019_root_session_lifecycle.sql'),'utf8');
function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('CREATE TABLE devices(id TEXT PRIMARY KEY NOT NULL)');
  db.exec('CREATE TABLE device_root_mode_leases (device_id TEXT PRIMARY KEY NOT NULL,owner_account_id TEXT NOT NULL,expires_at TEXT NOT NULL,updated_at TEXT NOT NULL)');
  return {db,adapter:new Adapter(db)};
}
const expectBlocked=async (db:D1DatabaseLike)=>{
  await assert.rejects(assertRootSessionMigrationStaged(db),/ROOT_SESSION_MIGRATION_NOT_STAGED/);
};

test('pre-migration D1 rejects session auth and ROOT grants instead of falling back to legacy lease',async()=>{
  const f=fixture();
  try{
    await expectBlocked(f.adapter);
    const store=new D1ControlPlaneStore(f.adapter);
    await assert.rejects(store.isControlPlaneSessionRevoked('a'.repeat(64),'2026-10-20T00:00:00.000Z'));
    await assert.rejects(store.getRootSessionGrant({
      deviceId:'device',ownerAccountId:'owner',sessionHash:'a'.repeat(64),
      at:'2026-10-20T00:00:00.000Z',
    }));
    await assert.rejects(store.grantRootSession({
      deviceId:'device',ownerAccountId:'owner',sessionHash:'a'.repeat(64),
      issuedAt:'2026-10-20T00:00:00.000Z',
      expiresAt:'2026-10-20T00:01:00.000Z',
    }));
  } finally {f.db.close()}
});

test('0019 staging preflight is read-only, exposes schema-only not production acceptance',async()=>{
  const f=fixture();
  try{
    f.db.exec(migration);
    const beforeChanges=Number(f.db.prepare('SELECT total_changes() n').get()?.n);
    const beforeSchema=Number(f.db.prepare('PRAGMA schema_version').get()?.schema_version);
    const assessed=await assertRootSessionMigrationStaged(f.adapter);
    assert.deepEqual(assessed,{
      ready:true,scope:'schema-only',privilegedExecutionProven:false,
    });
    assert.equal(Object.isFrozen(assessed),true);
    assert.equal(Number(f.db.prepare('SELECT total_changes() n').get()?.n),beforeChanges);
    assert.equal(Number(f.db.prepare('PRAGMA schema_version').get()?.schema_version),beforeSchema);
  } finally {f.db.close()}
});

test('partial migration, missing index, missing grant table or missing revocation ledger all block',async()=>{
  const f=fixture();
  try{
    f.db.exec(`CREATE TABLE control_plane_revoked_sessions (
      session_hash TEXT PRIMARY KEY NOT NULL CHECK(length(session_hash)=64),
      owner_account_id TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT NOT NULL)`);
    await expectBlocked(f.adapter);
    f.db.exec('DROP TABLE control_plane_revoked_sessions');
    f.db.exec(migration);
    await assertRootSessionMigrationStaged(f.adapter);
    for(const drop of [
      'DROP INDEX idx_root_session_grants_session',
      'DROP TABLE device_root_session_grants',
    ]){
      const next=fixture();
      try{
        next.db.exec(migration);
        next.db.exec(drop);
        await expectBlocked(next.adapter);
      } finally {next.db.close()}
    }
    f.db.exec('DROP TABLE control_plane_revoked_sessions');
    await expectBlocked(f.adapter);
  }finally{f.db.close()}
});

test('similarly named fake 0019 tables without FK/hash/expiry checks must be rejected',async()=>{
  const f=fixture();
  try{
    f.db.exec(`
      CREATE TABLE control_plane_revoked_sessions(session_hash TEXT PRIMARY KEY NOT NULL,owner_account_id TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT NOT NULL);
      CREATE INDEX idx_control_plane_revoked_session_expiry ON control_plane_revoked_sessions(expires_at);
      CREATE TABLE device_root_session_grants(device_id TEXT PRIMARY KEY NOT NULL,owner_account_id TEXT NOT NULL,session_hash TEXT NOT NULL,issued_at TEXT NOT NULL,expires_at TEXT NOT NULL);
      CREATE INDEX idx_root_session_grants_session ON device_root_session_grants(owner_account_id,session_hash);
    `);
    await expectBlocked(f.adapter);
  } finally{f.db.close()}
});

test('lookalike index names with wrong columns and missing lease columns fail closed',async()=>{
  for(const sabotage of [
    "DROP INDEX idx_root_session_grants_session; CREATE INDEX idx_root_session_grants_session ON device_root_session_grants(session_hash,owner_account_id)",
    "DROP INDEX idx_control_plane_revoked_session_expiry; CREATE INDEX idx_control_plane_revoked_session_expiry ON control_plane_revoked_sessions(owner_account_id)",
    "DROP TABLE device_root_mode_leases; CREATE TABLE device_root_mode_leases(device_id TEXT PRIMARY KEY NOT NULL,owner_account_id TEXT NOT NULL)",
  ]) {
    const f=fixture();
    try {
      f.db.exec(migration);
      f.db.exec(sabotage);
      await expectBlocked(f.adapter);
    }finally{f.db.close()}
  }
});

test('read-only migration preflight fails closed when D1 provider throws or returns incomplete result',async()=>{
  const f=fixture();
  try {
    await expectBlocked({prepare:()=>{throw Error('provider offline')},batch:async()=>[]} as D1DatabaseLike);
    await expectBlocked({prepare:()=>({all:async()=>({success:false,results:[]})})} as unknown as D1DatabaseLike);
  } finally{f.db.close()}
});
