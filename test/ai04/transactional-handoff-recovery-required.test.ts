/** Cross-owner handoff contract: real disposable SQLite, injected recovery only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFileSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {
  runRecoverableSystemHubCutover,SystemCutoverFailed,type SystemCutoverOperations,
} from '../../src/hub/system-cutover-orchestrator.js';

const digest=(file:string):string=>createHash('sha256').update(readFileSync(file)).digest('hex');
const readRows=(file:string)=>{
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    assert.equal(db.prepare('PRAGMA quick_check').get()?.quick_check,'ok');
    return db.prepare('SELECT id, state FROM records ORDER BY id').all().map(row=>({...row}));
  }finally{db.close()}
};

for(const scenario of ['equal','committed-write','unknown-readback'] as const){
  test('AI-01 RECOVERY_REQUIRED: '+scenario+' preserves evidence and reports recovery accurately',async(t)=>{
    const dir=mkdtempSync(path.join(os.tmpdir(),'nx-ai02-handoff-'));
    t.after(()=>rmSync(dir,{recursive:true,force:true}));
    const source=path.join(dir,'legacy.sqlite'),target=path.join(dir,'system.sqlite');
    const journal=path.join(dir,'journal.json');
    const db=new DatabaseSync(source);
    try{db.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, state TEXT); INSERT INTO records VALUES(1,'KNOWN')")}
    finally{db.close()}
    const before=digest(source);
    const events:string[]=[];
    const step=(name:string)=>async()=>{events.push(name)};
    const installFailure=new Error('HUB_BOOT_HANDOFF_RECOVERY_REQUIRED',{cause:new Error('FI_HANDOFF_RECEIPT_UNKNOWN')});
    const denied=new Error(scenario==='committed-write'?'AI04_ROLLBACK_UNRECONCILED_SYSTEM_WRITES':'FI_RECOVERY_READBACK_UNKNOWN');
    let targetAfterInstall:string|undefined;
    const evidence={phase:'SYSTEM_INSTALLING',marker:'disposable-handoff',sourceSha256:before};
    let legacyRestoreCount=0;
    const ops:SystemCutoverOperations={
      preflight:step('preflight'),armRecovery:step('armRecovery'),
      confirmRecoveryBeforeQuiesce:step('confirmRecoveryBeforeQuiesce'),
      quiesceLegacy:step('quiesceLegacy'),
      async copyProtectedState(){events.push('copyProtectedState');copyFileSync(source,target)},
      issueReceipt:step('issueReceipt'),
      async installSystemHub(){
        events.push('installSystemHub');
        writeFileSync(journal,JSON.stringify(evidence));
        if(scenario==='committed-write'){
          const writer=new DatabaseSync(target);
          try{writer.exec("INSERT INTO records VALUES(2,'UNKNOWN')")}finally{writer.close()}
        }
        targetAfterInstall=digest(target);
        throw installFailure;
      },
      verifySystemHub:step('verifySystemHub'),commit:step('commit'),
      async rollback(){
        events.push('rollback');
        // Synthetic independent recovery oracle: no Windows task or network calls.
        assert.deepEqual(JSON.parse(readFileSync(journal,'utf8')),evidence);
        assert.equal(digest(source),before);
        if(scenario==='unknown-readback'||digest(target)!==before)throw denied;
        legacyRestoreCount++;
        writeFileSync(journal,JSON.stringify({...evidence,phase:'ROLLED_BACK'}));
      },
    };
    await assert.rejects(runRecoverableSystemHubCutover(ops),(error:unknown)=>{
      assert.ok(error instanceof SystemCutoverFailed);
      assert.equal(error.failedStep,'install-system-hub');
      assert.equal(error.rollbackAttempted,true);
      assert.equal(error.rollbackFailed,scenario!=='equal');
      if(scenario==='equal')assert.equal(error.cause,installFailure);
      else{
        assert.ok(error.cause instanceof AggregateError);
        assert.deepEqual(error.cause.errors,[installFailure,denied]);
      }
      return true;
    });
    assert.deepEqual(events,['preflight','armRecovery','confirmRecoveryBeforeQuiesce',
      'quiesceLegacy','copyProtectedState','issueReceipt','installSystemHub','rollback']);
    assert.equal(legacyRestoreCount,scenario==='equal'?1:0);
    assert.equal(digest(source),before);
    assert.equal(digest(target),targetAfterInstall);
    assert.deepEqual(readRows(source),[{id:1,state:'KNOWN'}]);
    assert.deepEqual(readRows(target),scenario==='committed-write'?
      [{id:1,state:'KNOWN'},{id:2,state:'UNKNOWN'}]:[{id:1,state:'KNOWN'}]);
    assert.deepEqual(JSON.parse(readFileSync(journal,'utf8')),
      {...evidence,phase:scenario==='equal'?'ROLLED_BACK':'SYSTEM_INSTALLING'});
  });
}
