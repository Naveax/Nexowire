import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {
  GUARDIAN_REPLAY_SCHEMA,createGuardianSqliteReplayReserve,
} from '../src/agent/guardian-sqlite-replay-ledger.js';
import {
  hubCommandPublicKeyId,signGuardianHubCommand,
  verifyAndReserveGuardianHubCommand,
} from '../src/protocol/guardian-hub-signed-command.js';

const deviceId='device-1';
const ownerAccountId='owner-1';
const credentialBinding='a'.repeat(64);
const ownerPreferenceRevision='owner-audit-43';
const guardianKeyId='b'.repeat(64);
const requestId='11111111-1111-4111-8111-111111111111';
const clock=new Date('2026-10-10T15:01:00.000Z');

function fixture(){
  const directory=mkdtempSync(path.join(tmpdir(),'nwx-signed-sqlite-'));
  const filename=path.join(directory,'guardian.sqlite');
  const initializer=new DatabaseSync(filename);
  initializer.exec(GUARDIAN_REPLAY_SCHEMA);
  initializer.close();
  const hub=generateKeyPairSync('ed25519');
  let currentlyAuthorized=true;
  let revision=ownerPreferenceRevision;
  const open=()=>{
    const db=new DatabaseSync(filename);
    const reserve=createGuardianSqliteReplayReserve({
      database:db,assertProtected:()=>{},
      readCurrentPairing:async()=>({
        deviceId,credentialBinding,preferenceRevision:revision,currentlyAuthorized,
        approvedRequestId:requestId,approvedPreferenceRevision:revision,
      }),
    });
    const envelope=signGuardianHubCommand({
      type:'guardian.hub-bridge-command',version:1,
      intent:{
        type:'admin-bridge.mode-intent',version:1,
        requestId,deviceId,ownerAccountId,credentialBinding,
        desiredMode:'on',issuedAt:'2026-10-10T15:00:00.000Z',
        expiresAt:'2026-10-10T15:02:00.000Z',
      },
      ownerPreferenceRevision,guardianKeyId,
      hubSignerKeyId:hubCommandPublicKeyId(hub.publicKey),
    },hub.privateKey);
    const context={
      deviceId,ownerAccountId,credentialBinding,
      currentOwnerPreferenceRevision:ownerPreferenceRevision,
      currentGuardianKeyId:guardianKeyId,
      enrolledHubPublicKey:hub.publicKey,now:clock,
      nowAfterReservation:()=>new Date(clock),
      atomicallyReserveRequest:reserve,
    };
    return {db,reserve,envelope,context};
  };
  return {
    open,
    revoke:()=>{currentlyAuthorized=false;revision='revoked-owner-audit-44'},
    cleanup:()=>rmSync(directory,{force:true,recursive:true}),
  };
}

test('valid pinned-Hub command reserves one durable SQLite marker; replay fails after restart',async()=>{
  const f=fixture();
  try{
    const a=f.open();
    const verified=await verifyAndReserveGuardianHubCommand(
      a.envelope,a.context,
    );
    assert.equal(verified.authenticated,true);
    assert.equal(verified.executionAuthorized,false);
    a.db.close();

    const restarted=f.open();
    await assert.rejects(
      verifyAndReserveGuardianHubCommand(
        restarted.envelope,restarted.context,
      ),
      /GUARDIAN_HUB_COMMAND_REPLAY_OR_REVOKED/,
    );
    restarted.db.close();
  }finally{f.cleanup()}
});

test('tampered signed Hub command fails before inserting a SQLite replay marker',async()=>{
  const f=fixture();
  try{
    const a=f.open();
    const forged={
      ...a.envelope,
      signature:(a.envelope.signature.startsWith('A')?'B':'A')+
        a.envelope.signature.slice(1),
    };
    await assert.rejects(verifyAndReserveGuardianHubCommand(
      forged,a.context,
    ),/GUARDIAN_HUB_COMMAND_SIGNATURE_INVALID/);
    assert.equal((a.db.prepare(
      'SELECT COUNT(*) AS total FROM guardian_used_requests',
    ).get() as {total:number}).total,0);
    const good=await verifyAndReserveGuardianHubCommand(
      a.envelope,a.context,
    );
    assert.equal(good.authenticated,true);
    a.db.close();
  }finally{f.cleanup()}
});

test('owner revocation refuses correctly signed but not-yet-reserved command',async()=>{
  const f=fixture();
  try{
    const a=f.open();
    f.revoke();
    await assert.rejects(verifyAndReserveGuardianHubCommand(
      a.envelope,a.context,
    ),/GUARDIAN_SQLITE_CURRENT_PAIRING_REVOKED/);
    assert.equal((a.db.prepare(
      'SELECT COUNT(*) AS total FROM guardian_used_requests',
    ).get() as {total:number}).total,0);
    a.db.close();
  }finally{f.cleanup()}
});
