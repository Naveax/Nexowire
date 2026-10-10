import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  guardianLocalRequestDigest,
  createGuardianLocalReplayReserve,
  createProtectedGuardianLocalReplayReserve,
  type GuardianCurrentLocalPairing,
} from '../src/agent/guardian-local-replay-ledger.js';

const REQUEST='11111111-1111-4111-8111-111111111111';
const DEVICE='device-1';
const CREDENTIAL='a'.repeat(64);
const REVISION='revision-1';

function fixture() {
  const directory=mkdtempSync(path.join(tmpdir(),'nwx-guardian-ledger-'));
  let current:GuardianCurrentLocalPairing={
    deviceId:DEVICE,credentialBinding:CREDENTIAL,
    preferenceRevision:REVISION,currentlyAuthorized:true,
  };
  let checks=0;
  let markers=0;
  const options={
    directory,
    assertProtectedDirectory:async()=>{checks++},
    assertProtectedMarker:async()=>{markers++},
    readCurrentPairing:async()=>current,
  };
  return {
    directory,options,get checks(){return checks},get markers(){return markers},
    setCurrent(value:GuardianCurrentLocalPairing){current=value},
    cleanup(){rmSync(directory,{recursive:true,force:true})},
  };
}

test('exclusive creation is one-time across concurrent distinct ledger instances',async()=>{
  const f=fixture();
  try {
    const a=createGuardianLocalReplayReserve(f.options);
    const b=createGuardianLocalReplayReserve(f.options);
    const results=await Promise.all(
      Array.from({length:18},(_,i)=>
        (i%2?a:b)(REQUEST,DEVICE,CREDENTIAL,REVISION)),
    );
    assert.equal(results.filter(x=>x===true).length,1);
    assert.equal(results.filter(x=>x===false).length,17);
    assert.equal(f.markers,1);
    const filenames=readdirSync(f.directory);
    assert.deepEqual(filenames,[guardianLocalRequestDigest(REQUEST)+'.once']);
    const contents=readFileSync(path.join(f.directory,filenames[0]!),'utf8');
    assert.doesNotMatch(contents,/device-1|revision-1|a{64}|11111111-1111/);
    assert.match(contents,/"requestDigest":"[a-f0-9]{64}"/);
  } finally {f.cleanup()}
});

test('restarts, changed pairing and owner revocation cannot replay an accepted command',async()=>{
  const f=fixture();
  try {
    const reserve=createGuardianLocalReplayReserve(f.options);
    assert.equal(await reserve(REQUEST,DEVICE,CREDENTIAL,REVISION),true);
    // A new instance has no in-memory replay state. Marker remains durable.
    assert.equal(await createGuardianLocalReplayReserve(f.options)(
      REQUEST,DEVICE,CREDENTIAL,REVISION),false);
    f.setCurrent({...await f.options.readCurrentPairing(),
      credentialBinding:'b'.repeat(64)});
    await assert.rejects(reserve(
      '22222222-2222-4222-8222-222222222222',DEVICE,CREDENTIAL,REVISION),
      /GUARDIAN_REPLAY_CURRENT_PAIRING_OR_OWNER_REVOKED/);
    f.setCurrent({...await f.options.readCurrentPairing(),
      credentialBinding:CREDENTIAL,currentlyAuthorized:false});
    await assert.rejects(reserve(
      '33333333-3333-4333-8333-333333333333',DEVICE,CREDENTIAL,REVISION),
      /GUARDIAN_REPLAY_CURRENT_PAIRING_OR_OWNER_REVOKED/);
  } finally {f.cleanup()}
});

test('owner revision mutation after tombstone write consumes request but never authorizes it',async()=>{
  const f=fixture();
  try {
    let reads=0;
    const options={...f.options,readCurrentPairing:async()=>{
      reads++;
      return {...await f.options.readCurrentPairing(),
        preferenceRevision:reads===1?REVISION:'revoked-2'};
    }};
    const reserve=createGuardianLocalReplayReserve(options);
    await assert.rejects(reserve(REQUEST,DEVICE,CREDENTIAL,REVISION),
      /GUARDIAN_REPLAY_CURRENT_PAIRING_OR_OWNER_REVOKED/);
    assert.equal(readdirSync(f.directory).length,1);
    assert.equal(await createGuardianLocalReplayReserve(f.options)(
      REQUEST,DEVICE,CREDENTIAL,REVISION),false);
  } finally {f.cleanup()}
});

test('root or marker ACL verification failures must never turn into successful reservations',async()=>{
  const f=fixture();
  try {
    const badDirectory=createGuardianLocalReplayReserve({
      ...f.options,assertProtectedDirectory:async()=>{
        throw new Error('UNTRUSTED_DIRECTORY');
      },
    });
    await assert.rejects(badDirectory(
      REQUEST,DEVICE,CREDENTIAL,REVISION),/UNTRUSTED_DIRECTORY/);
    assert.equal(readdirSync(f.directory).length,0);
    const markerFailure=createGuardianLocalReplayReserve({
      ...f.options,assertProtectedMarker:async()=>{
        throw new Error('MARKER_UNTRUSTED');
      },
    });
    await assert.rejects(markerFailure(
      REQUEST,DEVICE,CREDENTIAL,REVISION),/MARKER_UNTRUSTED/);
    assert.equal(readdirSync(f.directory).length,1);
    assert.equal(await createGuardianLocalReplayReserve(f.options)(
      REQUEST,DEVICE,CREDENTIAL,REVISION),false);
  } finally {f.cleanup()}
});

test('missing root, malformed values and noncanonical paths are rejected',async()=>{
  const f=fixture();
  try {
    assert.throws(()=>guardianLocalRequestDigest('../../evil'),
      /GUARDIAN_REPLAY_REQUEST_INVALID/);
    assert.throws(()=>createGuardianLocalReplayReserve({
      ...f.options,directory:'relative',
    }),/GUARDIAN_REPLAY_DIRECTORY_NONCANONICAL/);
    const reserve=createGuardianLocalReplayReserve(f.options);
    await assert.rejects(reserve(REQUEST,'../bad',CREDENTIAL,REVISION),
      /GUARDIAN_REPLAY_INPUT_INVALID/);
    await assert.rejects(reserve(REQUEST,DEVICE,'Z'.repeat(64),REVISION),
      /GUARDIAN_REPLAY_INPUT_INVALID/);
    await assert.rejects(reserve(REQUEST,DEVICE,CREDENTIAL,'owner/rev'),
      /GUARDIAN_REPLAY_INPUT_INVALID/);
    assert.equal(readdirSync(f.directory).length,0);
    rmSync(f.directory,{recursive:true,force:true});
    await assert.rejects(reserve(REQUEST,DEVICE,CREDENTIAL,REVISION));
  } finally {f.cleanup()}
});

test('production factory refuses platforms other than protected Windows and never creates state directory',()=>{
  const text=readFileSync(
    new URL('../src/agent/guardian-local-replay-ledger.ts',import.meta.url),
    'utf8',
  );
  assert.match(text,/C:\\\\ProgramData\\\\Nexowire\\\\bridge-guardian\\\\state/);
  assert.match(text,/verifyWindowsPrivateAcl\(node\)/);
  assert.match(text,/verifyWindowsPrivateAcl\(marker\)/);
  assert.match(text,/open\(marker,'wx',0o600\)/);
  assert.doesNotMatch(text,/mkdir\(|rm\(|unlink\(|rename\(/);
  if(process.platform!=='win32'){
    assert.throws(()=>createProtectedGuardianLocalReplayReserve(async()=>({
      deviceId:DEVICE,credentialBinding:CREDENTIAL,preferenceRevision:REVISION,
      currentlyAuthorized:true,
    })),/GUARDIAN_REPLAY_PROTECTED_WINDOWS_ONLY/);
  }
});
