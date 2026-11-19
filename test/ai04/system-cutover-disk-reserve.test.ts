import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  assertSystemCutoverDiskReserve,
  SYSTEM_CUTOVER_MINIMUM_FREE_BYTES,
  SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES,
  SYSTEM_CUTOVER_STATE_VOLUME,
} from '../../src/hub/system-cutover-disk-reserve.js';

const BLOCK_BYTES=4096n;
function atLeast(bytes:bigint){
  return async(root:string)=>{
    assert.equal(root,'C:\\');
    return {bsize:Number(BLOCK_BYTES),bavail:Number((bytes+BLOCK_BYTES-1n)/BLOCK_BYTES)};
  };
}

test('8 GiB recommended reserve is reported, not mistaken for SYSTEM acceptance',async()=>{
  const available=SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES;
  const result=await assertSystemCutoverDiskReserve(atLeast(available));
  assert.equal(result.root,SYSTEM_CUTOVER_STATE_VOLUME);
  assert.equal(result.availableBytes,available);
  assert.equal(result.recommendedReserveMet,true);
  assert.equal(result.minimumFreeBytes,SYSTEM_CUTOVER_MINIMUM_FREE_BYTES);
});

test('operational minimum and advisory 8 GiB threshold are separate',async()=>{
  const result=await assertSystemCutoverDiskReserve(
    atLeast(SYSTEM_CUTOVER_MINIMUM_FREE_BYTES),
  );
  assert.ok(result.availableBytes>=SYSTEM_CUTOVER_MINIMUM_FREE_BYTES);
  assert.equal(result.recommendedReserveMet,false);
  await assert.rejects(assertSystemCutoverDiskReserve(
    async()=>({bsize:1,bavail:Number(SYSTEM_CUTOVER_MINIMUM_FREE_BYTES-1n)}),
  ),/AI04_CUTOVER_DISK_RESERVE_INSUFFICIENT/);
  await assert.rejects(assertSystemCutoverDiskReserve(
    async()=>({bsize:4096,bavail:0}),
  ),/AI04_CUTOVER_DISK_RESERVE_INSUFFICIENT/);
});

test('failed and malformed statfs responses deny migration without any write',async()=>{
  for(const read of [
    async()=>{throw new Error('native statfs unavailable');},
    async()=>null as never,
    async()=>({bsize:0,bavail:4000000}),
    async()=>({bsize:4096,bavail:-1}),
    async()=>({bsize:Number.NaN,bavail:123}),
    async()=>({bsize:4096,bavail:Number.MAX_SAFE_INTEGER+1}),
  ]){
    await assert.rejects(assertSystemCutoverDiskReserve(read),
      /AI04_CUTOVER_DISK_RESERVE_UNVERIFIED/);
  }
});

test('controlled migration checks disk twice, before artifacts and before legacy quiescence',()=>{
  const script=readFileSync(
    new URL('../../scripts/ai04-controlled-system-hub-cutover.ts',import.meta.url),'utf8',
  );
  const begin=script.indexOf('    async preflight(){');
  const recovery=script.indexOf('    async armRecovery(){',begin);
  const confirm=script.indexOf('    async confirmRecoveryBeforeQuiesce(){',recovery);
  const quiesce=script.indexOf('    async quiesceLegacy(){',confirm);
  assert.ok(begin>=0&&recovery>begin&&confirm>recovery&&quiesce>confirm);
  const first=script.slice(begin,recovery);
  const second=script.slice(confirm,quiesce);
  assert.match(first,/await assertSystemCutoverDiskReserve\(\)/);
  assert.ok(first.indexOf('assertSystemCutoverDiskReserve()')<
    first.indexOf('await absent(ROOT)'));
  assert.match(second,/await assertSystemCutoverDiskReserve\(\)/);
  assert.ok(second.indexOf('assertSystemCutoverDiskReserve()')>
    second.indexOf('verifyWindowsPrivateAcl(JOURNAL)'));
});

test('real Windows state-volume measurement is read-only and explicit',{
  skip:process.platform!=='win32',
},async()=>{
  const result=await assertSystemCutoverDiskReserve();
  assert.equal(result.root,'C:\\');
  assert.ok(result.availableBytes>=SYSTEM_CUTOVER_MINIMUM_FREE_BYTES);
});
