/**
 * #18 source-only hostile concurrent migration/rollback acceptance.
 * Synthetic in-memory SQL-contract pool: NOT real PostgreSQL, remote CAS,
 * independently operated witness, or elevated Windows Broker.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm,stat,open} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AgentOperationJournal} from '../src/agent/operation-journal.js';
import {verifyAgentJournalWal} from '../src/agent/operation-journal-wal.js';
import {copy,fixture} from './fixtures/qa-18-migration-fixture.js';

const denied=(promise:Promise<unknown>,code:string)=>
  assert.rejects(promise,{code});

test('#18 migrate: reserved UUID stays globally fenced after signed re-pair',async()=>{
  const f=fixture();await f.enroll();
  const a=f.hub(),b=f.hub(),id=randomUUID();
  const original=await a.reserve(f.request(id));
  assert.equal(original.created,true);
  const localHubASnapshot=new Map([[id,'unknown']]);
  await f.delegation().change(f.change('bind_session',0));
  await f.delegation().change(f.change('grant_core',1));
  const newOwner=randomUUID(),newEpoch=randomUUID(),newSession=randomUUID();
  const migrated=await f.delegation().change(f.change('re_pair',2,{
    newOwnerId:newOwner,newDeviceEpoch:newEpoch,newSessionEpoch:newSession,
  }));
  assert.equal(migrated.mode,'NONE');
  f.sessions.add(newSession);
  const restoredLocalHubA=new Map(localHubASnapshot);
  assert.equal(restoredLocalHubA.get(id),'unknown');
  await denied(a.reserve(f.request(id)),'WITNESS_OWNER_UNAUTHORIZED');
  await denied(b.reserve(f.request(id,f.deviceId,newEpoch)),
    'WITNESS_REQUEST_ID_REUSED');
  assert.equal((await f.delegation().evaluate(f.identity(
    newOwner,f.deviceId,newEpoch,newSession))).mode,'NONE');
  assert.equal(f.pool.state.reservations.get(id)?.owner_id,f.ownerId);
  assert.equal(f.pool.state.reservations.get(id)?.epoch,f.epoch);
  assert.equal(f.pool.state.sequence,original.sequence);
});

test('#18 migrate: stale Hub A reserve passes principal then loses re-pair race',async()=>{
  const f=fixture();await f.enroll();
  await f.delegation().change(f.change('bind_session',0));
  await f.delegation().change(f.change('grant_core',1));
  const staleId=randomUUID(),gate=f.pool.pauseNextConnection();
  const stale=f.hub().reserve(f.request(staleId));
  await gate.entered;
  const owner=randomUUID(),epoch=randomUUID(),session=randomUUID();
  try{
    const result=await f.delegation().change(f.change('re_pair',2,{
      newOwnerId:owner,newDeviceEpoch:epoch,newSessionEpoch:session,
    }));
    assert.equal(result.mode,'NONE');
  }finally{gate.release();}
  await denied(stale,'WITNESS_OWNER_EPOCH_FENCED');
  assert.equal(f.pool.state.reservations.has(staleId),false);
  await denied(f.hub().reserve(f.request(staleId)),'WITNESS_OWNER_UNAUTHORIZED');
  f.sessions.add(session);
  assert.equal((await f.delegation().evaluate(f.identity(
    owner,f.deviceId,epoch,session))).corePersisted,false);
});

test('#18 migrate: stale Hub A CORE read cannot outlive Hub B revoke',async()=>{
  const f=fixture();await f.enroll();
  const a=f.delegation(),b=f.delegation();
  await a.change(f.change('bind_session',0));
  const oldSigned=f.change('grant_core',1);
  assert.equal((await a.change(oldSigned)).mode,'CORE');
  const gate=f.pool.pauseNextConnection();
  const staleRead=a.evaluate(f.identity());
  await gate.entered;
  try{
    const revoked=await b.change(f.change('revoke',2));
    assert.equal(revoked.mode,'NONE');
    assert.equal(revoked.generation,3);
  }finally{gate.release();}
  assert.equal((await staleRead).mode,'NONE');
  await denied(a.change(oldSigned),'DELEGATION_STALE_GENERATION');
  assert.equal((await f.delegation().evaluate(f.identity())).corePersisted,false);
});

test('#18 migrate: two simultaneous signed re-pairs cannot create split owners',async()=>{
  const f=fixture();await f.enroll();
  await f.delegation().change(f.change('bind_session',0));
  await f.delegation().change(f.change('grant_core',1));
  const historicId=randomUUID();await f.hub().reserve(f.request(historicId));
  const options=Array.from({length:2},()=>({
    owner:randomUUID(),epoch:randomUUID(),session:randomUUID(),
  }));
  const grants=options.map(o=>f.change('re_pair',2,{
    newOwnerId:o.owner,newDeviceEpoch:o.epoch,newSessionEpoch:o.session,
  }));
  const outcomes=await Promise.allSettled([
    f.delegation().change(grants[0]!),
    f.delegation().change(grants[1]!),
  ]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
  const winner=options[outcomes.findIndex(x=>x.status==='fulfilled')]!;
  const device=f.pool.state.devices.get(f.deviceId)!;
  const delegation=f.pool.state.delegations.get(f.deviceId)!;
  assert.equal(device.owner_id,winner.owner);
  assert.equal(device.epoch,winner.epoch);
  assert.equal(device.generation,2);
  assert.equal(delegation.owner_id,winner.owner);
  assert.equal(delegation.epoch,winner.epoch);
  assert.equal(delegation.session_epoch,winner.session);
  assert.equal(delegation.core_enabled,false);
  assert.equal(delegation.root_expires_ms,null);
  assert.equal(f.pool.state.reservations.has(historicId),true);
  f.sessions.add(winner.session);
  assert.equal((await f.delegation().evaluate(f.identity(
    winner.owner,f.deviceId,winner.epoch,winner.session))).mode,'NONE');
});

test('#18 migrate: two Hubs deny 32 historic UUID collisions after re-pair',async()=>{
  const f=fixture();await f.enroll();
  const id=randomUUID();await f.hub().reserve(f.request(id));
  await f.delegation().change(f.change('bind_session',0));
  const owner=randomUUID(),epoch=randomUUID(),session=randomUUID();
  await f.delegation().change(f.change('re_pair',1,{
    newOwnerId:owner,newDeviceEpoch:epoch,newSessionEpoch:session,
  }));
  const hubs=[f.hub(),f.hub()];
  const collisions=await Promise.allSettled(Array.from({length:32},(_,i)=>
    hubs[i%2]!.reserve(f.request(id,f.deviceId,epoch))));
  assert.equal(collisions.filter(x=>x.status==='fulfilled').length,0);
  for(const result of collisions){
    if(result.status==='rejected')
      assert.equal((result.reason as {code:string}).code,'WITNESS_REQUEST_ID_REUSED');
  }
  const freshId=randomUUID();
  const accepted=await Promise.all(Array.from({length:32},(_,i)=>
    hubs[i%2]!.reserve(f.request(freshId,f.deviceId,epoch))));
  assert.equal(accepted.filter(x=>x.created).length,1);
  assert.equal(new Set(accepted.map(x=>x.sequence)).size,1);
  assert.equal(f.pool.state.sequence,2);
  assert.equal(f.pool.state.reservations.size,2);
});

test('#18 migrate: unknown re-pair COMMIT ACK cannot restore revoked CORE',async()=>{
  const f=fixture();await f.enroll();
  const id=randomUUID();await f.hub().reserve(f.request(id));
  const before=copy(f.pool.state);
  const g=f.delegation();
  await g.change(f.change('bind_session',0));
  await g.change(f.change('grant_core',1));
  const owner=randomUUID(),epoch=randomUUID(),session=randomUUID();
  f.pool.loseCommitAck=true;
  await assert.rejects(g.change(f.change('re_pair',2,{
    newOwnerId:owner,newDeviceEpoch:epoch,newSessionEpoch:session,
  })),/SIMULATED_COMMIT_ACK_LOST/);
  assert.equal(f.pool.state.devices.get(f.deviceId)?.owner_id,owner);
  assert.equal(f.pool.state.delegations.get(f.deviceId)?.core_enabled,false);
  await denied(f.hub().reserve(f.request(id)),'WITNESS_OWNER_UNAUTHORIZED');
  f.sessions.add(session);
  assert.equal((await f.delegation().evaluate(f.identity(
    owner,f.deviceId,epoch,session))).mode,'NONE');
  assert.equal(f.pool.state.reservations.size,before.reservations.size);
});

test('#18 migrate: unavailable simulated SQL fails closed, real PG NOT TESTED',async()=>{
  const f=fixture();await f.enroll();
  await f.delegation().change(f.change('bind_session',0));
  const before=copy(f.pool.state);
  f.pool.available=false;
  await denied(f.hub().reserve(f.request()),'WITNESS_STORAGE_UNAVAILABLE');
  await denied(f.delegation().evaluate(f.identity()),
    'DELEGATION_STORAGE_UNAVAILABLE');
  assert.deepEqual(f.pool.state,before);
});

const fp='a'.repeat(64);
async function disposableCrashWal(t:import('node:test').TestContext,id:string){
  const dir=await mkdtemp(path.join(os.tmpdir(),'nexowire-qa18-wal-'));
  t.after(async()=>{await rm(dir,{recursive:true,force:true,maxRetries:4,retryDelay:40});});
  const file=path.join(dir,'test-only-agent-journal.sqlite');
  const childScript=[
    "import {AgentOperationJournal} from './src/agent/operation-journal.ts';",
    "const [file,id]=process.argv.slice(1);",
    "const journal=new AgentOperationJournal(file);",
    "await journal.begin(id,'a'.repeat(64),'files.write');",
    "await journal.markDispatched(id,'a'.repeat(64));",
    "process.stdout.write('DISPATCH_MARKED_IN_TEMP_WAL\\n');",
    "process.exit(77);",
  ].join('\n');
  const child=spawnSync(process.execPath,
    ['--import','tsx','--input-type=module','-e',childScript,file,id],
    {cwd:process.cwd(),encoding:'utf8',timeout:60_000});
  assert.equal(child.error,undefined,String(child.error));
  assert.equal(child.status,77,'Synthetic child failed: '+child.stderr);
  const wal=file+'-wal';
  assert.ok((await stat(wal)).size>32,'TEMP WAL must contain real SQLite frames');
  return {file,wal};
}

test('#18 migrate: crash retains TEMP uncheckpointed WAL => UNKNOWN, no replay',async t=>{
  const f=fixture();await f.enroll();
  const id=randomUUID();
  assert.equal((await f.hub().reserve(f.request(id))).created,true);
  const {file}=await disposableCrashWal(t,id);
  await verifyAgentJournalWal(file);
  const reopened=new AgentOperationJournal(file);
  try{
    const result=await reopened.inspect(id);
    assert.equal(result?.status,'unknown');
    assert.ok(result?.dispatchedAt);
    assert.equal((await f.hub().reserve(f.request(id))).created,false);
    assert.equal((await reopened.begin(id,fp,'files.write')).created,false);
    await denied(reopened.markDispatched(id,fp),'AGENT_JOURNAL_DISPATCH_DENIED');
    assert.equal(f.pool.state.reservations.size,1);
  }finally{reopened.close();}
});

test('#18 migrate: torn TEMP crash WAL fails closed before SQLite replay',async t=>{
  const f=fixture();await f.enroll();
  const id=randomUUID();await f.hub().reserve(f.request(id));
  const {file,wal}=await disposableCrashWal(t,id);
  const handle=await open(wal,'r+');
  try{await handle.write(Buffer.from([0]),0,1,0)}finally{await handle.close();}
  await denied(verifyAgentJournalWal(file),'AGENT_JOURNAL_WAL_CORRUPT');
  const reopened=new AgentOperationJournal(file);
  await denied(reopened.inspect(id),'AGENT_JOURNAL_WAL_CORRUPT');
  assert.equal((await f.hub().reserve(f.request(id))).created,false);
});
