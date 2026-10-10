import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,readdirSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  GUARDIAN_REPLAY_SCHEMA,
  createGuardianSqliteReplayReserve,
  createProtectedGuardianSqliteReplayReserve,
} from '../src/agent/guardian-sqlite-replay-ledger.js';
import {
  type GuardianCurrentLocalPairing,
} from '../src/agent/guardian-local-replay-ledger.js';

const request='11111111-1111-4111-8111-111111111111';
const deviceId='device-1';
const binding='a'.repeat(64);
const revision='owner-revision-1';

function fixture() {
  const directory=mkdtempSync(path.join(tmpdir(),'nwx-guardian-sqlite-'));
  const filename=path.join(directory,'test.sqlite');
  const provisioner=new DatabaseSync(filename);
  provisioner.exec(GUARDIAN_REPLAY_SCHEMA);
  provisioner.close();
  let current:GuardianCurrentLocalPairing={
    deviceId,credentialBinding:binding,preferenceRevision:revision,
    currentlyAuthorized:true,
  };
  let checks=0;
  const openDb=()=>new DatabaseSync(filename);
  const options=(database:DatabaseSync)=>({
    database,
    readCurrentPairing:async()=>current,
    assertProtected:()=>{checks++},
  });
  return {
    filename,directory,openDb,options,
    update(x:GuardianCurrentLocalPairing){current=x},
    get current(){return current},
    get checks(){return checks},
    cleanup(){rmSync(directory,{recursive:true,force:true})},
  };
}

test('SQLite EXTRA synchronous DELETE journal records one winner and no cleartext pairing',async()=>{
  const f=fixture();
  const a=f.openDb(),b=f.openDb();
  try {
    const reserveA=createGuardianSqliteReplayReserve(f.options(a));
    const reserveB=createGuardianSqliteReplayReserve(f.options(b));
    const results=await Promise.all(Array.from({length:20},(_,i)=>
      (i%2?reserveA:reserveB)(request,deviceId,binding,revision)));
    assert.equal(results.filter(Boolean).length,1);
    assert.equal(results.filter(x=>x===false).length,19);
    const row=a.prepare('SELECT * FROM guardian_used_requests').get() as
      {request_digest:string;device_digest:string;binding_digest:string;revision_digest:string};
    assert.match(row.request_digest,/^[a-f0-9]{64}$/);
    assert.match(row.binding_digest,/^[a-f0-9]{64}$/);
    assert.notEqual(row.binding_digest,binding);
    assert.notEqual(row.device_digest,deviceId);
    assert.notEqual(row.revision_digest,revision);
    assert.equal((a.prepare('PRAGMA synchronous').get() as {synchronous:number}).synchronous,3);
    assert.equal((a.prepare('PRAGMA journal_mode').get() as {journal_mode:string}).journal_mode,'delete');
    assert.ok(f.checks>=2);
  } finally {a.close();b.close();f.cleanup()}
});

test('normal process/database restart cannot reapply the same signed request',async()=>{
  const f=fixture();
  try {
    const a=f.openDb();
    const first=createGuardianSqliteReplayReserve(f.options(a));
    assert.equal(await first(request,deviceId,binding,revision),true);
    a.close();
    const b=f.openDb();
    const resumed=createGuardianSqliteReplayReserve(f.options(b));
    assert.equal(await resumed(request,deviceId,binding,revision),false);
    b.close();
  } finally {f.cleanup()}
});

test('separate process exit without DB close still retains committed one-use entry',async()=>{
  const f=fixture();
  try {
    const library=new URL('../src/agent/guardian-sqlite-replay-ledger.ts',import.meta.url).href;
    const code=`
const {DatabaseSync}=await import('node:sqlite');
const {createGuardianSqliteReplayReserve}=await import(${JSON.stringify(library)});
const db=new DatabaseSync(process.argv[1]);
const reserve=createGuardianSqliteReplayReserve({
  database:db,assertProtected:()=>{},
  readCurrentPairing:async()=>({
    deviceId:'device-1',credentialBinding:'a'.repeat(64),
    preferenceRevision:'owner-revision-1',currentlyAuthorized:true,
  }),
});
const ok=await reserve('11111111-1111-4111-8111-111111111111',
  'device-1','a'.repeat(64),'owner-revision-1');
process.exit(ok?0:6);
`;
    const result=spawnSync(process.execPath,['--import','tsx','--input-type=module',
      '-e',code,f.filename],{
      encoding:'utf8',windowsHide:true,timeout:20000,
    });
    assert.equal(result.status,0,result.stderr);
    const resumed=f.openDb();
    try {
      const reserve=createGuardianSqliteReplayReserve(f.options(resumed));
      assert.equal(await reserve(request,deviceId,binding,revision),false);
    } finally {resumed.close()}
  } finally {f.cleanup()}
});

test('four independent OS processes competing for one command produce exactly one winner',async()=>{
  const f=fixture();
  try {
    const library=new URL('../src/agent/guardian-sqlite-replay-ledger.ts',import.meta.url).href;
    const code=`
const {DatabaseSync}=await import('node:sqlite');
const {createGuardianSqliteReplayReserve}=await import(${JSON.stringify(library)});
const db=new DatabaseSync(process.argv[1]);
const reserve=createGuardianSqliteReplayReserve({
  database:db,assertProtected:()=>{},
  readCurrentPairing:async()=>({
    deviceId:'device-1',credentialBinding:'a'.repeat(64),
    preferenceRevision:'owner-revision-1',currentlyAuthorized:true,
  }),
});
const won=await reserve('11111111-1111-4111-8111-111111111111',
  'device-1','a'.repeat(64),'owner-revision-1');
db.close();
process.stdout.write(won?'WIN':'REJECT');
`;
    const attempt=()=>new Promise<string>((resolve,reject)=>{
      const child=spawn(process.execPath,[
        '--import','tsx','--input-type=module','-e',code,f.filename,
      ],{windowsHide:true,timeout:25000});
      let stdout='';
      let stderr='';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data',chunk=>stdout+=chunk);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data',chunk=>stderr+=chunk);
      child.on('error',reject);
      child.on('close',exit=>{
        if(exit!==0)return reject(new Error('child exit '+exit+': '+stderr));
        resolve(stdout.trim());
      });
    });
    const outcomes=await Promise.all(Array.from({length:4},()=>attempt()));
    assert.equal(outcomes.filter(x=>x==='WIN').length,1);
    assert.equal(outcomes.filter(x=>x==='REJECT').length,3);
  } finally {f.cleanup()}
});

test('pairing revocation before commit fails with no row',async()=>{
  const f=fixture();
  const db=f.openDb();
  try {
    f.update({...f.current,currentlyAuthorized:false});
    const reserve=createGuardianSqliteReplayReserve(f.options(db));
    await assert.rejects(
      reserve(request,deviceId,binding,revision),
      /GUARDIAN_SQLITE_CURRENT_PAIRING_REVOKED/,
    );
    assert.deepEqual(db.prepare('SELECT * FROM guardian_used_requests').all(),[]);
  } finally {db.close();f.cleanup()}
});

test('revocation racing after durable commit consumes command but cannot authorize it',async()=>{
  const f=fixture();
  const db=f.openDb();
  try {
    let calls=0;
    const reserve=createGuardianSqliteReplayReserve({
      ...f.options(db),
      readCurrentPairing:async()=>({
        ...f.current,preferenceRevision:++calls===1?revision:'owner-revoked',
      }),
    });
    await assert.rejects(
      reserve(request,deviceId,binding,revision),
      /GUARDIAN_SQLITE_CURRENT_PAIRING_REVOKED/,
    );
    assert.equal((db.prepare('SELECT count(*) n FROM guardian_used_requests').get() as {n:number}).n,1);
    assert.equal(await createGuardianSqliteReplayReserve(f.options(db))(
      request,deviceId,binding,revision),false);
  } finally {db.close();f.cleanup()}
});

test('reject unprovisioned schema and incorrect journal application identity',()=>{
  const f=fixture();
  try {
    const missing=new DatabaseSync(':memory:');
    assert.throws(()=>createGuardianSqliteReplayReserve({
      ...f.options(missing),
    }),/GUARDIAN_SQLITE_LEDGER_UNPROVISIONED/);
    missing.close();

    const db=f.openDb();
    db.exec('PRAGMA application_id=123');
    assert.throws(()=>createGuardianSqliteReplayReserve(f.options(db)),
      /GUARDIAN_SQLITE_LEDGER_UNPROVISIONED/);
    db.close();
  } finally {f.cleanup()}
});

test('bad request identifiers and unsafe ACL checker fail before any insert',async()=>{
  const f=fixture();
  const db=f.openDb();
  try {
    const bad=createGuardianSqliteReplayReserve(f.options(db));
    await assert.rejects(bad(request,'../evil',binding,revision),
      /GUARDIAN_SQLITE_RESERVATION_IDENTITY_INVALID/);
    await assert.rejects(bad('not-a-uuid',deviceId,binding,revision),
      /GUARDIAN_REPLAY_REQUEST_INVALID/);
    assert.throws(()=>createGuardianSqliteReplayReserve({
      ...f.options(db),assertProtected:()=>{
        throw new Error('UNTRUSTED_ACL');
      },
    }),/UNTRUSTED_ACL/);
    assert.equal((db.prepare('SELECT count(*) n FROM guardian_used_requests').get() as {n:number}).n,0);
  } finally {db.close();f.cleanup()}
});

test('production factory is fixed-root Windows-only and never installs itself',()=>{
  const src=readFileSync(
    new URL('../src/agent/guardian-sqlite-replay-ledger.ts',import.meta.url),'utf8');
  assert.match(src,/verifyBridgeGuardianSourceAcl/);
  assert.match(src,/verifyWindowsPrivateAcl/);
  assert.match(src,/PRAGMA synchronous = EXTRA/);
  assert.match(src,/BEGIN IMMEDIATE/);
  assert.match(src,/INSERT OR IGNORE/);
  assert.match(src,/PRAGMA journal_mode = DELETE/);
  assert.match(src,/database.close\(\)/);
  assert.doesNotMatch(src,/mkdirSync|mkdir\(|Register-ScheduledTask|Start-ScheduledTask|icacls\.exe/);
  if(process.platform!=='win32') {
    assert.throws(()=>createProtectedGuardianSqliteReplayReserve(async()=>({
      deviceId,credentialBinding:binding,preferenceRevision:revision,
      currentlyAuthorized:true,
    })),/GUARDIAN_SQLITE_PROTECTED_WINDOWS_ONLY/);
  }
});
