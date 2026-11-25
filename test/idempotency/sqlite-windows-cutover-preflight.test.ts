import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = path.join(process.cwd(), 'scripts', 'ai06-hub-sqlite-cutover-preflight.ps1');

function run(root: string, target: 'sqlite' | 'json-only', extra: string[] = []) {
  const windowsRoot = process.env.SystemRoot || process.env.windir || 'C:\Windows';
  const ps51 = path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return spawnSync(ps51, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-StateDir', root, '-TargetReader', target, ...extra,
  ], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
    // Windows runner's pwsh module path can shadow PowerShell 5.1 Security.
    // A clean 5.1 module search path is required for Get-Acl to load.
    env: {...process.env,
      SystemRoot: windowsRoot, windir: windowsRoot,
      PATH: [path.join(windowsRoot, 'System32'), windowsRoot].join(path.delimiter),
      PSModulePath: path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
    },
  });
}

test('Windows SQLite cutover preflight denies JSON downgrade and checks migration hash', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const source = await fs.readFile(script, 'utf8');
  assert.doesNotMatch(source,
    /\b(?:Register|Unregister|Start|Stop|Set|Disable|Enable)-ScheduledTask\b/i);
  assert.doesNotMatch(source,
    /\b(?:Remove-Item|Move-Item|Set-Content|New-Item|Start-Process|Stop-Process)\b/i);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwx-ai06-rollback-only-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  // Windows TEMP can inherit broad write ACEs. Restrict *only this synthetic*
  // directory, never a production user profile or Hub journal.
  const sidResult = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(sidResult.status, 0, sidResult.stderr);
  const ownerSid = sidResult.stdout.trim();
  assert.match(ownerSid, /^S-1-/);
  const aclResult = spawnSync('icacls.exe', [
    root, '/inheritance:r', '/grant:r', '*' + ownerSid + ':(OI)(CI)F',
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(aclResult.status, 0, aclResult.stderr);
  const legacy = path.join(root, 'idempotency-records.json');
  const contents = '{"version":1,"records":[]}\n';
  await fs.writeFile(legacy, contents);
  const sha = createHash('sha256').update(contents).digest('hex').toUpperCase();

  const blockedOld = run(root, 'json-only');
  assert.equal(blockedOld.status, 2, blockedOld.stderr);
  assert.match(blockedOld.stderr, /IDEMPOTENCY_SQLITE_DOWNGRADE_DENIED/);

  const withoutProof = run(root, 'sqlite', ['-AllowFirstMigration']);
  assert.equal(withoutProof.status, 2, withoutProof.stderr);
  assert.match(withoutProof.stderr, /IDEMPOTENCY_LEGACY_HASH_REQUIRED/);
  const wrongHash = run(root, 'sqlite', [
    '-AllowFirstMigration', '-ExpectedLegacySha256', '0'.repeat(64),
  ]);
  assert.equal(wrongHash.status, 2, wrongHash.stderr);
  assert.match(wrongHash.stderr, /IDEMPOTENCY_LEGACY_HASH_MISMATCH/);

  const authorizedStaging = run(root, 'sqlite', [
    '-AllowFirstMigration', '-ExpectedLegacySha256', sha,
  ]);
  assert.equal(authorizedStaging.status, 0, authorizedStaging.stderr);
  assert.equal(JSON.parse(authorizedStaging.stdout).firstMigration, true);
  assert.equal(await fs.readFile(legacy, 'utf8'), contents);

  const sqlitePath = path.join(root, 'idempotency-records.sqlite');
  const db = new DatabaseSync(sqlitePath);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE fixture (id INTEGER PRIMARY KEY)');
  db.close();
  const before = createHash('sha256').update(await fs.readFile(sqlitePath))
    .digest('hex');

  const blockedDowngrade = run(root, 'json-only');
  assert.equal(blockedDowngrade.status, 2, blockedDowngrade.stderr);
  assert.match(blockedDowngrade.stderr, /IDEMPOTENCY_SQLITE_DOWNGRADE_DENIED/);

  const sqliteReader = run(root, 'sqlite');
  assert.equal(sqliteReader.status, 0, sqliteReader.stderr);
  assert.equal(JSON.parse(sqliteReader.stdout).sqliteExists, true);

  const wrongSid = run(root, 'sqlite', [
    '-ExpectedOwnerSid', 'S-1-5-21-0-0-0-9999',
  ]);
  assert.equal(wrongSid.status, 2, wrongSid.stderr);
  assert.match(wrongSid.stderr, /IDEMPOTENCY_OWNER_SID_MISMATCH/);
  assert.equal(createHash('sha256').update(await fs.readFile(sqlitePath))
    .digest('hex'), before, 'preflight must not mutate the SQLite file');
  assert.equal(await fs.readFile(legacy, 'utf8'), contents);
});
test('Windows SQLite preflight rejects a junction in an ancestor of the state root', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwx-ai06-parent-junction-'));
  t.after(async () => fs.rm(root, {recursive: true, force: true}));
  const actual = path.join(root, 'actual');
  const hub = path.join(actual, 'hub');
  await fs.mkdir(hub, {recursive: true});
  const junction = path.join(root, 'alias');
  await fs.symlink(actual, junction, 'junction');
  const sid = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',
    '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],
  {encoding:'utf8',windowsHide:true});
  assert.equal(sid.status, 0, sid.stderr);
  const acl=spawnSync('icacls.exe',[hub,'/inheritance:r','/grant:r',
    '*'+sid.stdout.trim()+':(OI)(CI)F'],{encoding:'utf8',windowsHide:true});
  assert.equal(acl.status,0,acl.stderr);
  const legacy=JSON.stringify({version:1,records:[]})+String.fromCharCode(10);
  await fs.writeFile(path.join(hub,'idempotency-records.json'),legacy);
  const digest=createHash('sha256').update(legacy).digest('hex');
  const response=run(path.join(junction,'hub'),'sqlite',[
    '-AllowFirstMigration','-ExpectedLegacySha256',digest]);
  assert.equal(response.status,2,response.stderr);
  assert.match(response.stderr,/IDEMPOTENCY_PARENT_REPARSE_DENIED/);
});

test('Windows SQLite cutover refuses a hardlinked DB and a hardlinked WAL companion', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-ai06-file-link-'));
  t.after(async()=>fs.rm(root,{recursive:true,force:true}));
  const sid=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],
  {encoding:'utf8',windowsHide:true});
  assert.equal(sid.status,0,sid.stderr);
  const acl=spawnSync('icacls.exe',[root,'/inheritance:r','/grant:r',
    '*'+sid.stdout.trim()+':(OI)(CI)F'],{encoding:'utf8',windowsHide:true});
  assert.equal(acl.status,0,acl.stderr);
  const source=path.join(root,'source.db');
  const db=new DatabaseSync(source);
  try{db.exec('CREATE TABLE fixture (id INTEGER PRIMARY KEY)');}finally{db.close();}
  const sqlite=path.join(root,'idempotency-records.sqlite');
  await fs.link(source,sqlite);
  const aliasedDb=run(root,'sqlite');
  assert.equal(aliasedDb.status,2,aliasedDb.stderr);
  assert.match(aliasedDb.stderr,/IDEMPOTENCY_SQLITE_FILE_ALIAS_DENIED/);
  await fs.unlink(sqlite);
  await fs.rename(source,sqlite);
  const walSource=path.join(root,'wal-source.bin');
  await fs.writeFile(walSource,'not a valid sqlite WAL');
  await fs.link(walSource,path.join(root,'idempotency-records.sqlite-wal'));
  const aliasedWal=run(root,'sqlite');
  assert.equal(aliasedWal.status,2,aliasedWal.stderr);
  assert.match(aliasedWal.stderr,/IDEMPOTENCY_SQLITE_FILE_ALIAS_DENIED/);
  await fs.unlink(path.join(root,'idempotency-records.sqlite-wal'));
  await fs.link(walSource,path.join(root,'idempotency-records.sqlite-shm'));
  const aliasedShm=run(root,'sqlite');
  assert.equal(aliasedShm.status,2,aliasedShm.stderr);
  assert.match(aliasedShm.stderr,/IDEMPOTENCY_SQLITE_FILE_ALIAS_DENIED/);
  await fs.unlink(path.join(root,'idempotency-records.sqlite-shm'));
  const legacySource=path.join(root,'legacy-source.json');
  await fs.writeFile(legacySource,JSON.stringify({version:1,records:[]}));
  await fs.link(legacySource,path.join(root,'idempotency-records.json'));
  const aliasedLegacy=run(root,'sqlite');
  assert.equal(aliasedLegacy.status,2,aliasedLegacy.stderr);
  assert.match(aliasedLegacy.stderr,/IDEMPOTENCY_SQLITE_FILE_ALIAS_DENIED/);
});
