/** Native SQLite failures in disposable DBs; simulated adapter, no physical rollback. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFileSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {
  runRecoverableSystemHubCutover,SystemCutoverFailed,type SystemCutoverOperations,
} from '../../src/hub/system-cutover-orchestrator.js';

const digest=(file:string):string=>createHash('sha256').update(readFileSync(file)).digest('hex');
const nativeCode=(error:unknown):number|undefined=>{
  if(!(error instanceof Error))return undefined;
  const code=(error as Error & {errcode?:unknown}).errcode;
  return typeof code==='number'?code&0xff:undefined;
};

function assertIntact(file:string,expectedSha:string):void{
  assert.equal(digest(file),expectedSha);
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    assert.equal(db.prepare('PRAGMA quick_check').get()?.quick_check,'ok');
    assert.equal(db.prepare('SELECT count(*) AS count FROM records').get()?.count,1);
    assert.equal(db.prepare('SELECT hex(value) AS value FROM records WHERE id=1').get()?.value,'0102');
  }finally{db.close()}
  assert.equal(digest(file),expectedSha);
}

for(const fault of [{name:'SQLITE_FULL',code:13},{name:'SQLITE_READONLY',code:8}] as const){
  for(const interrupted of [false,true]){
    test('native '+fault.name+' preserves both DBs and '+(interrupted?'reports interrupted recovery':'requests rollback once'),async(t)=>{
      const dir=mkdtempSync(path.join(os.tmpdir(),'nx-ai02-native-sqlite-'));
      t.after(()=>rmSync(dir,{recursive:true,force:true}));
      const source=path.join(dir,'source.sqlite'),stage=path.join(dir,'stage.sqlite');
      const original=new DatabaseSync(source);
      try{original.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value BLOB NOT NULL); INSERT INTO records VALUES (1, x'0102');")}
      finally{original.close()}
      const before=digest(source);
      const events:string[]=[];
      let nativeFailure:unknown;
      const recoveryFailure=new Error('FI_INTERRUPTED_RECOVERY');
      const step=(name:string)=>async()=>{events.push(name)};
      const ops:SystemCutoverOperations={
        preflight:step('preflight'),armRecovery:step('armRecovery'),
        confirmRecoveryBeforeQuiesce:step('confirmRecoveryBeforeQuiesce'),
        quiesceLegacy:step('quiesceLegacy'),
        async copyProtectedState(){
          events.push('copyProtectedState');
          copyFileSync(source,stage);
          const db=new DatabaseSync(stage,{readOnly:fault.code===8});
          try{
            if(fault.code===13){
              const pages=Number(db.prepare('PRAGMA page_count').get()?.page_count);
              assert.ok(Number.isSafeInteger(pages)&&pages>0);
              assert.equal(db.prepare('PRAGMA max_page_count='+pages).get()?.max_page_count,pages);
            }
            try{db.prepare('INSERT INTO records(value) VALUES (?)').run(Buffer.alloc(65536))}
            catch(error){nativeFailure=error;throw error}
            throw new Error('FI_EXPECTED_NATIVE_SQLITE_ERROR');
          }finally{db.close()}
        },
        issueReceipt:step('issueReceipt'),installSystemHub:step('installSystemHub'),
        verifySystemHub:step('verifySystemHub'),commit:step('commit'),
        async rollback(){
          events.push('rollback');
          assertIntact(source,before);assertIntact(stage,before);
          if(interrupted)throw recoveryFailure;
        },
      };
      await assert.rejects(runRecoverableSystemHubCutover(ops),(error:unknown)=>{
        assert.ok(error instanceof SystemCutoverFailed);
        assert.equal(error.failedStep,'copy-protected-state');
        assert.equal(error.rollbackAttempted,true);
        assert.equal(error.rollbackFailed,interrupted);
        assert.equal(error.outcomeUnknown,false);
        assert.equal(nativeCode(nativeFailure),fault.code);
        assert.equal((nativeFailure as {code?:unknown}).code,'ERR_SQLITE_ERROR');
        if(interrupted){
          assert.ok(error.cause instanceof AggregateError);
          assert.deepEqual(error.cause.errors,[nativeFailure,recoveryFailure]);
        }else assert.equal(error.cause,nativeFailure);
        return true;
      });
      assert.deepEqual(events,['preflight','armRecovery','confirmRecoveryBeforeQuiesce',
        'quiesceLegacy','copyProtectedState','rollback']);
      assertIntact(source,before);assertIntact(stage,before);
    });
  }
}
