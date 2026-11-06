import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {renderWindowsCutoverScript} from '../src/update/live-update.js';
import {renderWindowsHubSqliteReaderGuard} from '../src/update/windows-hub-sqlite-guard.js';

const full=renderWindowsCutoverScript({
  targetVersion:'1.0.9',buildId:'1.0.9-aabbccddeeff',
  targetRoot:'C:\\Users\\Owner\\AppData\\Local\\Nexowire\\versions\\1.0.9-aabbccddeeff',
  localAppData:'C:\\Users\\Owner\\AppData\\Local',
  homeDir:'C:\\Users\\Owner',
});
const index=(needle:string)=>full.indexOf(needle);

test('user updater proves SQLite reader before service stop and rechecks before rollback Hub restart',()=>{
  assert.ok(index('if($hadHub){Assert-HubSqliteReader $NewRoot}')>0);
  assert.ok(index('if($hadHub){Assert-HubSqliteReader $NewRoot}')<index('$CutoverStarted=$true'));
  assert.ok(index('if($hadHub){Assert-HubSqliteReader $NewRoot}')<index('Stop-ScheduledTask -TaskName $HubTask'));
  assert.ok(index('Assert-HubSqliteReader $HubPreviousRuntime')>index('Restore-Launchers'));
  assert.ok(index('Assert-HubSqliteReader $HubPreviousRuntime')<index('Start-ScheduledTask -TaskName $HubTask -ErrorAction Stop'));
  assert.match(full,/HUB_SQLITE_ROLLBACK:/);
  assert.match(full,/\$HubPreviousRuntime=\$null/);
  assert.match(full,/\$script:HubPreviousRuntime=\$old.Value/);
});

const win=process.platform==='win32';
function q(s:string){return "'"+s.replaceAll("'","''")+"'";}
function runGuard(launcher:string,stateDir:string,runtimeRoot:string){
  const script=[
    "$ErrorActionPreference='Stop'",
    '$HubLauncher='+q(launcher),
    '$HubDefaultStateDir='+q(stateDir),
    ...renderWindowsHubSqliteReaderGuard(),
    'try{Assert-HubSqliteReader '+q(runtimeRoot)+';[Console]::WriteLine("PREFLIGHT_OK");exit 0}',
    'catch{[Console]::Error.WriteLine($_.Exception.Message);exit 2}',
  ].join('\r\n');
  return spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',[
    '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
    Buffer.from(script,'utf16le').toString('base64'),
  ],{cwd:'C:\\Windows\\System32',encoding:'utf8',timeout:15000,windowsHide:true});
}

test('Windows preflight accepts SQLite-aware reader and denies JSON-only rollback without modifying the journal',{
  skip:!win,
},()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'nx-hub-sqlite-cutover-'));
  try{
    const state=path.join(root,'state'),current=path.join(root,'runtime');
    const reader=path.join(current,'app','dist','src','operations','idempotency-store.js');
    const launcher=path.join(root,'launch.ps1');
    mkdirSync(path.dirname(reader),{recursive:true});mkdirSync(state,{recursive:true});
    writeFileSync(launcher,"$env:NEXOWIRE_STATE_DIR="+q(state)+'\r\n');
    const db=new DatabaseSync(path.join(state,'idempotency-records.sqlite'));
    db.exec('CREATE TABLE fixture (id INTEGER PRIMARY KEY); INSERT INTO fixture(id) VALUES (1);');
    db.close();
    writeFileSync(reader,[
      'idempotency-records.sqlite','IDEMPOTENCY_HUB_WRITER_LOST','IDEMPOTENCY_LEGACY_JOURNAL_DRIFT'
    ].join('\n'));
    const ready=runGuard(launcher,path.join(root,'ignored-default'),current);
    assert.equal(ready.status,0,ready.stderr);
    assert.match(ready.stdout,/PREFLIGHT_OK/);
    writeFileSync(reader,"const file='idempotency-records.json';");
    const denied=runGuard(launcher,path.join(root,'ignored-default'),current);
    assert.equal(denied.status,2,denied.stderr);
    assert.match(denied.stderr,/IDEMPOTENCY_SQLITE_DOWNGRADE_DENIED/);
    const verify=new DatabaseSync(path.join(state,'idempotency-records.sqlite'),{readOnly:true});
    assert.equal((verify.prepare('SELECT COUNT(*) AS count FROM fixture').get() as {count:number}).count,1);
    verify.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('Windows preflight refuses substituted SQLite header before trusting reader',{
  skip:!win,
},()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'nx-hub-header-'));
  try{
    const state=path.join(root,'hub'),runtime=path.join(root,'runtime');
    const file=path.join(runtime,'app','dist','src','operations','idempotency-store.js');
    const launcher=path.join(root,'launch.ps1');
    mkdirSync(state,{recursive:true});mkdirSync(path.dirname(file),{recursive:true});
    writeFileSync(launcher,'# disposable profile\r\n');
    writeFileSync(path.join(state,'idempotency-records.sqlite'),'not a SQLite ledger');
    writeFileSync(file,'idempotency-records.sqlite IDEMPOTENCY_HUB_WRITER_LOST IDEMPOTENCY_LEGACY_JOURNAL_DRIFT');
    const denied=runGuard(launcher,state,runtime);
    assert.equal(denied.status,2,denied.stderr);
    assert.match(denied.stderr,/IDEMPOTENCY_SQLITE_HEADER_INVALID/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
