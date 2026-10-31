import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {WebSocketServer} from 'ws';
import {AgentOperationJournal} from '../src/agent/operation-journal.js';
import {readJournalOwnerProcess} from '../src/agent/journal-owner-process.js';

async function fixture(t:import('node:test').TestContext){
  const dir=await mkdtemp(path.join(os.tmpdir(),'nw-owner-incarnation-'));
  const cleanups:Array<()=>void|Promise<void>>=[];
  const cleanup=(fn:()=>void|Promise<void>)=>{cleanups.push(fn);};
  t.after(async()=>{
    for(const fn of cleanups.reverse())await fn();
    await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  const file=path.join(dir,'journal.sqlite');
  const j=new AgentOperationJournal(file);cleanup(()=>j.close());const id=randomUUID();
  await j.begin(id,'a'.repeat(64),'files.write');await j.complete(id,'succeeded');j.close();
  return {dir,file,id,cleanup};
}
test('positive OS process incarnation mismatch reclaims stale PID without losing tombstones',async t=>{
  const self=await readJournalOwnerProcess(process.pid);
  if(process.platform==='win32')assert.equal(self.state,'alive','Windows process incarnation readback is a mandatory acceptance gate');
  if(self.state!=='alive'){t.skip('OS incarnation unavailable in this runtime; conservative fallback tested separately');return;}
  const {file,id,cleanup}=await fixture(t);const db=new DatabaseSync(file);
  const parts=self.identity.split(':');
  const oldIdentity=parts[0]==='win32'?'win32:'+((BigInt('0x'+parts[1]!)^1n).toString(16).padStart(16,'0')):
    parts.slice(0,-1).join(':')+':'+(BigInt(parts.at(-1)!)+1n).toString();
  db.prepare('INSERT INTO agent_operation_owner(id,pid,nonce,process_identity) VALUES(1,?,?,?)')
    .run(process.pid,randomUUID(),oldIdentity);db.close();
  const j=new AgentOperationJournal(file);cleanup(()=>j.close());
  await j.initialize();assert.equal((await j.inspect(id))?.status,'succeeded');
  assert.equal((await j.begin(id,'a'.repeat(64),'files.write')).created,false);
});
test('live owner and legacy live PID without birth evidence are never reclaimed',async t=>{
  const {file,id,cleanup}=await fixture(t);const first=new AgentOperationJournal(file);cleanup(()=>first.close());
  await first.initialize();
  const second=new AgentOperationJournal(file);cleanup(()=>second.close());
  await assert.rejects(second.initialize(),{code:'AGENT_JOURNAL_IN_USE'});
  const db=new DatabaseSync(file);db.prepare('UPDATE agent_operation_owner SET process_identity=NULL').run();db.close();
  await assert.rejects(second.initialize(),{code:'AGENT_JOURNAL_IN_USE'});
  assert.equal((await first.inspect(id))?.status,'succeeded');
});
test('Agent connects for diagnosis under live journal contention and blocks writes before execution',
  {timeout:120000},async t=>{
  const {dir,file,cleanup}=await fixture(t);const owner=new AgentOperationJournal(file);await owner.initialize();cleanup(()=>owner.close());
  const hub=new WebSocketServer({host:'127.0.0.1',port:0});
  await new Promise<void>(r=>hub.once('listening',r));
  cleanup(async()=>{for(const s of hub.clients)s.terminate();await new Promise<void>(r=>hub.close(()=>r()));});
  const addr=hub.address();assert.ok(addr&&typeof addr!=='string');
  const requestId=randomUUID(),target=path.join(dir,'must-not-be-written.txt');
  let timer:NodeJS.Timeout|undefined;
  let failed!:(error:Error)=>void;
  const response=new Promise<{ok:boolean;error?:{code:string}}>((resolve,reject)=>{
    failed=reject;
    timer=setTimeout(()=>reject(new Error('Agent did not remain available under journal contention')),60000);
    hub.once('connection',socket=>socket.on('message',raw=>{
      const message=JSON.parse(raw.toString());
      if(message.type==='hello')socket.send(JSON.stringify({type:'request',requestId,
        capability:'files.write',input:{path:target,content:'must not execute'},accessMode:'full'}));
      if(message.type==='response'&&message.requestId===requestId)resolve(message);
    }));
  });
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('NEXOWIRE_')&&k!=='NODE_OPTIONS'));
  const source=import.meta.url.endsWith('.ts');
  const child=spawn(process.execPath,[...(source?['--import','tsx']:[]),
    process.env.NEXOWIRE_OWNER_CLI_TEST_ROOT?path.join(process.env.NEXOWIRE_OWNER_CLI_TEST_ROOT,'src/cli.ts'):
      fileURLToPath(new URL('../src/cli.'+(source?'ts':'js'),import.meta.url)),'agent','run'],{
    env:{...env,HOME:dir,USERPROFILE:dir,LOCALAPPDATA:path.join(dir,'local'),APPDATA:path.join(dir,'roaming'),
      NEXOWIRE_AGENT_IDENTITY_FILE:path.join(dir,'identity.json'),NEXOWIRE_AGENT_OPERATION_JOURNAL_FILE:file,
      NEXOWIRE_PROCESS_STATE_FILE:path.join(dir,'processes.json'),NEXOWIRE_PROCESS_WORKER_ROOT:path.join(dir,'workers'),
      NEXOWIRE_TASK_GRAPH_STATE_FILE:path.join(dir,'tasks.json'),NEXOWIRE_RUNBOOK_STATE_FILE:path.join(dir,'runbooks.json'),
      NEXOWIRE_HUB_WS_URL:`ws://127.0.0.1:${addr.port}/agent`,NEXOWIRE_AGENT_TOKEN:'disposable-owner-test',
      NEXOWIRE_PRIVILEGE_MODE:'direct',NEXOWIRE_ALLOWED_ROOTS:dir},stdio:['ignore','ignore','pipe']});
  child.stderr.resume();
  child.once('error',failed);
  child.once('exit',code=>failed(new Error('Agent exited before journal-contention response: '+code)));
  const exited=new Promise<void>(r=>child.once('exit',()=>r()));
  cleanup(async()=>{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
  const result=await response;assert.equal(result.ok,false);assert.equal(result.error?.code,'AGENT_JOURNAL_IN_USE');
  await assert.rejects(access(target),{code:'ENOENT'});
  assert.equal(child.exitCode,null,'Agent must remain connected, not fatal-exit on the owner guard');
});
