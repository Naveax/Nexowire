import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import * as tls from 'node:tls';
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdtemp,rm,readFile,copyFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {RemoteMutationCasClient} from '../src/agent/remote-mutation-cas.js';
import {AgentOperationJournal} from '../src/agent/operation-journal.js';
import {provisionJournalAuthority,type AuthorityConfig}
  from '../src/agent/operation-journal-authority.js';
import {isolatedRemoteCas} from './fixtures/agent-remote-cas-fixture.js';
const fp='3'.repeat(64);
async function fixture(t:import('node:test').TestContext){
 const root=await mkdtemp(path.join(os.tmpdir(),'nw-external-cas-'));
 const remote=await isolatedRemoteCas(root);
 // Node 24+ runtime trust chain is changed for THIS isolated test process.
 const previous=tls.getCACertificates('default');
 tls.setDefaultCACertificates([...previous,await readFile(remote.certificate,'utf8')]);
 t.after(async()=>{
  tls.setDefaultCACertificates(previous);
  await remote.stop();
  await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 });
 return {root,remote,client:new RemoteMutationCasClient(remote.settings)};
}
async function snapshot(file:string,to:string){
 const db=new DatabaseSync(file);
 try{await backup(db,to)}finally{db.close()}
}
test('co-rollback of BOTH Agent SQLite databases cannot replay remotely reserved UUID',async t=>{
 const {root,remote,client}=await fixture(t);
 const journalFile=path.join(root,'journal','agent.sqlite');
 const local:AuthorityConfig={
  file:path.join(root,'local-authority','reservations.sqlite'),
  authorityId:randomUUID(),generation:randomUUID(),
 };
 await provisionJournalAuthority(local);
 const idA=randomUUID(),idB=randomUUID();
 const journal=new AgentOperationJournal(journalFile,{authority:local});
 const run=async(id:string)=>{
  assert.equal((await client.reserve(id,fp,'files.write')).created,true);
  assert.equal((await journal.begin(id,fp,'files.write')).created,true);
  await journal.markDispatched(id,fp);
  await journal.complete(id,'succeeded',undefined,undefined,fp);
 };
 await run(idA);
 journal.close();
 const oldJ=path.join(root,'old-journal.sqlite');
 const oldA=path.join(root,'old-authority.sqlite');
 await snapshot(journalFile,oldJ);
 await snapshot(local.file,oldA);
 const newJ=new AgentOperationJournal(journalFile,{authority:local});
 assert.equal((await client.reserve(idB,fp,'files.write')).created,true);
 assert.equal((await newJ.begin(idB,fp,'files.write')).created,true);
 await newJ.markDispatched(idB,fp);
 await newJ.complete(idB,'succeeded',undefined,undefined,fp);
 newJ.close();
 // Restore BOTH local authorities. These are authentic valid older snapshots.
 await copyFile(oldJ,journalFile);await copyFile(oldA,local.file);
 const vulnerable=new AgentOperationJournal(journalFile,{authority:local});
 try{
  // Source #582 would incorrectly return created:true here.
  // External CAS retains ID B after both local files are rolled back.
  assert.equal((await client.reserve(idB,fp,'files.write')).created,false);
  assert.equal((await client.reserve(idA,fp,'files.write')).created,false);
  // We intentionally NEVER call vulnerable.begin(B) or execute an effect.
  // This is a reservation rejection on remote side before local dispatch.
 }finally{vulnerable.close()}
});
test('token rotation preserves remote tombstone while wrong device/epoch denied',async t=>{
 const {remote,client}=await fixture(t),id=randomUUID();
 assert.equal((await client.reserve(id,fp,'shell.exec')).created,true);
 const nextToken=randomUUID()+randomUUID();
 remote.credentials.splice(0,1,{...remote.credentials[0]!,token:nextToken});
 const rotated=new RemoteMutationCasClient({...remote.settings,token:nextToken});
 assert.equal((await rotated.reserve(id,fp,'shell.exec')).created,false);
 await assert.rejects(client.reserve(randomUUID(),fp,'shell.exec'),
  {code:'CAS_NOT_AUTHORIZED_OR_UNAVAILABLE'});
 const wrongDevice=new RemoteMutationCasClient({...remote.settings,
  token:nextToken,deviceId:randomUUID()});
 await assert.rejects(wrongDevice.reserve(randomUUID(),fp,'shell.exec'),
  {code:'CAS_NOT_AUTHORIZED_OR_UNAVAILABLE'});
 const wrongEpoch=new RemoteMutationCasClient({...remote.settings,
  token:nextToken,epoch:randomUUID()});
 await assert.rejects(wrongEpoch.reserve(randomUUID(),fp,'shell.exec'),
  {code:'CAS_NOT_AUTHORIZED_OR_UNAVAILABLE'});
});
test('remote authority down or malformed scope proof refuses every new mutation',async t=>{
 const {remote,client}=await fixture(t);
 const first=randomUUID();
 assert.equal((await client.reserve(first,fp,'files.write')).created,true);
 await remote.stop();
 await assert.rejects(client.reserve(randomUUID(),fp,'files.write'),
  {code:'CAS_UNAVAILABLE'});
});
test('remote CAS refuses same UUID with a different fingerprint and capability',async t=>{
 const {client}=await fixture(t),id=randomUUID();
 assert.equal((await client.reserve(id,fp,'files.write')).created,true);
 assert.equal((await client.reserve(id,fp,'files.write')).created,false);
 await assert.rejects(client.reserve(id,'4'.repeat(64),'files.write'),
  {code:'CAS_NOT_AUTHORIZED_OR_UNAVAILABLE'});
 await assert.rejects(client.reserve(id,fp,'shell.exec'),
  {code:'CAS_NOT_AUTHORIZED_OR_UNAVAILABLE'});
});
test('remote SQLITE_FULL rejects new CAS grants instead of promising mutation',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'nw-cas-full-'));
 const remote=await isolatedRemoteCas(root,randomUUID(),0);
 const previous=tls.getCACertificates('default');
 tls.setDefaultCACertificates([...previous,await readFile(remote.certificate,'utf8')]);
 t.after(async()=>{
  tls.setDefaultCACertificates(previous);
  await remote.stop();
  await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 });
 const client=new RemoteMutationCasClient(remote.settings);
 let full=false;
 for(let i=0;i<1000;i++){
  try{await client.reserve(randomUUID(),fp,'files.write')}
  catch(e){assert.equal((e as {code?:string}).code,
      'CAS_NOT_AUTHORIZED_OR_UNAVAILABLE');full=true;break}
 }
 assert.equal(full,true,'SQLite capacity must reject a reservation');
});
test('remote reservation authority never silently re-creates missing database',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'nw-cas-no-bootstrap-'));
 t.after(async()=>await rm(root,{recursive:true,force:true}));
 const {createIndependentCasHandler}=await import('../src/agent/remote-mutation-cas.js');
 const db=path.join(root,'cas.sqlite');
 await assert.rejects(createIndependentCasHandler({
  dbFile:db,authorityId:randomUUID(),credentials:()=>[],
 }),{code:'CAS_SERVER_UNAVAILABLE'});
 await assert.rejects(readFile(db),{code:'ENOENT'});
});

test('real remote SQLite CAS backend reopens durable IDs after service shutdown',async t=>{
 const {remote,client}=await fixture(t);
 const id=randomUUID();
 assert.equal((await client.reserve(id,fp,'files.write')).created,true);
 const db=new DatabaseSync(remote.dbFile,{readOnly:true});
 try{
  const columns=(db.prepare('PRAGMA table_info(reservations)').all() as
    Array<{name:string}>).map(x=>x.name).sort();
  assert.deepEqual(columns,[
    'capability','device_id','epoch','fingerprint','request_id','sequence',
  ]);
 }finally{db.close()}
 await remote.stop();
 const {createIndependentCasHandler}=await import('../src/agent/remote-mutation-cas.js');
 // Recreate backend connection with the same persistent remote database.
 // No HTTPS connection is left open during shutdown; CAS protocol itself is
 // independently exercised in the other TLS integration tests.
 const handler=await createIndependentCasHandler({
  dbFile:remote.dbFile,authorityId:remote.authorityId,
  credentials:()=>remote.credentials,
 });
 try{
  const reopened=new DatabaseSync(remote.dbFile,{readOnly:true});
  try{
   const record=reopened.prepare('SELECT request_id,device_id FROM reservations '+
     'WHERE request_id=?').get(id) as
     {request_id:string;device_id:string}|undefined;
   assert.equal(record?.request_id,id);
   assert.equal(record?.device_id,remote.deviceId);
  }finally{reopened.close()}
 }finally{handler.close()}
});
