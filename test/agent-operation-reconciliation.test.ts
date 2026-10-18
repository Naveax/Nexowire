import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AgentOperationJournal} from '../src/agent/operation-journal.js';
import {IdempotencyStore} from '../src/operations/idempotency-store.js';
import {reconcileAgentOperation} from '../src/operations/agent-operation-reconciliation.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {AgentBroker} from '../src/core/agent-broker.js';
import {ProviderRegistry} from '../src/core/provider-registry.js';
import {createNexowireMcpServer} from '../src/mcp/create-server.js';
import {WorkspaceStore} from '../src/workspace/store.js';
import {SkillRegistry} from '../src/skills/registry.js';

const fp='a'.repeat(64);
async function fixture(t:import('node:test').TestContext,limit?:number){
  const dir=await mkdtemp(path.join(os.tmpdir(),'nw-reconcile-v2-'));
  const file=path.join(dir,'journal.sqlite');
  const journals:AgentOperationJournal[]=[];
  const open=()=>{
    const j=new AgentOperationJournal(file,limit?{maxRecords:limit}:{});
    journals.push(j);
    return j;
  };
  t.after(async()=>{
    for(const j of journals)try{j.close()}catch{}
    await rm(dir,{recursive:true,force:true});
  });
  return {dir,file,open};
}

test('dispatch marker + fingerprint CAS enforce single execution intent',async t=>{
  const {open}=await fixture(t);
  const j=open(),id=randomUUID();
  await j.begin(id,fp,'shell.exec');
  await assert.rejects(j.markDispatched(id,'b'.repeat(64)),
    {code:'AGENT_JOURNAL_DISPATCH_DENIED'});
  const marked=await j.markDispatched(id,fp);
  assert.ok(marked.dispatchedAt);
  await assert.rejects(j.markDispatched(id,fp),
    {code:'AGENT_JOURNAL_DISPATCH_DENIED'});
  await assert.rejects(j.complete(id,'succeeded',undefined,undefined,
    'c'.repeat(64)),{code:'AGENT_JOURNAL_TRANSITION_DENIED'});
  const done=await j.complete(id,'succeeded',
    {processExitCode:0,taskSuccess:true,timedOut:false},
    {kind:'shell_exit',verified:true},fp);
  assert.equal(done.evidenceKind,'shell_exit');
  assert.equal(done.evidenceVerified,true);
  await assert.rejects(j.complete(id,'failed'),
    {code:'AGENT_JOURNAL_TRANSITION_DENIED'});
});

test('live independent opener denied; crashed request recovers as unknown',async t=>{
  const {open}=await fixture(t);
  const original=open(),id=randomUUID();
  await original.begin(id,fp,'files.write');
  const second=open();
  await assert.rejects(second.inspect(id),{code:'AGENT_JOURNAL_IN_USE'});
  original.close();
  assert.equal((await second.inspect(id))?.status,'unknown');
  assert.equal((await second.begin(id,fp,'files.write')).created,false);
});

test('archive keeps durable tombstones and never archives UNKNOWN',async t=>{
  const {file,open}=await fixture(t,1);
  const j=open(),oldId=randomUUID();
  await j.begin(oldId,fp,'files.write');
  await j.complete(oldId,'succeeded',undefined,
    {kind:'file_write_ack',verified:false});
  assert.equal(await j.archiveCompleted('2100-01-01T00:00:00.000Z'),1);
  assert.equal((await j.inspect(oldId))?.archived,true);
  assert.equal((await j.begin(oldId,fp,'files.write')).created,false);
  const unknownId=randomUUID();
  await j.begin(unknownId,fp,'windows.service.control');
  assert.equal(await j.archiveCompleted('2100-01-01T00:00:00.000Z'),0);
  await assert.rejects(j.begin(randomUUID(),fp,'shell.exec'),
    {code:'AGENT_JOURNAL_FULL'});
  j.close();
  const reopened=open();
  assert.equal((await reopened.inspect(oldId))?.status,'succeeded');
  assert.equal((await reopened.inspect(unknownId))?.status,'unknown');
  await reopened.checkpoint();
  const bytes=await readFile(file);
  assert.ok(bytes.length>0);
  assert.equal(bytes.includes(Buffer.from('CANARY_SUPER_SECRET')),false);
});

test('Hub offline recovery via exact operation ID does not invent Agent proof',async t=>{
  const {dir}=await fixture(t);
  const store=new IdempotencyStore(path.join(dir,'hub'));
  const begun=await store.begin({
    key:'offline-reconciliation-1',fingerprint:fp,
    targetId:'test-device',capability:'shell.exec',
  });
  await store.complete(begun.record.key,'unknown');
  const record=await store.getByOperationId(begun.record.operationId);
  assert.equal(record?.operationId,begun.record.operationId);
  const offline=reconcileAgentOperation({
    operationId:record!.operationId,capability:'shell.exec',fingerprint:fp,
    hubRecord:record,agentOnline:false,
  });
  assert.equal(offline.state,'unknown');
  assert.equal(offline.reason,'agent_offline');
  assert.equal(offline.hubStatus,'unknown');
  assert.equal(offline.automaticallyRetryable,false);
  assert.equal(offline.externalSideEffectProven,false);
  assert.equal(await store.getByOperationId(randomUUID()),undefined);
});

test('Agent terminal ACK with matching fingerprint is not physical proof',async t=>{
  const {open}=await fixture(t);
  const j=open(),id=randomUUID();
  await j.begin(id,fp,'windows.service.control');
  await j.markDispatched(id,fp);
  const record=await j.complete(id,'succeeded',undefined,
    {kind:'service_readback',verified:false},fp);
  const good=reconcileAgentOperation({
    operationId:id,capability:'windows.service.control',
    fingerprint:fp,agentOnline:true,agentRecord:record,
  });
  assert.equal(good.state,'agent_confirmed');
  assert.equal(good.evidenceKind,'service_readback');
  assert.equal(good.externalSideEffectProven,false);
  const wrong=reconcileAgentOperation({
    operationId:id,capability:'windows.service.control',
    fingerprint:'b'.repeat(64),agentOnline:true,agentRecord:record,
  });
  assert.equal(wrong.state,'unknown');
  assert.equal(wrong.reason,'journal_mismatch');
  const missing=reconcileAgentOperation({
    operationId:randomUUID(),capability:'windows.service.control',
    fingerprint:fp,agentOnline:true,
  });
  assert.equal(missing.state,'unknown');
  assert.equal(missing.reason,'record_missing');
});

test('old v1 SQLite schema migrates without deleting existing data',async t=>{
  const {file,open}=await fixture(t);
  const db=new DatabaseSync(file);
  db.exec('CREATE TABLE agent_operation_journal ('+
    'request_id TEXT PRIMARY KEY NOT NULL,fingerprint TEXT NOT NULL,'+
    'capability TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,'+
    'updated_at TEXT NOT NULL,process_exit_code INTEGER,task_success INTEGER,'+
    'timed_out INTEGER,has_execution INTEGER NOT NULL DEFAULT 0)');
  const id=randomUUID(),now=new Date().toISOString();
  db.prepare('INSERT INTO agent_operation_journal '+
    '(request_id,fingerprint,capability,status,created_at,updated_at) '+
    'VALUES(?,?,?,?,?,?)').run(id,fp,'files.write','succeeded',now,now);
  db.close();
  const j=open();
  assert.equal((await j.inspect(id))?.status,'succeeded');
  assert.equal((await j.begin(id,fp,'files.write')).created,false);
});

test('Hub capacity refuses new reservation without evicting UNKNOWN',async t=>{
  const {dir}=await fixture(t);
  const store=new IdempotencyStore(path.join(dir,'bounded-hub'),1);
  const a=await store.begin({key:'retained-key',fingerprint:fp,
    targetId:'device',capability:'files.write'});
  await store.complete(a.record.key,'unknown');
  await assert.rejects(store.begin({key:'blocked-key',fingerprint:fp,
    targetId:'device',capability:'files.write'}),
    {code:'IDEMPOTENCY_STORE_FULL'});
  assert.equal((await store.get('retained-key'))?.status,'unknown');
  assert.equal(await store.get('blocked-key'),undefined);
  const restarted=new IdempotencyStore(path.join(dir,'bounded-hub'),1);
  assert.equal((await restarted.get('retained-key'))?.status,'unknown');
});

test('MCP operator queries offline Hub status by operation UUID without foreign disclosure',async t=>{
  const {dir}=await fixture(t);
  const store=new IdempotencyStore(path.join(dir,'mcp'));
  const authorized=await store.begin({
    key:'offline-allowed',fingerprint:fp,
    targetId:'allowed-device',capability:'files.write',
  });
  const foreign=await store.begin({
    key:'offline-foreign',fingerprint:fp,
    targetId:'foreign-device',capability:'files.write',
  });
  await store.complete(authorized.record.key,'unknown');
  await store.complete(foreign.record.key,'succeeded');
  const broker=new AgentBroker();
  const providers=new ProviderRegistry();
  const server=createNexowireMcpServer({
    broker,providers,idempotency:store,
    toolAuthorization:{
      kind:'stored',scope:'mcp',
      credential:{id:'test-operator',scope:'mcp',
        role:'operator',createdAt:'2026-10-18T00:00:00.000Z',
        allowedDeviceIds:['allowed-device']},
    },
    workspaces:new WorkspaceStore(dir),
    skills:new SkillRegistry(path.join(process.cwd(),'skills')),
  });
  const client=new Client({name:'offline-opid-check',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  try{
    await Promise.all([server.connect(b),client.connect(a)]);
    const result=await client.callTool({
      name:'operations_idempotency_list',
      arguments:{operation_id:authorized.record.operationId},
    });
    const records=(result.structuredContent as {
      records:Array<{operationId:string;status:string}>
    }).records;
    assert.equal(records.length,1);
    assert.equal(records[0]?.operationId,authorized.record.operationId);
    assert.equal(records[0]?.status,'unknown');
    const denied=await client.callTool({
      name:'operations_idempotency_list',
      arguments:{operation_id:foreign.record.operationId},
    });
    assert.deepEqual((denied.structuredContent as {records:unknown[]}).records,[]);
    const invalid=await client.callTool({
      name:'operations_idempotency_list',
      arguments:{key:'offline-allowed',operation_id:foreign.record.operationId},
    });
    assert.equal(invalid.isError,true);
    const repeat=await store.getByOperationId(authorized.record.operationId);
    assert.equal(repeat?.status,'unknown');
  }finally{
    await client.close();
    await server.close();
  }
});

test('forced child-process crash leaves durable UNKNOWN and denies concurrent owner',async t=>{
  const {file,open}=await fixture(t);
  const {spawn}=await import('node:child_process');
  const id=randomUUID();
  const source=new URL('../src/agent/operation-journal.ts',import.meta.url).href;
  const script=[
    'import {AgentOperationJournal} from '+JSON.stringify(source)+';',
    'const j=new AgentOperationJournal('+JSON.stringify(file)+');',
    'await j.begin('+JSON.stringify(id)+','+JSON.stringify(fp)+',"shell.exec");',
    'await j.markDispatched('+JSON.stringify(id)+','+JSON.stringify(fp)+');',
    'console.log("CHILD_READY");',
    'setInterval(()=>{},1000);',
  ].join('\n');
  const child=spawn(process.execPath,
    ['--import','tsx','--input-type=module','-e',script],
    {cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null && child.signalCode===null)child.kill()});
  try{
    await new Promise<void>((resolve,reject)=>{
      let data='',err='';
      const timer=setTimeout(()=>reject(new Error(
        'Test-only child failed to reserve within timeout: '+err.slice(0,500))),20000);
      child.stdout?.on('data',chunk=>{
        data+=String(chunk);
        if(data.includes('CHILD_READY')){clearTimeout(timer);resolve()}
      });
      child.stderr?.on('data',chunk=>{err+=String(chunk)});
      child.once('error',e=>{clearTimeout(timer);reject(e)});
      child.once('exit',code=>{
        if(!data.includes('CHILD_READY')){
          clearTimeout(timer);reject(new Error('Child exited '+code+': '+err.slice(0,500)));
        }
      });
    });
    const contender=open();
    await assert.rejects(contender.inspect(id),{code:'AGENT_JOURNAL_IN_USE'});
    assert.equal(child.kill('SIGKILL'),true);
    await new Promise<void>(resolve=>child.once('exit',()=>resolve()));
    const recovered=open();
    const result=await recovered.inspect(id);
    assert.equal(result?.status,'unknown');
    assert.ok(result?.dispatchedAt);
    assert.equal((await recovered.begin(id,fp,'shell.exec')).created,false);
  }finally{
    if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');
  }
});

test('corrupt WAL header fails closed before SQLite can silently reset it',async t=>{
  const {file,open}=await fixture(t);
  const j=open(),id=randomUUID();
  await j.begin(id,fp,'files.write');
  j.close();
  // Simulate a torn/invalid sidecar in a disposable isolated directory.
  await writeFile(file+'-wal',Buffer.from('INVALID SQLITE WAL HEADER'));
  const recovering=open();
  await assert.rejects(recovering.begin(randomUUID(),fp,'files.write'),
    {code:'AGENT_JOURNAL_WAL_CORRUPT'});
  assert.equal((await readFile(file+'-wal')).toString(),'INVALID SQLITE WAL HEADER');
});

test('SQLite page quota simulates SQLITE_FULL with no mutation dispatch',async t=>{
  const {file}=await fixture(t);
  const quota=new AgentOperationJournal(file,{maxPageGrowth:0});
  let committed=0;
  let failure:unknown;
  for(let i=0;i<1000;i++){
    try{
      await quota.begin(randomUUID(),fp,'files.write');
      committed++;
    }catch(e){failure=e;break}
  }
  assert.ok(committed<1000,'bounded page quota must eventually stop inserts');
  assert.ok(failure instanceof Error);
  assert.match(String(failure),/SQLITE_FULL|database or disk is full|database full/i);
  assert.ok(committed>=0);
  await assert.rejects(quota.begin(randomUUID(),fp,'files.write'));
  // Close before fixture cleanup on Windows; open SQLite files cannot unlink.
  try{quota.close()}catch{}
});
