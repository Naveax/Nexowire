import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {transferCrossDeviceFile,CrossDeviceTransferError,
  type CrossDeviceFileTransferOps} from '../../src/mcp/cross-device-file-transfer.js';
import {DurableTransferContinuity,TransferContinuityError,
  type TransferBinding,type TransferCheckpoint,type TransferCheckpointStore,
  type AuthenticatedTransferRoute,type PublishedArtifactReadback}
  from '../../src/mcp/cross-device-transfer-continuity.js';

const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const id='d7020db6-8cf4-442b-b006-0f393cde2007';
const transferError=(code:string)=>(e:unknown)=>
  e instanceof CrossDeviceTransferError&&e.code===code&&e.message.includes(id);
const continuityError=(code:string)=>(e:unknown)=>
  e instanceof TransferContinuityError&&e.code===code;
const temp=async(t:import('node:test').TestContext)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nx-ai07-recovery-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  return dir;
};
async function diskFixture(t:import('node:test').TestContext,
  fault:'first-write'|'second-write'|'before-move'|'after-move'|'none'){
  const dir=await temp(t);
  const data=Buffer.alloc(221*1024,0x72);
  const dest=path.join(dir,'dest.bin');
  const stage=dest+'.nexowire-upload-'+id+'.tmp';
  let writes=0,moves=0,cleanups=0;
  const ops:CrossDeviceFileTransferOps={
    statSource:async()=>({size:data.length,type:'file'}),
    hashSource:async()=>digest(data),
    readSource:async(offset,max)=>{
      const bytes=data.subarray(offset,offset+max);
      return {sourceBytes:data.length,offsetBytes:offset,bytesRead:bytes.length,content:bytes.toString('base64')};
    },
    writeStage:async(file,content,offset,first)=>{
      assert.equal(file,stage);
      writes++;
      const fd=await fs.open(file,first?'wx':'r+');
      const bytes=Buffer.from(content,'base64');
      try{
        assert.equal((await fd.stat()).size,offset);
        assert.equal((await fd.write(bytes,0,bytes.length,offset)).bytesWritten,bytes.length);
        await fd.sync();
      }finally{await fd.close();}
      if((fault==='first-write'&&writes===1)||(fault==='second-write'&&writes===2))
        throw Error('injected durable write ACK loss');
      return bytes.length;
    },
    hashStage:async(file)=>digest(await fs.readFile(file)),
    hashDestination:async(file)=>digest(await fs.readFile(file)),
    commitStage:async(file,target)=>{
      moves++;
      if(fault==='before-move')throw Error('injected unknown move before effect');
      // Exclusive hard-link publication in a disposable same-volume fixture.
      await fs.link(file,target);
      await fs.unlink(file);
      if(fault==='after-move')throw Error('injected move ACK loss');
    },
    cleanupStage:async(file)=>{cleanups++;await fs.rm(file,{force:true});},
  };
  return {data,dest,stage,ops,counts:()=>({writes,moves,cleanups})};
}
for(const [fault,n] of [['first-write',1],['second-write',2]] as const){
  test('AI-07 durable '+fault+' ACK loss preserves prefix without replay',async t=>{
    const f=await diskFixture(t,fault);
    await assert.rejects(transferCrossDeviceFile(f.dest,f.ops,{newId:()=>id}),
      transferError('TRANSFER_WRITE_OUTCOME_UNKNOWN'));
    assert.deepEqual(f.counts(),{writes:n,moves:0,cleanups:0});
    assert.deepEqual(await fs.readFile(f.stage),f.data.subarray(0,n*48*1024));
    await assert.rejects(fs.stat(f.dest),{code:'ENOENT'});
  });
}
test('AI-07 unknown move before effect retains complete verified staging',async t=>{
  const f=await diskFixture(t,'before-move');
  await assert.rejects(transferCrossDeviceFile(f.dest,f.ops,{newId:()=>id}),
    transferError('TRANSFER_PUBLISH_OUTCOME_UNKNOWN'));
  assert.deepEqual(f.counts(),{writes:5,moves:1,cleanups:0});
  assert.deepEqual(await fs.readFile(f.stage),f.data);
  await assert.rejects(fs.stat(f.dest),{code:'ENOENT'});
});
test('AI-07 lost move ACK cannot falsely COMPLETE or erase published destination',async t=>{
  const f=await diskFixture(t,'after-move');
  await assert.rejects(transferCrossDeviceFile(f.dest,f.ops,{newId:()=>id}),
    transferError('TRANSFER_PUBLISH_OUTCOME_UNKNOWN'));
  assert.deepEqual(f.counts(),{writes:5,moves:1,cleanups:0});
  assert.deepEqual(await fs.readFile(f.dest),f.data);
  await assert.rejects(fs.stat(f.stage),{code:'ENOENT'});
});
test('AI-07 successful atomic publication still needs destination digest',async t=>{
  const f=await diskFixture(t,'none');
  const result=await transferCrossDeviceFile(f.dest,f.ops,{newId:()=>id});
  assert.equal(result.state,'COMPLETE');
  assert.equal(result.sha256,digest(f.data));
  assert.deepEqual(f.counts(),{writes:5,moves:1,cleanups:0});
  assert.deepEqual(await fs.readFile(f.dest),f.data);
});
class Journal implements TransferCheckpointStore{
  private readonly db:DatabaseSync;
  constructor(file:string){
    this.db=new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS transfer(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,value TEXT NOT NULL)');
  }
  async insert(row:TransferCheckpoint){
    return this.db.prepare('INSERT OR IGNORE INTO transfer VALUES(?,?,?)').run(row.binding.jobId,row.revision,JSON.stringify(row)).changes===1;
  }
  async read(id:string){
    const row=this.db.prepare('SELECT value FROM transfer WHERE id=?').get(id) as {value:string}|undefined;
    return row?JSON.parse(row.value) as TransferCheckpoint:undefined;
  }
  async compareAndSwap(id:string,revision:number,row:TransferCheckpoint){
    return this.db.prepare('UPDATE transfer SET revision=?,value=? WHERE id=? AND revision=?').run(row.revision,JSON.stringify(row),id,revision).changes===1;
  }
  close(){this.db.close();}
}
const route:AuthenticatedTransferRoute={ownerId:'test-owner',sourceDeviceId:'test-source',destinationDeviceId:'test-destination',epoch:1};
const binding=():TransferBinding=>({jobId:randomUUID(),ownerId:route.ownerId,sourceDeviceId:route.sourceDeviceId,destinationDeviceId:route.destinationDeviceId,sourceSha256:digest(Buffer.alloc(0)),totalBytes:0});
const noChunk=async()=>({kind:'unavailable' as const});
async function emptyFixture(t:import('node:test').TestContext){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nx-ai07-empty-')),filename=path.join(dir,'journal.sqlite'),dest=path.join(dir,'published.bin');
  const journals:Journal[]=[];
  const open=()=>{const j=new Journal(filename);journals.push(j);return j;};
  // Close DB handles before removing the disposable directory, including on Windows.
  t.after(async()=>{for(const j of journals)j.close();await fs.rm(dir,{recursive:true,force:true});});
  const reader:PublishedArtifactReadback=async b=>{
    try{const bytes=await fs.readFile(dest);return {kind:'verified',deviceId:b.destinationDeviceId,size:bytes.length,sha256:digest(bytes)};}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {kind:'missing'};throw e;}
  };
  return {open,dest,reader};
}
test('AI-07 empty file verified metadata becomes COMPLETE only after durable final readback',async t=>{
  const f=await emptyFixture(t),b=binding();
  const controller=new DurableTransferContinuity(f.open(),noChunk,f.reader);
  assert.equal((await controller.create(b,route)).status,'verified');
  await assert.rejects(controller.confirmPublished(b.jobId,route),continuityError('TRANSFER_PUBLISH_UNVERIFIED'));
  await assert.rejects(controller.reserveWrite({jobId:b.jobId,route,offset:0,length:0,sha256:b.sourceSha256}),continuityError('TRANSFER_NOT_DISPATCHABLE'));
  await fs.writeFile(f.dest,Buffer.alloc(0),{flag:'wx'});
  const reopened=new DurableTransferContinuity(f.open(),noChunk,f.reader);
  const final=await reopened.confirmPublished(b.jobId,route);
  assert.equal(final.status,'complete');
  assert.equal(final.offset,0);
  assert.equal(final.revision,1);
});
test('AI-07 legacy empty ready row reconciles only matching published destination',async t=>{
  const f=await emptyFixture(t),b=binding(),j=f.open();
  assert.ok(await j.insert({binding:b,revision:0,epoch:1,offset:0,status:'ready'}));
  const reopened=new DurableTransferContinuity(f.open(),noChunk,f.reader);
  await assert.rejects(reopened.confirmPublished(b.jobId,route),continuityError('TRANSFER_PUBLISH_UNVERIFIED'));
  await fs.writeFile(f.dest,'wrong');
  await assert.rejects(reopened.confirmPublished(b.jobId,route),continuityError('TRANSFER_PUBLISH_UNVERIFIED'));
  await fs.writeFile(f.dest,Buffer.alloc(0));
  assert.equal((await reopened.confirmPublished(b.jobId,route)).status,'complete');
});
test('AI-07 empty file rejects wrong digest, missing reader and wrong device receipt',async t=>{
  const f=await emptyFixture(t),b=binding(),j=f.open();
  const bad=new DurableTransferContinuity(j,noChunk,async()=>({kind:'verified',deviceId:'foreign',size:0,sha256:b.sourceSha256}));
  await assert.rejects(bad.create({...b,sourceSha256:'f'.repeat(64)},route),continuityError('TRANSFER_BINDING_INVALID'));
  await bad.create(b,route);
  await assert.rejects(bad.confirmPublished(b.jobId,route),continuityError('TRANSFER_PUBLISH_UNVERIFIED'));
  await assert.rejects(new DurableTransferContinuity(f.open(),noChunk).confirmPublished(b.jobId,route),continuityError('TRANSFER_PUBLISH_UNVERIFIED'));
  assert.equal((await bad.inspect(b.jobId,route)).status,'verified');
});
test('AI-07 empty-file publication readback cannot overwrite concurrent cancellation',async t=>{
  const f=await emptyFixture(t),b=binding();
  await fs.writeFile(f.dest,Buffer.alloc(0));
  let entered!:()=>void,release!:()=>void;
  const readStarted=new Promise<void>(r=>{entered=r;});
  const barrier=new Promise<void>(r=>{release=r;});
  const a=new DurableTransferContinuity(f.open(),noChunk,async binding=>{
    entered();await barrier;return f.reader(binding);
  });
  const other=new DurableTransferContinuity(f.open(),noChunk,f.reader);
  await a.create(b,route);
  const pending=a.confirmPublished(b.jobId,route);
  await readStarted;
  try{assert.equal((await other.cancel(b.jobId,route)).status,'cancelled');}
  finally{release();}
  await assert.rejects(pending,continuityError('TRANSFER_CAS_CONFLICT'));
  assert.equal((await other.inspect(b.jobId,route)).status,'cancelled');
});
