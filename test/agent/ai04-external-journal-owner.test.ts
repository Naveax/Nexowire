import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {AgentOperationJournal} from '../../src/agent/operation-journal.js';
import {readJournalOwnerProcess} from '../../src/agent/journal-owner-process.js';

// Disposable process + SQLite fixtures only. Never open an installed Agent journal.
async function fixture(t:import('node:test').TestContext){
  const dir=await mkdtemp(path.join(os.tmpdir(),'nw-ai04-os-owner-'));
  t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const file=path.join(dir,'operations.sqlite');
  const id=randomUUID();
  const journal=new AgentOperationJournal(file);
  try {
    await journal.begin(id,'a'.repeat(64),'files.write');
    await journal.complete(id,'succeeded');
  } finally {
    journal.close();
  }
  return {file,id};
}

test('external live OS incarnation denies takeover; confirmed death preserves UNKNOWN/no-replay',
  {timeout:120000},async t=>{
    const {file,id}=await fixture(t);
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    assert.ok(child.pid&&Number.isSafeInteger(child.pid),'disposable owner worker must start');
    let exited=false;
    const closed=new Promise<void>(resolve=>child.once('close',()=>{exited=true;resolve();}));
    t.after(async()=>{
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
    t.after(()=>contender.close());
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
    const {file,id}=await fixture(t);
    const self=await readJournalOwnerProcess(process.pid);
    if(process.platform==='win32')
      assert.equal(self.state,'alive','Windows process incarnation readback is mandatory');
    const seeded=new DatabaseSync(file);
    try {
      seeded.prepare('INSERT INTO agent_operation_owner(id,pid,nonce,process_identity) VALUES(1,?,?,?)')
        .run(process.pid,'not-a-uuid',self.state==='alive'?self.identity:null);
    } finally {seeded.close();}
    const contender=new AgentOperationJournal(file);
    t.after(()=>contender.close());
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
