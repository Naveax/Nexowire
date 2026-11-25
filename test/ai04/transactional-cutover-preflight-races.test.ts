/** Portable race and child-crash regressions; no real tasks or live state. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {
  runRecoverableSystemHubCutover,SystemCutoverFailed,type SystemCutoverOperations,
} from '../../src/hub/system-cutover-orchestrator.js';
import {
  assertSystemCutoverDiskReserve,SYSTEM_CUTOVER_STATE_PROBE_PATH,
  SYSTEM_CUTOVER_MINIMUM_FREE_BYTES,SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES,
} from '../../src/hub/system-cutover-disk-reserve.js';

const steps=['preflight','armRecovery','confirmRecoveryBeforeQuiesce',
  'quiesceLegacy','copyProtectedState','issueReceipt','installSystemHub',
  'verifySystemHub','commit','rollback'] as const;
function fixtureAdapter(){
  const events:string[]=[];
  const ops={} as SystemCutoverOperations;
  for(const step of steps)ops[step]=async()=>{events.push(step)};
  return {ops,events};
}

for(const boundary of ['before-quiesce','before-receipt'] as const){
  test('headroom loss '+boundary+' cannot reuse a successful preflight',async()=>{
    const profile='D:\\Profiles\\fixture',source='E:\\StateMount\\fixture';
    for(const lowPath of [SYSTEM_CUTOVER_STATE_PROBE_PATH,profile,source]){
      const {ops,events}=fixtureAdapter();
      let depleted=false;
      const read=async(probe:string)=>{
        assert.ok([SYSTEM_CUTOVER_STATE_PROBE_PATH,profile,source].includes(probe));
        return {bsize:1,bavail:Number(depleted&&probe===lowPath?
          SYSTEM_CUTOVER_MINIMUM_FREE_BYTES-1n:SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES)};
      };
      ops.preflight=async()=>{
        events.push('preflight');
        assert.equal((await assertSystemCutoverDiskReserve(read,profile,source)).recommendedReserveMet,true);
      };
      ops.confirmRecoveryBeforeQuiesce=async()=>{
        events.push('confirmRecoveryBeforeQuiesce');
        depleted=boundary==='before-quiesce';
        await assertSystemCutoverDiskReserve(read,profile,source);
      };
      ops.issueReceipt=async()=>{
        events.push('issueReceipt');depleted=true;
        await assertSystemCutoverDiskReserve(read,profile,source);
      };
      await assert.rejects(runRecoverableSystemHubCutover(ops),(error:unknown)=>{
        assert.ok(error instanceof SystemCutoverFailed);
        assert.equal(error.failedStep,boundary==='before-quiesce'?'arm-recovery':'issue-receipt');
        assert.equal(error.rollbackAttempted,boundary==='before-receipt');
        assert.equal(error.rollbackFailed,false);
        assert.match(String(error.cause),/AI04_CUTOVER_DISK_RESERVE_INSUFFICIENT/);
        return true;
      });
      assert.deepEqual(events,boundary==='before-quiesce'?[
        'preflight','armRecovery','confirmRecoveryBeforeQuiesce',
      ]:[
        'preflight','armRecovery','confirmRecoveryBeforeQuiesce','quiesceLegacy',
        'copyProtectedState','issueReceipt','rollback',
      ]);
    }
  });
}

test('abrupt disposable copy-worker exit preserves fsynced stage and recovery evidence',async(t)=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'nx-ai02-copy-worker-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const source=path.join(dir,'source.sqlite'),stage=path.join(dir,'stage.sqlite');
  const journal=path.join(dir,'copy-evidence.json'),receipt=path.join(dir,'receipt.json');
  const original=new DatabaseSync(source);
  try{original.exec('CREATE TABLE records (id INTEGER PRIMARY KEY); INSERT INTO records VALUES (1);')}
  finally{original.close()}
  const sha=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
  const before=sha(source);
  const evidence={phase:'COPIED',sourceSha256:before};
  const {ops,events}=fixtureAdapter();
  ops.copyProtectedState=async()=>{
    events.push('copyProtectedState');
    const child=spawnSync(process.execPath,['--input-type=module','-e',[
      "import {copyFileSync,openSync,closeSync,fsyncSync,writeFileSync,writeSync} from 'node:fs';",
      'const [source,stage,journal,evidence]=process.argv.slice(1);',
      'copyFileSync(source,stage);',
      "const data=openSync(stage,'r+');try{fsyncSync(data)}finally{closeSync(data)}",
      "const log=openSync(journal,'wx');try{writeFileSync(log,evidence);fsyncSync(log)}finally{closeSync(log)}",
      "writeSync(1,'AI04_DISPOSABLE_STAGE_SYNCED');",
      "process.kill(process.pid,'SIGKILL');",
    ].join('\n'),source,stage,journal,JSON.stringify(evidence)],{
      encoding:'utf8',timeout:15000,windowsHide:true,
    });
    assert.equal(child.error,undefined);
    assert.equal(child.stdout,'AI04_DISPOSABLE_STAGE_SYNCED');
    if(process.platform==='win32')assert.ok(child.signal||child.status!==0);
    else assert.equal(child.signal,'SIGKILL');
    throw new Error('FI_COPY_WORKER_EXITED_BEFORE_RECEIPT');
  };
  ops.rollback=async()=>{
    events.push('rollback');
    assert.equal(sha(source),before);assert.equal(sha(stage),before);
    assert.deepEqual(JSON.parse(readFileSync(journal,'utf8')),evidence);
    assert.equal(existsSync(receipt),false);
  };
  await assert.rejects(runRecoverableSystemHubCutover(ops),(error:unknown)=>{
    assert.ok(error instanceof SystemCutoverFailed);
    assert.equal(error.failedStep,'copy-protected-state');
    assert.equal(error.rollbackAttempted,true);
    assert.equal(error.rollbackFailed,false);
    assert.match(String(error.cause),/FI_COPY_WORKER_EXITED_BEFORE_RECEIPT/);
    return true;
  });
  assert.deepEqual(events,['preflight','armRecovery','confirmRecoveryBeforeQuiesce',
    'quiesceLegacy','copyProtectedState','rollback']);
  for(const file of [source,stage]){
    assert.equal(sha(file),before);
    const db=new DatabaseSync(file,{readOnly:true});
    try{
      assert.equal(db.prepare('PRAGMA quick_check').get()?.quick_check,'ok');
      assert.equal(db.prepare('SELECT count(*) AS count FROM records').get()?.count,1);
    }finally{db.close()}
    assert.equal(sha(file),before);
  }
  assert.deepEqual(JSON.parse(readFileSync(journal,'utf8')),evidence);
  assert.equal(existsSync(receipt),false);
});
