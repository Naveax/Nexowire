import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {transferCrossDeviceFile,
  CrossDeviceTransferError,CROSS_DEVICE_CHUNK_BYTES,
  type CrossDeviceFileTransferOps} from '../src/mcp/cross-device-file-transfer.js';

const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const goodId='d7020db6-8cf4-442b-b006-0f393cde2007';
function fixture(bytes:Buffer,controls:{
  changeAfterRead?:boolean;badChunk?:boolean;badDestination?:boolean;
  rejectWrite?:boolean;rejectCommit?:boolean;truncatedWrite?:boolean;
}={}){
  const source=Buffer.from(bytes);
  let staged:Buffer|null=null;
  let destination:Buffer|null=null;
  const writes:Array<{offset:number;first:boolean;size:number}>=[];
  let cleaned=0,readCount=0,hashCount=0;
  const ops:CrossDeviceFileTransferOps={
    statSource:async()=>({size:source.length,type:'file'}),
    hashSource:async()=>{hashCount++;return controls.changeAfterRead&&hashCount===2?
      'f'.repeat(64):hash(source)},
    readSource:async(offset,max)=>{
      readCount++;
      const part=source.subarray(offset,offset+max);
      return {sourceBytes:source.length,offsetBytes:offset,
        bytesRead:part.length,content:controls.badChunk&&readCount===1?
          '@@bad@@':part.toString('base64')};
    },
    writeStage:async(_stage,content,offset,first)=>{
      writes.push({offset,first,size:Buffer.from(content,'base64').length});
      if(controls.rejectWrite)throw new Error('synthetic write failure');
      if(first){assert.equal(staged,null);staged=Buffer.alloc(0)}
      if(staged===null)throw new Error('missing stage');
      const b=Buffer.from(content,'base64');
      if(offset>staged.length)throw Error('gap');
      staged=Buffer.concat([staged.subarray(0,offset),b,
        staged.subarray(Math.min(staged.length,offset+b.length))]);
      return controls.truncatedWrite?b.length-1:b.length;
    },
    hashStage:async()=>controls.badDestination?'f'.repeat(64):hash(staged??Buffer.alloc(0)),
    commitStage:async()=>{if(controls.rejectCommit)throw Error('commit refused');
      destination=Buffer.from(staged??Buffer.alloc(0));staged=null;},
    cleanupStage:async()=>{cleaned++;staged=null;},
  };
  return {ops,writes,get destination(){return destination},get staged(){return staged},
    get cleaned(){return cleaned},get readCount(){return readCount}};
}
test('copies 220 KiB with bounded chunks, verifies digest and no payload in receipt',async()=>{
 const bytes=Buffer.alloc(220*1024);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
 const f=fixture(bytes);
 const receipt=await transferCrossDeviceFile('C:\\Temp\\valid.zip',f.ops,{newId:()=>goodId});
 assert.equal(receipt.state,'COMPLETE');
 assert.equal(receipt.bytesTransferred,bytes.length);
 assert.equal(receipt.sha256,hash(bytes));
 assert.equal(receipt.chunkCount,5);
 assert.ok(f.writes.every(x=>x.size<=CROSS_DEVICE_CHUNK_BYTES));
 assert.deepEqual(f.destination,bytes);
 assert.equal(f.cleaned,0);
 assert.doesNotMatch(JSON.stringify(receipt),/@bad@|content|base64/i);
});
test('transfers empty files with one safe stage creation',async()=>{
 const f=fixture(Buffer.alloc(0));
 const r=await transferCrossDeviceFile('dst.bin',f.ops,{newId:()=>goodId});
 assert.equal(r.chunkCount,1);
 assert.equal(r.bytesTransferred,0);
 assert.deepEqual(f.destination,Buffer.alloc(0));
});
test('rejects source mutations before commit, cleans temporary file',async()=>{
 const f=fixture(Buffer.alloc(148000,9),{changeAfterRead:true});
 await assert.rejects(transferCrossDeviceFile('dst.bin',f.ops,{newId:()=>goodId}),
  (e:unknown)=>e instanceof CrossDeviceTransferError&&e.code==='TRANSFER_SOURCE_CHANGED');
 assert.equal(f.destination,null);assert.equal(f.cleaned,1);
});
test('rejects corrupt destination hash and preserves final destination',async()=>{
 const f=fixture(Buffer.alloc(140000,2),{badDestination:true});
 await assert.rejects(transferCrossDeviceFile('dst.bin',f.ops,{newId:()=>goodId}),
  (e:unknown)=>e instanceof CrossDeviceTransferError&&e.code==='TRANSFER_HASH_MISMATCH');
 assert.equal(f.destination,null);assert.equal(f.cleaned,1);
});
test('rejects corrupt base64 source chunks without writing',async()=>{
 const f=fixture(Buffer.alloc(10000,7),{badChunk:true});
 await assert.rejects(transferCrossDeviceFile('dst.bin',f.ops,{newId:()=>goodId}),
  (e:unknown)=>e instanceof CrossDeviceTransferError&&e.code==='TRANSFER_CHUNK_INVALID');
 assert.equal(f.destination,null);assert.equal(f.cleaned,0);
});
test('incomplete write never commits and stage is cleaned',async()=>{
 const f=fixture(Buffer.alloc(50000,3),{truncatedWrite:true});
 await assert.rejects(transferCrossDeviceFile('dst.bin',f.ops,{newId:()=>goodId}),
  (e:unknown)=>e instanceof CrossDeviceTransferError&&e.code==='TRANSFER_WRITE_INCOMPLETE');
 assert.equal(f.destination,null);assert.equal(f.cleaned,1);
});
test('remote write rejection cannot mutate destination',async()=>{
 const f=fixture(Buffer.alloc(100,4),{rejectWrite:true});
 await assert.rejects(transferCrossDeviceFile('dst.bin',f.ops,{newId:()=>goodId}),
  /synthetic write failure/);
 assert.equal(f.destination,null);assert.equal(f.cleaned,1);
});
test('commit refusal leaves prior destination untouched',async()=>{
 const f=fixture(Buffer.alloc(80000,5),{rejectCommit:true});
 await assert.rejects(transferCrossDeviceFile('dst.bin',f.ops,{newId:()=>goodId}),
  /commit refused/);
 assert.equal(f.destination,null);assert.equal(f.cleaned,1);
});
test('protects against directories and oversized inputs',async()=>{
 const f=fixture(Buffer.alloc(400,6));
 const directoryOps={...f.ops,statSource:async()=>({size:400,type:'directory'})};
 await assert.rejects(transferCrossDeviceFile('dst.bin',directoryOps,{newId:()=>goodId}),
  /source is not a regular file/);
 await assert.rejects(transferCrossDeviceFile('dst.bin',f.ops,
  {newId:()=>goodId,maxBytes:100}),/source is not a regular file/);
 assert.equal(f.writes.length,0);
});
test('invalid transfer ID, destination, chunk limits fail before writing',async()=>{
 const f=fixture(Buffer.from('text'));
 await assert.rejects(transferCrossDeviceFile('',f.ops),/Destination path is invalid/);
 await assert.rejects(transferCrossDeviceFile('dst',f.ops,{newId:()=> 'bad'}),
  /Invalid transfer ID/);
 await assert.rejects(transferCrossDeviceFile('dst',f.ops,{chunkBytes:90000}),
  /bounds are invalid/);
 assert.equal(f.writes.length,0);
});
test('repeated fixed-offset chunks can be written without append duplication',async()=>{
 const bytes=Buffer.from('abcdef'.repeat(13000));
 const f=fixture(bytes);
 const result=await transferCrossDeviceFile('dst.bin',f.ops,{newId:()=>goodId});
 assert.equal(result.state,'COMPLETE');
 assert.deepEqual(f.destination,bytes);
 assert.equal(f.writes[1]?.offset,48*1024);
});
