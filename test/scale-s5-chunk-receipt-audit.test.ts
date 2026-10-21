import test from 'node:test';
import assert from 'node:assert/strict';
import {S5RollingChunkReceiptAudit,S5_TRANSFER_CHUNK_BYTES,type S5TransferIdentity}
  from '../src/ops/scale-s5-chunk-receipt-audit.js';
const SHA='a'.repeat(64);
const scope=(size:number):S5TransferIdentity=>({
  accountId:'staging-account-A',transferId:'staging-transfer-01',
  sourceDeviceId:'staging-source-workpc',targetDeviceId:'staging-target-naveax',
  epoch:3,expectedBytes:size,
});
const receipt=(i:S5TransferIdentity,offset:number,bytes:number)=>({
  accountId:i.accountId,transferId:i.transferId,sourceDeviceId:i.sourceDeviceId,
  targetDeviceId:i.targetDeviceId,epoch:i.epoch,offsetBytes:offset,
  receivedBytes:bytes,senderChunkSha256:SHA,receiverChunkSha256:SHA,
  latencyMs:1.5,
});
test('221 KiB uses four bounded 64KiB receipts with no fake verified native effect',()=>{
  const size=221*1024,i=scope(size),audit=new S5RollingChunkReceiptAudit(i);
  for(let offset=0;offset<size;offset+=S5_TRANSFER_CHUNK_BYTES){
    const bytes=Math.min(S5_TRANSFER_CHUNK_BYTES,size-offset);
    const r=receipt(i,offset,bytes);
    assert.equal(audit.record(r),'RECORDED_UNVERIFIED');
    if(offset+bytes===size)assert.equal(audit.record(r),'DUPLICATE_UNVERIFIED');
  }
  const s=audit.snapshot();
  assert.equal(s.expectedChunks,4);assert.equal(s.accountedChunks,4);
  assert.equal(s.accountedBytes,size);
  assert.equal(s.allChunksReported,true);
  assert.equal(s.independentlyVerifiedDiskHash,false);
  assert.equal(s.independentlyVerifiedNativeCompletion,false);
  assert.equal(s.actuallyTransferredBytesByThisAudit,0);
});
test('1GiB 16384 synthetic receipt offsets checked with constant sampled memory',()=>{
  const i=scope(1024*1024*1024),audit=new S5RollingChunkReceiptAudit(i);
  for(let n=0;n<16384;n++)audit.record(receipt(i,n*S5_TRANSFER_CHUNK_BYTES,S5_TRANSFER_CHUNK_BYTES));
  const s=audit.snapshot();
  assert.equal(s.accountedChunks,16384);
  assert.equal(s.accountedBytes,1024*1024*1024);
  assert.equal(s.expectedChunks,16384);
  assert.equal(s.allChunksReported,true);
  assert.equal(s.independentlyVerifiedDiskHash,false);
  assert.equal(s.actuallyTransferredBytesByThisAudit,0);
});
test('source/target/tenant epoch, incorrect hash, stale offset and partial body fail closed',()=>{
  const i=scope(2*S5_TRANSFER_CHUNK_BYTES),audit=new S5RollingChunkReceiptAudit(i);
  const zero=receipt(i,0,S5_TRANSFER_CHUNK_BYTES);
  for(const change of [
    {accountId:'wrong-account-id'},
    {targetDeviceId:'wrong-device-id'},
    {epoch:2},
    {receiverChunkSha256:'b'.repeat(64)},
    {receivedBytes:1},
    {offsetBytes:1},
    {receivedBytes:S5_TRANSFER_CHUNK_BYTES+1},
  ])assert.throws(()=>audit.record({...zero,...change}));
  assert.equal(audit.record(zero),'RECORDED_UNVERIFIED');
  assert.equal(audit.record(zero),'DUPLICATE_UNVERIFIED');
  assert.throws(()=>audit.record({...zero,offsetBytes:0,receiverChunkSha256:'b'.repeat(64)}));
  assert.throws(()=>audit.record({...zero,offsetBytes:0,receivedBytes:S5_TRANSFER_CHUNK_BYTES-1}));
  assert.throws(()=>audit.record({...zero,offsetBytes:2*S5_TRANSFER_CHUNK_BYTES}));
  assert.equal(audit.snapshot().accountedBytes,S5_TRANSFER_CHUNK_BYTES);
});
test('transfer ownership and unsafe 64bit JS integer targets rejected',()=>{
  for(const bad of [
    {...scope(1),targetDeviceId:'staging-source-workpc'},
    {...scope(1),epoch:-1},
    {...scope(1),expectedBytes:0},
    {...scope(1),expectedBytes:Number.MAX_SAFE_INTEGER},
  ])assert.throws(()=>new S5RollingChunkReceiptAudit(bad));
});
