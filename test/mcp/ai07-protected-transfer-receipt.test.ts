import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ProtectedTransferReceiptStore} from '../../src/agent/protected-transfer-receipt-store.js';
import {finalTransferSigningBytes} from '../../src/agent/native-transfer-publisher.js';
import type {LargeTransferBinding,LargeTransferIntent,LargeTransferFinalReceipt} from '../../src/mcp/durable-large-transfer.js';
async function fixture(t:import('node:test').TestContext){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-protected-receipt-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const key=generateKeyPairSync('ed25519'),id=randomUUID(),target=path.join(root,'final.bin');
  const b:LargeTransferBinding={id,ownerId:'owner',projectId:'project',sourceDeviceId:'source',targetDeviceId:'target',sourcePath:'source.bin',targetPath:target,stagePath:target+'.nexowire-upload-'+id+'.part',size:0,sha256:createHash('sha256').digest('hex')};
  const p:LargeTransferIntent={kind:'publish',requestId:randomUUID(),epoch:1,offset:0,length:0,sha256:b.sha256,dispatched:true};
  const body={jobId:id,requestId:p.requestId,epoch:p.epoch,targetDeviceId:b.targetDeviceId,targetPath:target,size:b.size,sha256:b.sha256};
  const receipt:LargeTransferFinalReceipt={...body,proof:sign(null,finalTransferSigningBytes(b,body),key.privateKey).toString('base64url')};
  let flushes=0,failFlush=false;const make=()=>new ProtectedTransferReceiptStore(root,key.publicKey,async dir=>{assert.equal(dir,root);flushes++;if(failFlush)throw Error('flush denied');});
  return {root,b,p,receipt,make,flushes:()=>flushes,failFlush:(v:boolean)=>{failFlush=v;},file:path.join(root,p.requestId+'.json')};
}
test('immutable signed receipt survives reopen; duplicate persist cannot replace it',async t=>{
  const f=await fixture(t);assert.equal(await f.make().lookup(f.b,f.p),undefined);
  await f.make().persist(f.b,f.p,f.receipt);assert.equal(f.flushes(),1);
  assert.deepEqual(await f.make().lookup(f.b,f.p),f.receipt);
  await assert.rejects(f.make().persist(f.b,f.p,f.receipt),{code:'EEXIST'});
  assert.deepEqual(await f.make().lookup(f.b,f.p),f.receipt);
});
test('receipt lookup rejects cross-owner, wrong epoch, tampering, hardlinks and oversize',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.make().persist({...f.b,ownerId:'foreign'},f.p,f.receipt),/RECEIPT_INVALID/);
  await f.make().persist(f.b,f.p,f.receipt);
  await assert.rejects(f.make().lookup(f.b,{...f.p,epoch:2}),/RECEIPT_INVALID/);
  await fs.link(f.file,f.file+'.alias');await assert.rejects(f.make().lookup(f.b,f.p),/STORE_CHANGED/);await fs.unlink(f.file+'.alias');
  await fs.writeFile(f.file,JSON.stringify({...f.receipt,proof:'A'.repeat(86)}));
  await assert.rejects(f.make().lookup(f.b,f.p),/RECEIPT_INVALID/);
  await fs.writeFile(f.file,Buffer.alloc(16385));await assert.rejects(f.make().lookup(f.b,f.p),/STORE_CHANGED/);
});
test('signed bytes from a failed namespace flush cannot be recovered without a new durable barrier',async t=>{
  const f=await fixture(t);f.failFlush(true);
  await assert.rejects(f.make().persist(f.b,f.p,f.receipt),/flush denied/);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file,'utf8')),f.receipt);
  await assert.rejects(f.make().lookup(f.b,f.p),/flush denied/);
  f.failFlush(false);
  assert.deepEqual(await f.make().lookup(f.b,f.p),f.receipt);
  assert.equal(f.flushes(),3);
});
