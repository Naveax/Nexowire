import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AgentOperationJournal} from '../src/agent/operation-journal.js';

test('negative: lost ACK after mutation reservation must never re-dispatch automatically',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'qa16-lost-ack-'));
 const file=path.join(dir,'op.sqlite');
 const id=randomUUID(),fingerprint='a'.repeat(64);
 const first=new AgentOperationJournal(file);
 t.after(async()=>{try{first.close()}catch{}; await rm(dir,{recursive:true,force:true})});
 assert.equal((await first.begin(id,fingerprint,'files.delete')).created,true);
 first.close();
 const restarted=new AgentOperationJournal(file);
 try{
  const state=await restarted.inspect(id);
  assert.equal(state?.status,'unknown','a crash before outcome must be ambiguous');
  const again=await restarted.begin(id,fingerprint,'files.delete');
  assert.equal(again.created,false,'a stale result must not execute a second delete');
  assert.equal(again.record.status,'unknown');
  await assert.rejects(restarted.begin(id,'b'.repeat(64),'files.delete'),
    {code:'AGENT_JOURNAL_REQUEST_MISMATCH'});
  await assert.rejects(restarted.complete(id,'succeeded'),
    {code:'AGENT_JOURNAL_TRANSITION_DENIED'});
 }finally{restarted.close()}
});

test('negative: malformed shell execution cannot be finalized as valid metadata',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'qa16-bad-exit-'));
 const j=new AgentOperationJournal(path.join(dir,'op.sqlite'));
 t.after(async()=>{j.close();await rm(dir,{recursive:true,force:true})});
 const id=randomUUID();
 await j.begin(id,'c'.repeat(64),'shell.exec');
 await assert.rejects(j.complete(id,'succeeded',{
  processExitCode:Number.NaN,taskSuccess:true,timedOut:false,
 }),{code:'AGENT_JOURNAL_OUTCOME_INVALID'});
 assert.equal((await j.inspect(id))?.status,'in_progress');
 await j.complete(id,'unknown');
 assert.equal((await j.inspect(id))?.status,'unknown');
});
