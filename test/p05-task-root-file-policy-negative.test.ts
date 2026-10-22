import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {PathPolicy,PathDeniedError} from '../src/agent/path-policy.js';
import {ScopedPathGrantRegistry} from '../src/agent/scoped-path-grants.js';

// #780/#05 local-only path policy contract. No OS sandbox or elevated writer.
// Create and clean only disposable TEMPorary fixtures under os.tmpdir().
async function fixture(t:import('node:test').TestContext){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-p05-task-scope-'));
  t.after(async()=>{await fs.rm(dir,{recursive:true,force:true})});
  const task=path.join(dir,'task');
  const outside=path.join(dir,'outside');
  await fs.mkdir(task);await fs.mkdir(outside);
  await fs.writeFile(path.join(task,'inside.txt'),'task-only');
  await fs.writeFile(path.join(outside,'external.txt'),'external-only');
  return {dir,task,outside};
}
const rejected=(reason:string)=>(error:unknown)=>
  error instanceof PathDeniedError && error.details.reason===reason;

test('task-specific root narrows inherited wildcard/default allowlist for File API reads',async t=>{
  const f=await fixture(t);
  const policy=new PathPolicy(['*'],{taskRoot:f.task,platform:'win32'});
  assert.equal(await policy.authorizeExisting(path.join(f.task,'inside.txt'),'read'),
    await fs.realpath(path.join(f.task,'inside.txt')));
  assert.throws(()=>policy.resolve(path.join(f.outside,'external.txt')),PathDeniedError);
  await assert.rejects(()=>policy.authorizeExisting(path.join(f.outside,'external.txt'),'read'),
    rejected('PATH_OUTSIDE_ALLOWED_ROOTS'));
  await assert.rejects(()=>policy.authorizeForCreate(path.join(f.outside,'unapproved.txt'),'write'),
    PathDeniedError);
});

test('outside task root read needs real local owner/device scoped grant, not wildcard or task root policy',async t=>{
  const f=await fixture(t);
  const grants=new ScopedPathGrantRegistry();
  const policy=new PathPolicy(['*'],{
    taskRoot:f.task,platform:'win32',grants,
    ownerId:'task-owner',deviceId:'task-device',
  });
  const external=path.join(f.outside,'external.txt');
  await assert.rejects(()=>policy.authorizeExisting(external,'read'),PathDeniedError);
  grants.grantLocally({
    id:'task-external-read-01',ownerId:'task-owner',deviceId:'other-device',
    root:f.outside,scopes:['read'],expiresAt:Date.now()+60_000,
  });
  await assert.rejects(()=>policy.authorizeExisting(external,'read'),PathDeniedError);
  grants.grantLocally({
    id:'task-external-read-02',ownerId:'task-owner',deviceId:'task-device',
    root:f.outside,scopes:['read'],expiresAt:Date.now()+60_000,
  });
  assert.equal(await policy.authorizeExisting(external,'read'),await fs.realpath(external));
  // Check a real existing out-of-root file; ENOENT isn't policy evidence.
  const ungranted=path.join(f.dir,'ungranted.txt');
  await fs.writeFile(ungranted,'fixture');
  await assert.rejects(()=>policy.authorizeExisting(ungranted,'read'),
    rejected('PATH_OUTSIDE_ALLOWED_ROOTS'));
});

test('even local owner grants cannot turn task pathname checks into OS-proven mutations',async t=>{
  const f=await fixture(t);
  const grants=new ScopedPathGrantRegistry();
  grants.grantLocally({
    id:'task-external-write-1',ownerId:'task-owner',deviceId:'task-device',
    root:f.outside,scopes:['read','write','delete','move','recursive_delete'],
    expiresAt:Date.now()+60_000,
  });
  const policy=new PathPolicy([f.dir],{
    taskRoot:f.task,platform:'win32',grants,
    ownerId:'task-owner',deviceId:'task-device',
    unrestrictedExecutionUntil:Date.now()+60_000,
    volumeResolver:async()=>{throw Error('must not probe disk for unapproved task mutation');},
  });
  for(const scope of ['write','delete','move','recursive_delete'] as const){
    await assert.rejects(
      ()=>policy.authorizeForCreate(path.join(f.task,'candidate.tmp'),scope),
      rejected('TASK_OS_SANDBOX_MUTATION_UNAVAILABLE'));
    await assert.rejects(
      ()=>policy.authorizeExisting(path.join(f.outside,'external.txt'),scope),
      rejected('TASK_OS_SANDBOX_MUTATION_UNAVAILABLE'));
  }
  assert.throws(()=>policy.assertUnrestrictedExecution(),rejected('UNSANDBOXED_EXECUTION_DENIED'));
  assert.equal(await fs.readFile(path.join(f.outside,'external.txt'),'utf8'),'external-only');
});

test('task-local file roots cannot be wildcard, volume root or relative user-supplied path',async t=>{
  const f=await fixture(t);
  for(const root of ['*','../task',path.parse(f.task).root]){
    assert.throws(()=>new PathPolicy(['*'],{taskRoot:root}),
      rejected('TASK_ROOT_INVALID'));
  }
});

test('actual File API dispatch respects task root and denies writes and unsandboxed shell',async t=>{
  const f=await fixture(t);
  const policy=new PathPolicy(['*'],{
    taskRoot:f.task,platform:'win32',
    unrestrictedExecutionUntil:Date.now()+60_000,
  });
  const {executeCapability}=await import('../src/agent/executors.js');
  const read=await executeCapability('files.read',{
    path:path.join(f.task,'inside.txt'),
  },policy) as {data:{content:string}};
  assert.equal(read.data.content,'task-only');
  for(const [capability,payload] of [
    ['files.write',{path:path.join(f.task,'new.txt'),content:'DENIED'}],
    ['files.delete',{path:path.join(f.task,'inside.txt')}],
    ['files.patch',{path:path.join(f.task,'inside.txt'),
      operations:[{old_text:'task-only',new_text:'DENIED'}]}],
    ['files.mkdir',{path:path.join(f.task,'newdir')}],
    ['files.copy',{source:path.join(f.task,'inside.txt'),
      destination:path.join(f.task,'copied.txt')}],
    ['files.move',{source:path.join(f.task,'inside.txt'),
      destination:path.join(f.task,'moved.txt')}],
  ] as const){
    await assert.rejects(
      ()=>executeCapability(capability,payload,policy),
      rejected('TASK_OS_SANDBOX_MUTATION_UNAVAILABLE'),capability);
  }
  await assert.rejects(
    ()=>executeCapability('shell.exec',{command:'echo SHOULD_NOT_RUN'},policy),
    rejected('UNSANDBOXED_EXECUTION_DENIED'));
  assert.equal(await fs.readFile(path.join(f.task,'inside.txt'),'utf8'),'task-only');
  assert.deepEqual((await fs.readdir(f.task)).sort(),['inside.txt']);
});

test('task root itself cannot be replaced by a disposable junction or symlink',async t=>{
  const f=await fixture(t);
  const alias=path.join(f.dir,'task-alias');
  try{
    await fs.symlink(f.outside,alias,process.platform==='win32'?'junction':'dir');
  }catch(error){
    t.skip('Disposable TEMP root junction not available: '+String(error));
    return;
  }
  const policy=new PathPolicy(['*'],{taskRoot:alias,platform:'win32'});
  await assert.rejects(
    ()=>policy.authorizeExisting(path.join(alias,'external.txt'),'read'),
    rejected('TASK_ROOT_REPARSE_UNVERIFIED'));
  await assert.rejects(
    ()=>policy.authorizeForCreate(path.join(alias,'staging.txt'),'write'),
    rejected('TASK_ROOT_REPARSE_UNVERIFIED'));
  assert.equal(await fs.readFile(path.join(f.outside,'external.txt'),'utf8'),'external-only');
});

test('root-relative path policy rejects outside junction aliases; it remains a TOCTOU policy, NOT an OS sandbox',async t=>{
  const f=await fixture(t);
  const junction=path.join(f.task,'junction');
  try{
    await fs.symlink(f.outside,junction,process.platform==='win32'?'junction':'dir');
  }catch(error){
    t.skip('Disposable TEMP junction not available: '+String(error));
    return;
  }
  const policy=new PathPolicy(['*'],{taskRoot:f.task,platform:'win32'});
  await assert.rejects(
    ()=>policy.authorizeExisting(path.join(junction,'external.txt'),'read'),
    rejected('PATH_OUTSIDE_ALLOWED_ROOTS'));
  await assert.rejects(
    ()=>policy.authorizeForCreate(path.join(junction,'new.txt'),'write'),
    PathDeniedError);
});
