import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AgentOperationJournal} from '../src/agent/operation-journal.js';
import {PathPolicy} from '../src/agent/path-policy.js';
import {executeCapability} from '../src/agent/executors.js';

test('operator status capability reads exactly one metadata-only Agent request',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'nw-opstatus-'));
  const journal=new AgentOperationJournal(path.join(dir,'status.sqlite'));
  t.after(async()=>{journal.close();await rm(dir,{recursive:true,force:true})});
  const id=randomUUID();
  await journal.begin(id,'a'.repeat(64),'files.delete');
  const policy=new PathPolicy([dir]);
  const result=await executeCapability('agent.operation.status',{
    request_id:id,
  },policy,{operationJournal:journal}) as {
    data:{found:boolean;record?:{requestId:string;status:string;fingerprint:string}}
  };
  assert.equal(result.data.found,true);
  assert.equal(result.data.record?.requestId,id);
  assert.equal(result.data.record?.status,'in_progress');
  assert.equal(result.data.record?.fingerprint,'a'.repeat(64));
  assert.equal('input' in (result.data.record??{}),false);
  assert.equal('command' in (result.data.record??{}),false);
  assert.deepEqual(await executeCapability('agent.operation.status',{
    request_id:randomUUID(),
  },policy,{operationJournal:journal}),{data:{found:false}});
  await assert.rejects(
    executeCapability('agent.operation.status',{request_id:id,extra:'x'},policy,{operationJournal:journal}),
  );
  await assert.rejects(
    executeCapability('agent.operation.status',{request_id:id},policy,{}),
    /unavailable/,
  );
});
