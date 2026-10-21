import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,copyFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AgentOperationJournal} from '../src/agent/operation-journal.js';

// RED source contract: a once-reserved mutation must not be re-admitted after
// restoring a valid stale snapshot. This tests merged main's journal only.
// PR #582 co-rollback of journal AND authority is a separate P0 proof (#587).
test('QA #587: old journal snapshot must not re-admit a completed mutation',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'qa16-stale-reservation-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:80}));
  const live=path.join(root,'journal.sqlite');
  const old=path.join(root,'pre-request.sqlite');
  const restored=path.join(root,'restored.sqlite');
  const oldId=randomUUID(),laterId=randomUUID(),fingerprint='7'.repeat(64);
  const first=new AgentOperationJournal(live);
  try{
    await first.begin(oldId,fingerprint,'files.write');
    await first.markDispatched(oldId,fingerprint);
    await first.complete(oldId,'succeeded',undefined,undefined,fingerprint);
  }finally{first.close()}
  await copyFile(live,old);
  const later=new AgentOperationJournal(live);
  try{
    const reservation=await later.begin(laterId,fingerprint,'files.write');
    assert.equal(reservation.created,true);
    await later.markDispatched(laterId,fingerprint);
    await later.complete(laterId,'succeeded',undefined,undefined,fingerprint);
  }finally{later.close()}
  await copyFile(old,restored);
  const after=new AgentOperationJournal(restored);
  try{
    assert.equal((await after.inspect(oldId))?.status,'succeeded');
    const duplicate=await after.begin(laterId,fingerprint,'files.write');
    // Intentionally RED. No second dispatch or mutation occurs in this test.
    assert.equal(duplicate.created,false,
      'P0 #587: old restored SQLite admitted an already completed requestId; '+
      'require an independent trusted anti-rollback reservation authority');
  }finally{after.close()}
});
