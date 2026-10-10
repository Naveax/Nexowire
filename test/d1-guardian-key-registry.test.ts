import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { D1GuardianSigningKeyReadOnlyRegistry } from '../src/product/d1-guardian-key-registry.js';
import type { D1DatabaseLike } from '../src/product/d1-control-plane-store.js';

const id={deviceId:'device-1',ownerAccountId:'owner-1',credentialBinding:'a'.repeat(64)};
const der=Buffer.from('302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a','hex');
const row={
  key_id:createHash('sha256').update(der).digest('hex'),
  device_id:id.deviceId,owner_account_id:id.ownerAccountId,
  credential_binding:id.credentialBinding,public_key_spki:der.toString('base64url'),
  revoked_at:null,
};

function setup(rows:unknown[]) {
  const sql:string[]=[];
  const bindings:unknown[][]=[];
  const db={
    prepare(statement:string) {
      sql.push(statement);
      return {
        bind(...args:unknown[]) {bindings.push(args);return this;},
        async all() {return {success:true,results:rows};},
      };
    },
  } as unknown as D1DatabaseLike;
  return {db,sql,bindings};
}

test('exact current paired device may read one canonical Ed25519 signer',async()=>{
  const f=setup([row]);
  const signer=await new D1GuardianSigningKeyReadOnlyRegistry(f.db).resolveCurrentPairedKey(id);
  assert.equal(signer?.asymmetricKeyType,'ed25519');
  assert.deepEqual(f.bindings,[[id.deviceId,id.ownerAccountId,id.credentialBinding]]);
  assert.match(f.sql[0]!,/JOIN devices AS d/);
  assert.match(f.sql[0]!,/d\.credential_hash = k\.credential_binding/);
  assert.match(f.sql[0]!,/d\.access_mode = 'full'/);
  assert.match(f.sql[0]!,/d\.admin_bridge_ready = 1/);
  assert.match(f.sql[0]!,/k\.revoked_at IS NULL/);
  assert.match(f.sql[0]!,/LIMIT 2/);
});

test('missing, duplicate, revoked and mismatched records are never trusted',async()=>{
  const invalid=[
    [],[row,row],
    [{...row,revoked_at:'2026-10-10T12:00:00.000Z'}],
    [{...row,owner_account_id:'another-owner'}],
    [{...row,credential_binding:'b'.repeat(64)}],
    [{...row,key_id:'b'.repeat(64)}],
    [{...row,public_key_spki:'A'.repeat(43)}],
  ];
  for(const rows of invalid) {
    assert.equal(await new D1GuardianSigningKeyReadOnlyRegistry(setup(rows).db)
      .resolveCurrentPairedKey(id),null);
  }
});

test('malformed lookups fail without a database request',async()=>{
  const f=setup([row]);
  const registry=new D1GuardianSigningKeyReadOnlyRegistry(f.db);
  assert.equal(await registry.resolveCurrentPairedKey({...id,deviceId:'../bad'}),null);
  assert.equal(await registry.resolveCurrentPairedKey({...id,credentialBinding:'bad'}),null);
  assert.deepEqual(f.sql,[]);
});

test('migration has a single-active-key constraint; resolver remains read-only',()=>{
  const sql=readFileSync(new URL('../cloudflare/migrations/0017_guardian_signing_keys.sql',import.meta.url),'utf8');
  assert.match(sql,/CREATE UNIQUE INDEX IF NOT EXISTS idx_guardian_active_signer_per_device/);
  assert.match(sql,/WHERE revoked_at IS NULL/);
  const source=readFileSync(new URL('../src/product/d1-guardian-key-registry.ts',import.meta.url),'utf8');
  assert.doesNotMatch(source,/INSERT INTO|UPDATE device_guardian_signing_keys|DELETE FROM/);
});
