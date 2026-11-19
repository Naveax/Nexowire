import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {statfs} from 'node:fs/promises';
import os from 'node:os';
import {
  assertSystemCutoverDiskReserve,
  SYSTEM_CUTOVER_MINIMUM_FREE_BYTES,
  SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES,
  SYSTEM_CUTOVER_STATE_VOLUME,
  SYSTEM_CUTOVER_STATE_PROBE_PATH,
} from '../../src/hub/system-cutover-disk-reserve.js';

// One-byte synthetic blocks retain exact boundary behavior, including 1 byte
// below the minimum (a 4 KiB fixture would round that value up to a PASS).
const BLOCK_BYTES=1n;
const TEST_PROFILE='C:\\Users\\fixture';
const OTHER_VOLUME_PROFILE='D:\\Profiles\\fixture';

function syntheticVolumes(systemBytes:bigint,userBytes:bigint,profile=TEST_PROFILE){
  const seen:string[]=[];
  const read=async(probePath:string)=>{
    seen.push(probePath);
    assert.ok([SYSTEM_CUTOVER_STATE_PROBE_PATH,profile].includes(probePath),
      'Unexpected statfs target: '+probePath);
    const bytes=probePath===SYSTEM_CUTOVER_STATE_PROBE_PATH?systemBytes:userBytes;
    return {bsize:Number(BLOCK_BYTES),bavail:Number((bytes+BLOCK_BYTES-1n)/BLOCK_BYTES)};
  };
  return {read,seen,profile};
}

test('8 GiB recommended reserve requires both actual filesystem paths',async()=>{
  const sample=syntheticVolumes(
    SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES,
    SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES,
  );
  const result=await assertSystemCutoverDiskReserve(sample.read,sample.profile);
  assert.equal(result.root,SYSTEM_CUTOVER_STATE_VOLUME);
  assert.equal(result.systemStateProbePath,SYSTEM_CUTOVER_STATE_PROBE_PATH);
  assert.equal(result.userProfileProbePath,TEST_PROFILE);
  assert.equal(result.availableBytes,SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES);
  assert.equal(result.userProfileAvailableBytes,SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES);
  assert.equal(result.recommendedReserveMet,true);
  assert.equal(result.minimumFreeBytes,SYSTEM_CUTOVER_MINIMUM_FREE_BYTES);
  assert.deepEqual(sample.seen,[SYSTEM_CUTOVER_STATE_PROBE_PATH,TEST_PROFILE]);
});

test('operational floor and advisory 8 GiB threshold are separate for both paths',async()=>{
  const sample=syntheticVolumes(
    SYSTEM_CUTOVER_MINIMUM_FREE_BYTES,
    SYSTEM_CUTOVER_MINIMUM_FREE_BYTES,
  );
  const result=await assertSystemCutoverDiskReserve(sample.read,sample.profile);
  assert.ok(result.availableBytes>=SYSTEM_CUTOVER_MINIMUM_FREE_BYTES);
  assert.ok(result.userProfileAvailableBytes>=SYSTEM_CUTOVER_MINIMUM_FREE_BYTES);
  assert.equal(result.recommendedReserveMet,false);
  for(const [sys,user] of [
    [SYSTEM_CUTOVER_MINIMUM_FREE_BYTES-1n,SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES],
    [SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES,SYSTEM_CUTOVER_MINIMUM_FREE_BYTES-1n],
    [0n,SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES],
    [SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES,0n],
  ] as const){
    const probe=syntheticVolumes(sys,user);
    await assert.rejects(assertSystemCutoverDiskReserve(probe.read,probe.profile),
      /AI04_CUTOVER_DISK_RESERVE_INSUFFICIENT/);
  }
});

test('different user-profile volume cannot be falsely approved by healthy C: free space',async()=>{
  const lowSource=syntheticVolumes(
    SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES,1n*1024n**3n,
    OTHER_VOLUME_PROFILE,
  );
  await assert.rejects(
    assertSystemCutoverDiskReserve(lowSource.read,OTHER_VOLUME_PROFILE),
    /AI04_CUTOVER_DISK_RESERVE_INSUFFICIENT/,
  );
  assert.deepEqual(lowSource.seen,[
    SYSTEM_CUTOVER_STATE_PROBE_PATH,OTHER_VOLUME_PROFILE,
  ]);
  const advisorySource=syntheticVolumes(
    SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES,6n*1024n**3n,
    OTHER_VOLUME_PROFILE,
  );
  const result=await assertSystemCutoverDiskReserve(
    advisorySource.read,OTHER_VOLUME_PROFILE,
  );
  assert.equal(result.recommendedReserveMet,false);
  assert.equal(result.userProfileAvailableBytes,6n*1024n**3n);
});

test('validated legacy state root is probed even when elevated home is on another drive',async()=>{
  const root='E:\\StateMount\\Nexowire\\hub';
  const requests:string[]=[];
  const read=async(target:string)=>{
    requests.push(target);
    const bytes=target===root?1n*1024n**3n:
      SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES;
    return {bsize:1,bavail:Number(bytes)};
  };
  await assert.rejects(
    assertSystemCutoverDiskReserve(read,TEST_PROFILE,root),
    /AI04_CUTOVER_DISK_RESERVE_INSUFFICIENT/,
  );
  assert.deepEqual(requests,[
    SYSTEM_CUTOVER_STATE_PROBE_PATH,TEST_PROFILE,root,
  ]);
  requests.length=0;
  const accepted=await assertSystemCutoverDiskReserve(async(target)=>{
    requests.push(target);
    return {bsize:1,bavail:Number(SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES)};
  },TEST_PROFILE,root);
  assert.equal(accepted.sourceStateProbePath,root);
  assert.equal(accepted.sourceStateAvailableBytes,SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES);
  assert.equal(accepted.recommendedReserveMet,true);
  assert.deepEqual(requests,[SYSTEM_CUTOVER_STATE_PROBE_PATH,TEST_PROFILE,root]);
  requests.length=0;
  const sourceUnverifiable=async(target:string)=>{
    requests.push(target);
    if(target===root)throw new Error('source mount disappeared');
    return {bsize:1,bavail:Number(SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES)};
  };
  await assert.rejects(
    assertSystemCutoverDiskReserve(sourceUnverifiable,TEST_PROFILE,root),
    /AI04_CUTOVER_DISK_RESERVE_UNVERIFIED/,
  );
  assert.deepEqual(requests,[SYSTEM_CUTOVER_STATE_PROBE_PATH,TEST_PROFILE,root]);
  await assert.rejects(
    assertSystemCutoverDiskReserve(
      async()=>({bsize:1,bavail:Number(SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES)}),
      TEST_PROFILE,''),
    /AI04_CUTOVER_DISK_RESERVE_UNVERIFIED/,
  );
});

test('ProgramData mount-point uses path resolution, not an assumed C: root probe',async()=>{
  const requests:string[]=[];
  const read=async(probePath:string)=>{
    requests.push(probePath);
    const bytes=probePath===SYSTEM_CUTOVER_STATE_PROBE_PATH
      ? 2n*1024n**3n : SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES;
    return {bsize:4096,bavail:Number(bytes/4096n)};
  };
  await assert.rejects(
    assertSystemCutoverDiskReserve(read,TEST_PROFILE),
    /AI04_CUTOVER_DISK_RESERVE_INSUFFICIENT/,
  );
  assert.equal(requests[0],'C:\\ProgramData');
  assert.ok(!requests.includes('C:\\'),
    'C: root can conceal a redirected protected state mount point');
});

test('failed and malformed statfs responses on either path deny without any write',async()=>{
  for(const bad of [
    async()=>{throw new Error('native statfs unavailable');},
    async()=>null as never,
    async()=>({bsize:0,bavail:4000000}),
    async()=>({bsize:4096,bavail:-1}),
    async()=>({bsize:Number.NaN,bavail:123}),
    async()=>({bsize:4096,bavail:Number.MAX_SAFE_INTEGER+1}),
  ]){
    await assert.rejects(
      assertSystemCutoverDiskReserve(bad,TEST_PROFILE),
      /AI04_CUTOVER_DISK_RESERVE_UNVERIFIED/,
    );
    await assert.rejects(
      assertSystemCutoverDiskReserve(async(p)=>p===SYSTEM_CUTOVER_STATE_PROBE_PATH
        ? {bsize:4096,bavail:Number(SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES/4096n)}
        : bad(),TEST_PROFILE),
      /AI04_CUTOVER_DISK_RESERVE_UNVERIFIED/,
    );
  }
  await assert.rejects(
    assertSystemCutoverDiskReserve(syntheticVolumes(
      SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES,SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES,
    ).read,''),
    /AI04_CUTOVER_DISK_RESERVE_UNVERIFIED/,
  );
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
  const exactSourceCall='assertSystemCutoverDiskReserve(undefined,os.homedir(),journal.sourceRoot)';
  assert.ok(first.includes('journal.sourceRoot=assertCanonicalHubStateSourcePath('));
  assert.ok(first.includes(exactSourceCall));
  assert.ok(first.indexOf(exactSourceCall)>first.indexOf('journal.sourceRoot=assertCanonicalHubStateSourcePath('));
  assert.ok(second.includes(exactSourceCall));
  assert.ok(second.indexOf(exactSourceCall)>
    second.indexOf('verifyWindowsPrivateAcl(JOURNAL)'));
});

test('real Windows path probes accept or deny according to frozen native headroom',{
  skip:process.platform!=='win32',
},async()=>{
  // Freeze actual native readbacks. Concurrent CI disk churn cannot turn
  // correct low-space refusal into a test failure.
  const userPath=os.homedir();
  const system=await statfs(SYSTEM_CUTOVER_STATE_PROBE_PATH);
  const user=await statfs(userPath);
  const sysBytes=BigInt(system.bsize)*BigInt(system.bavail);
  const userBytes=BigInt(user.bsize)*BigInt(user.bavail);
  const read=async(probe:string)=>{
    if(probe===SYSTEM_CUTOVER_STATE_PROBE_PATH)return system;
    if(probe===userPath)return user;
    throw new Error('unexpected probe');
  };
  if(sysBytes<SYSTEM_CUTOVER_MINIMUM_FREE_BYTES||
     userBytes<SYSTEM_CUTOVER_MINIMUM_FREE_BYTES){
    await assert.rejects(assertSystemCutoverDiskReserve(read,userPath),
      /AI04_CUTOVER_DISK_RESERVE_INSUFFICIENT/);
  }else{
    const result=await assertSystemCutoverDiskReserve(read,userPath);
    assert.equal(result.availableBytes,sysBytes);
    assert.equal(result.userProfileAvailableBytes,userBytes);
    assert.equal(result.recommendedReserveMet,
      sysBytes>=SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES&&
      userBytes>=SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES);
  }
});
