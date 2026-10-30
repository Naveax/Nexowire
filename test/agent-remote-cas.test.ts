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
async function postIsolatedGateway(
 endpoint:string,
 remote:{settings:{token:string};deviceId:string;epoch:string},
 requestId:string,
):Promise<{status:number;created?:boolean}>{
 // The SAME CAS handler runs behind real verified HTTPS in the other tests.
 // This test transport uses no keepalive to reliably release Windows sockets
 // after gateway DB rollback/restart, never for production.
 const {request}=await import('node:http');
 return new Promise((resolve,reject)=>{
  const input=JSON.stringify({deviceId:remote.deviceId,epoch:remote.epoch,
    requestId,fingerprint:fp,capability:'files.write'});
  const outgoing=request(endpoint,{
   method:'POST',agent:false,
   headers:{authorization:'Bearer '+remote.settings.token,
    'content-type':'application/json',connection:'close'},
  },incoming=>{
   let body='';
   incoming.on('data',chunk=>{body+=String(chunk)});
   incoming.once('end',()=>{
    try{
     const decoded=JSON.parse(body) as {created?:boolean};
     resolve({status:incoming.statusCode??0,...decoded});
    }catch(e){reject(e)}
   });
  });
  outgoing.once('error',reject);
  outgoing.end(input);
 });
}

async function snapshotRemote(file:string,to:string){
 const db=new DatabaseSync(file);
 try{await backup(db,to)}finally{db.close()}
}
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

test('P0 #587: rollback reference CAS SQLite as well; surviving remote witness still blocks B',async t=>{
 const {remote,client,root}=await fixture(t);
 const early=randomUUID(),historical=randomUUID();
 assert.equal((await client.reserve(early,fp,'files.write')).created,true);
 const previous=path.join(root,'old-remote-cas.sqlite');
 await snapshotRemote(remote.dbFile,previous);
 assert.equal((await client.reserve(historical,fp,'files.write')).created,true);
 await remote.stop();
 // Roll back the entire reference CAS cache to a cryptographically valid,
 // older snapshot, while the TEST-ONLY witness resides outside this restore.
 await copyFile(previous,remote.dbFile);
 const {createIndependentCasHandler}=await import('../src/agent/remote-mutation-cas.js');
 const {createServer}=await import('node:http');
 const backend=await createIndependentCasHandler({
  dbFile:remote.dbFile,authorityId:remote.authorityId,
  credentials:()=>remote.credentials,trustRoot:remote.trustRoot,
 });
 const restartedServer=createServer(backend.handler);
 await new Promise<void>(resolve=>restartedServer.listen(0,'localhost',resolve));
 const newPort=(restartedServer.address() as {port:number}).port;
 const post=async(id:string)=>{
  const result=await postIsolatedGateway('http://localhost:'+newPort+'/v1/reservations',remote,id);
  assert.equal(result.status,200);
  return result;
 };
 try{
  assert.equal((await post(historical)).created,false);
  assert.equal((await post(early)).created,false);
  assert.equal((await post(randomUUID())).created,true);
 }finally{
  restartedServer.closeAllConnections();
  await new Promise<void>(resolve=>restartedServer.close(()=>resolve()));
  backend.close();
 }
});
test('gateway refuses startup without an independent monotonic trust root',async t=>{
 const {remote}=await fixture(t);
 await remote.stop();
 const {createIndependentCasHandler}=await import('../src/agent/remote-mutation-cas.js');
 await assert.rejects(createIndependentCasHandler({
  dbFile:remote.dbFile,authorityId:remote.authorityId,
  credentials:()=>remote.credentials,
  trustRoot:undefined as unknown as typeof remote.trustRoot,
 }),{code:'CAS_TRUST_ROOT_REQUIRED'});
});
test('monotonic witness unavailable or mismatched proof cannot authorize a cache write',async t=>{
 const {remote}=await fixture(t);
 await remote.stop();
 const {createIndependentCasHandler}=await import('../src/agent/remote-mutation-cas.js');
 const {createServer}=await import('node:http');
 let offline=true;
 const fakeProofRoot={
  reserve:async (request:{deviceId:string;epoch:string;requestId:string})=>{
   if(offline)throw new Error('Root unavailable');
   return {authorityId:remote.authorityId,
     deviceId:randomUUID(),epoch:request.epoch,requestId:request.requestId,
     sequence:999,created:true};
  },
 };
 const gateway=await createIndependentCasHandler({
  dbFile:remote.dbFile,authorityId:remote.authorityId,
  credentials:()=>remote.credentials,trustRoot:fakeProofRoot,
 });
 const listener=createServer(gateway.handler);
 await new Promise<void>(resolve=>listener.listen(0,'localhost',resolve));
 const port=(listener.address() as {port:number}).port;
 const post=async(id:string)=>(await postIsolatedGateway(
  'http://localhost:'+port+'/v1/reservations',remote,id)).status;
 try{
  assert.equal(await post(randomUUID()),503);
  offline=false;
  assert.equal(await post(randomUUID()),503);
  const db=new DatabaseSync(remote.dbFile,{readOnly:true});
  try{
   assert.equal((db.prepare('SELECT COUNT(*) AS n FROM reservations').get() as
     {n:number}).n,0);
  }finally{db.close()}
 }finally{
  listener.closeAllConnections();
  await new Promise<void>(resolve=>listener.close(()=>resolve()));
  gateway.close();
 }
});

test('independent HTTPS monotonic witness adapter scopes device+epoch and rejects missing trust',async t=>{
 const {remote}=await fixture(t);
 const {HttpsMonotonicTrustRoot}=await import('../src/agent/remote-mutation-cas.js');
 const witness=new HttpsMonotonicTrustRoot({
  endpoint:remote.settings.endpoint,authorityId:remote.authorityId,
  tokenForEnrolledDevice:(device,epoch)=>
   device===remote.deviceId&&epoch===remote.epoch
    ? remote.settings.token:undefined,
 });
 const id=randomUUID();
 const request={deviceId:remote.deviceId,epoch:remote.epoch,
  requestId:id,fingerprint:fp,capability:'files.write'};
 assert.equal((await witness.reserve(request)).created,true);
 assert.equal((await witness.reserve(request)).created,false);
 await assert.rejects(witness.reserve({...request,deviceId:randomUUID()}),
   {code:'CAS_WITNESS_ENROLLMENT_MISSING'});
 await assert.rejects(witness.reserve({...request,epoch:randomUUID()}),
   {code:'CAS_WITNESS_ENROLLMENT_MISSING'});
});
test('corrupt remote CAS WAL sidecar refuses gateway opening without clearing tombstones',async t=>{
 const {remote}=await fixture(t);
 const reserved=randomUUID();
 const client=new RemoteMutationCasClient(remote.settings);
 assert.equal((await client.reserve(reserved,fp,'files.write')).created,true);
 await remote.stop();
 const damaged=Buffer.from('TORN_REMOTE_CAS_WAL');
 await writeFile(remote.dbFile+'-wal',damaged);
 const {createIndependentCasHandler}=await import('../src/agent/remote-mutation-cas.js');
 await assert.rejects(createIndependentCasHandler({
  dbFile:remote.dbFile,authorityId:remote.authorityId,
  credentials:()=>remote.credentials,trustRoot:remote.trustRoot,
 }),{code:'AGENT_JOURNAL_WAL_CORRUPT'});
 assert.deepEqual(await readFile(remote.dbFile+'-wal'),damaged);
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
  trustRoot:{async reserve(){throw new Error('unavailable')}},
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
  credentials:()=>remote.credentials,trustRoot:remote.trustRoot,
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
