import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {AgentOperationJournal} from '../../src/agent/operation-journal.js';
import {readJournalOwnerProcess} from '../../src/agent/journal-owner-process.js';

// Disposable process + SQLite fixtures only. Never open an installed Agent journal.
async function fixture(t:import('node:test').TestContext){
  const dir=await mkdtemp(path.join(os.tmpdir(),'nw-ai04-os-owner-'));
  const cleanups:Array<()=>void|Promise<void>>=[];
  t.after(async()=>{
    // Close SQLite handles and child processes before removing files on Windows.
    for(const cleanup of cleanups.reverse())await cleanup();
    await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  const file=path.join(dir,'operations.sqlite');
  const id=randomUUID();
  const journal=new AgentOperationJournal(file);
  try {
    await journal.begin(id,'a'.repeat(64),'files.write');
    await journal.complete(id,'succeeded');
  } finally {
    journal.close();
  }
  return {file,id,cleanup:(fn:()=>void|Promise<void>)=>cleanups.push(fn)};
}

test('external live OS incarnation denies takeover; confirmed death preserves UNKNOWN/no-replay',
  {timeout:120000},async t=>{
    const {file,id,cleanup}=await fixture(t);
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    assert.ok(child.pid&&Number.isSafeInteger(child.pid),'disposable owner worker must start');
    let exited=false;
    const closed=new Promise<void>(resolve=>child.once('close',()=>{exited=true;resolve();}));
    cleanup(async()=>{
      if(!exited){child.kill('SIGKILL');await closed;}
    });
    const observed=await readJournalOwnerProcess(child.pid!);
    if(process.platform==='win32')
      assert.equal(observed.state,'alive','Windows OS incarnation readback is mandatory');
    if(observed.state!=='alive'){
      t.skip('OS incarnation unavailable; unknown must never authorize takeover');
      return;
    }
    const seeded=new DatabaseSync(file);
    try {
      seeded.prepare("UPDATE agent_operation_journal SET status='in_progress' WHERE request_id=?")
        .run(id);
      seeded.prepare('INSERT INTO agent_operation_owner(id,pid,nonce,process_identity) VALUES(1,?,?,?)')
        .run(child.pid,randomUUID(),observed.identity);
    } finally {seeded.close();}
    const contender=new AgentOperationJournal(file);
    cleanup(()=>contender.close());
    await assert.rejects(contender.initialize(),{code:'AGENT_JOURNAL_IN_USE'});
    const readback=new DatabaseSync(file,{readOnly:true});
    try {
      assert.equal((readback.prepare('SELECT status FROM agent_operation_journal WHERE request_id=?')
        .get(id) as {status:string}).status,'in_progress',
      'a contender cannot reconcile a request while its real owner is alive');
    } finally {readback.close();}
    child.kill('SIGKILL');
    await closed;
    await contender.initialize();
    assert.equal((await contender.inspect(id))?.status,'unknown',
      'an interrupted reservation remains UNKNOWN after positive owner death');
    const retry=await contender.begin(id,'a'.repeat(64),'files.write');
    assert.equal(retry.created,false,'a previous request ID cannot be replayed');
    assert.equal(retry.record.status,'unknown');
  });

test('malformed nonce and forged incarnation cannot reclaim a live owner',
  {timeout:120000},async t=>{
    const {file,id,cleanup}=await fixture(t);
    const self=await readJournalOwnerProcess(process.pid);
    if(process.platform==='win32')
      assert.equal(self.state,'alive','Windows process incarnation readback is mandatory');
    const seeded=new DatabaseSync(file);
    try {
      seeded.prepare('INSERT INTO agent_operation_owner(id,pid,nonce,process_identity) VALUES(1,?,?,?)')
        .run(process.pid,'not-a-uuid',self.state==='alive'?self.identity:null);
    } finally {seeded.close();}
    const contender=new AgentOperationJournal(file);
    cleanup(()=>contender.close());
    await assert.rejects(contender.initialize(),{code:'AGENT_JOURNAL_IN_USE'});
    const edited=new DatabaseSync(file);
    try {
      edited.prepare('UPDATE agent_operation_owner SET nonce=?,process_identity=? WHERE id=1')
        .run(randomUUID(),'untrusted:invented-incarnation');
    } finally {edited.close();}
    await assert.rejects(contender.initialize(),{code:'AGENT_JOURNAL_IN_USE'});
    const readback=new DatabaseSync(file,{readOnly:true});
    try {
      assert.equal((readback.prepare('SELECT status FROM agent_operation_journal WHERE request_id=?')
        .get(id) as {status:string}).status,'succeeded');
    } finally {readback.close();}
  });


test('actual child journal writer: crash releases PID incarnation, preserves UNKNOWN and never replays',
  {timeout:120000},async t=>{
    // A separate Node process holds a genuine journal-owned SQLite mutation
    // lease. Unlike seeded owner-row tests this exercises real cross-process
    // connection lifetime, abrupt exit, SQLite WAL recovery and OS readback.
    const {file,cleanup}=await fixture(t);
    const id=randomUUID();
    const script=[
      'import {AgentOperationJournal} from '+
        JSON.stringify(new URL('../../src/agent/operation-journal.ts',import.meta.url).href)+';',
      'const journal=new AgentOperationJournal(process.argv[1]);',
      // The PID alone does not keep a SQLite handle alive: the -e module
      // and its unreferenced bindings can be collected after evaluation.
      // Root the actual owner for the entire disposable child lifetime.
      'globalThis.__nwHeldJournalFixture=journal;',
      'const announceReady=()=>setImmediate(()=>{',
      '  globalThis.gc();',
      '  setImmediate(()=>{globalThis.gc();process.send?.({ready:true});});',
      '});',
      'try {',
      "  await journal.begin(process.argv[2], 'b'.repeat(64), 'files.write');",
      '  announceReady();',
      '} catch(error) {',
      '  process.send?.({error:String(error)});',
      '  process.exit(70);',
      '}',
      'setInterval(()=>{},1000);',
    ].join('\n');
    let stderr='';
    const worker=spawn(process.execPath,
      ['--expose-gc','--import','tsx','--input-type=module','-e',script,file,id],
      {stdio:['ignore','ignore','pipe','ipc']});
    assert.ok(worker.pid&&Number.isSafeInteger(worker.pid),
      'disposable cross-process journal owner must start');
    let exited=false;
    const closed=new Promise<void>(resolve=>worker.once('close',()=>{exited=true;resolve();}));
    worker.stderr?.on('data',chunk=>{
      stderr=(stderr+String(chunk)).slice(-4000);
    });
    cleanup(async()=>{
      if(!exited)worker.kill('SIGKILL');
      await closed;
    });
    const ready=await new Promise<{ready?:boolean;error?:string}>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('child journal writer startup timeout: '+stderr)),60000);
      const complete=(value:{ready?:boolean;error?:string})=>{clearTimeout(timer);resolve(value);};
      worker.once('message',value=>complete(value as {ready?:boolean;error?:string}));
      worker.once('error',e=>{clearTimeout(timer);reject(e);});
      worker.once('close',(code,signal)=>{
        clearTimeout(timer);
        reject(new Error('child journal owner exited before ready: '+code+'/'+signal+' '+stderr));
      });
    });
    assert.deepEqual(ready,{ready:true},'child writer must first durably reserve its own request');
    // The ready message is emitted only after two GC cycles. Require a
    // genuinely open WAL, not merely a still-running child PID.
    assert.equal(worker.exitCode,null);
    assert.ok((await stat(file+'-wal')).size>32,'live child must retain committed WAL after GC');
    assert.ok((await stat(file+'-shm')).size>=32768,'live child must retain WAL index after GC');
    const db=new DatabaseSync(file,{readOnly:true});
    try{
      const lease=db.prepare('SELECT pid,nonce,process_identity FROM agent_operation_owner WHERE id=1')
        .get() as {pid:number;nonce:string;process_identity:string|null};
      assert.equal(lease.pid,worker.pid);
      assert.ok(lease.process_identity,'real owner must durably persist OS incarnation');
      const row=db.prepare('SELECT fingerprint,status FROM agent_operation_journal WHERE request_id=?')
        .get(id) as {fingerprint:string;status:string};
      assert.equal(row.fingerprint,'b'.repeat(64));
      assert.equal(row.status,'in_progress');
    }finally{db.close();}
    const contender=new AgentOperationJournal(file);
    cleanup(()=>contender.close());
    await assert.rejects(contender.initialize(),{code:'AGENT_JOURNAL_IN_USE'});
    // Simulate unclean Agent exit: never call journal.close() in the child.
    worker.kill('SIGKILL');
    await closed;
    await contender.initialize();
    const unknown=await contender.inspect(id);
    assert.equal(unknown?.status,'unknown','crash recovery must preserve uncertainty');
    assert.equal(unknown?.fingerprint,'b'.repeat(64));
    const duplicate=await contender.begin(id,'b'.repeat(64),'files.write');
    assert.equal(duplicate.created,false,'original journal request cannot execute twice');
    assert.equal(duplicate.record.status,'unknown');
    await assert.rejects(
      contender.begin(id,'c'.repeat(64),'files.write'),
      {code:'AGENT_JOURNAL_REQUEST_MISMATCH'},
      'the recovered request ID must reject new payload fingerprints');
  });
