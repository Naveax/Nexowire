import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  UnboundPairingWriter,pairingAcknowledgementLost,
  pairingMutationFingerprint,validatePairingMutation,
  validateEnrollmentClaim,
} from '../src/product/pairing-writer-authority-contract.js';

const initial={
  version:1 as const,realm:'self-host' as const,kind:'REPAIR' as const,
  ownerAccountId:'owner-example-001',deviceId:'device-example-001',
  requestId:'immutable-request-001',ownerEpoch:4,pairingEpoch:7,
  issuerEpoch:3,signerSpkiSha256:'a'.repeat(64),
  nonceSha256:'b'.repeat(64),issuedAtMs:1_800_000_000_000,
  expiresAtMs:1_800_000_120_000,
};
const claim={
  version:1 as const,realm:'self-host' as const,
  ownerAccountId:initial.ownerAccountId,deviceId:initial.deviceId,
  requestId:initial.requestId,ownerEpoch:initial.ownerEpoch,
  pairingEpoch:initial.pairingEpoch+1,issuerEpoch:initial.issuerEpoch,
  signerSpkiSha256:initial.signerSpkiSha256,
  nonceSha256:initial.nonceSha256,
  devicePossessionProofSha256:'c'.repeat(64),
};
const read={version:1 as const,realm:'self-host' as const,
  ownerAccountId:initial.ownerAccountId,deviceId:initial.deviceId};

test('two independent unbound Hubs cannot enroll, claim or infer an unpaired device',async()=>{
  const hubs=[new UnboundPairingWriter(),new UnboundPairingWriter()];
  for(const hub of hubs){
    for(const result of [await hub.commitPairing(initial),
      await hub.readCurrentPairing(read),await hub.claimEnrollment(claim)]){
      assert.equal(result.status,'BLOCKED');
      assert.equal(result.mayDispatch,false);
      assert.equal(result.mayReplay,false);
      assert.deepEqual(Object.keys(result).sort(),[
        'code','mayDispatch','mayReplay','status',
      ]);
    }
  }
});

test('immutable identity/realm/epochs/SPKI/nonce bind fingerprint; secrets never admitted',()=>{
  const base=pairingMutationFingerprint(initial);
  assert.equal(base,pairingMutationFingerprint({...initial}));
  for(const override of [
    {requestId:'immutable-request-002'},{ownerEpoch:5},{pairingEpoch:8},
    {issuerEpoch:4},{realm:'cloud'},{signerSpkiSha256:'d'.repeat(64)},
    {nonceSha256:'e'.repeat(64)},{kind:'ENROLL'},
  ]){
    assert.notEqual(base,pairingMutationFingerprint({...initial,...override}));
  }
  for(const extra of [
    {...initial,token:'nwx_mcp_DO_NOT_PERSIST'},
    {...initial,password:'DO_NOT_PERSIST'},
    {...initial,nonceSha256:'raw-nonce'},
    {...initial,ownerEpoch:0},
    {...initial,pairingEpoch:-1},
    {...initial,issuerEpoch:0},
    {...initial,kind:'REVOKE',nonceSha256:initial.nonceSha256},
    {...initial,realm:'cloud',cloudBearer:'token'},
  ]){
    assert.throws(()=>validatePairingMutation(extra),/PAIRING_INTENT_INVALID/);
  }
  assert.throws(()=>validateEnrollmentClaim({...claim,privateKey:'x'}),/PAIRING_CLAIM_INVALID/);
  assert.equal(Object.isFrozen(validatePairingMutation(initial)),true);
});

test('lost ACK preserves original requestId as UNKNOWN without replay or native effect',()=>{
  const result=pairingAcknowledgementLost(initial);
  assert.deepEqual(result,{
    status:'UNKNOWN',code:'PAIRING_COMMIT_OUTCOME_UNKNOWN',
    originalRequestId:initial.requestId,reconciliationRequired:true,
    mayDispatch:false,mayReplay:false,
  });
  assert.equal(JSON.stringify(result).includes(initial.nonceSha256),false);
});

/** Deliberately unsafe test-only SQL model of current read-then-upsert shape. */
test('TEMP two-Hub interleaving demonstrates why sequential SQLite/D1 calls are not global CAS',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'nexowire-pairing35-'));
  const dbPath=path.join(dir,'scratch.sqlite');
  const before=path.join(dir,'before.sqlite');
  let hubA:DatabaseSync|undefined,hubB:DatabaseSync|undefined;
  try{
    hubA=new DatabaseSync(dbPath);
    hubA.exec('CREATE TABLE pairing (id TEXT PRIMARY KEY, consumed INTEGER NOT NULL, epoch INTEGER NOT NULL, state TEXT NOT NULL)');
    hubA.prepare('INSERT INTO pairing VALUES(?,?,?,?)').run('pairing-id',0,7,'PAIRED');
    hubA.close();hubA=undefined;
    copyFileSync(dbPath,before);
    hubA=new DatabaseSync(dbPath);hubB=new DatabaseSync(dbPath);
    const select=(db:DatabaseSync)=>db.prepare('SELECT consumed,epoch FROM pairing WHERE id=?')
      .get('pairing-id') as {consumed:number;epoch:number};
    const a=select(hubA),b=select(hubB);
    assert.equal(a.consumed,0);assert.equal(b.consumed,0);
    // No consumed=0 + epoch condition in the UPDATE. Both callers believe
    // they used a nonce, exactly what an independent CAS must forbid.
    hubA.prepare('UPDATE pairing SET consumed=1 WHERE id=?').run('pairing-id');
    hubB.prepare('UPDATE pairing SET consumed=1 WHERE id=?').run('pairing-id');
    assert.equal(select(hubA).consumed,1);
    // A stale REPAIR overwrites REVOKE after both read epoch 7.
    hubA.prepare('UPDATE pairing SET epoch=8,state=? WHERE id=?').run('REVOKED','pairing-id');
    hubB.prepare('UPDATE pairing SET epoch=8,state=? WHERE id=?').run('PAIRED','pairing-id');
    assert.equal((hubA.prepare('SELECT state FROM pairing').get() as {state:string}).state,'PAIRED');
    hubA.close();hubA=undefined;hubB.close();hubB=undefined;
    // Snapshot restore reverses the local counter; this cannot be an
    // independent non-restorable off-host high-water witness.
    copyFileSync(before,dbPath);
    const restored=new DatabaseSync(dbPath);
    try{const row=select(restored);assert.equal(row.consumed,0);assert.equal(row.epoch,7);}
    finally{restored.close()}
  }finally{
    hubA?.close();hubB?.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('REPAIR vs REVOKE, owner rollback and realm substitution all remain BLOCKED',async()=>{
  const hubA=new UnboundPairingWriter(),hubB=new UnboundPairingWriter();
  const revoke={...initial,kind:'REVOKE' as const,nonceSha256:null};
  const options=[initial,revoke,{...initial,ownerEpoch:3},
    {...initial,pairingEpoch:1},{...initial,realm:'cloud' as const}];
  for(const intent of options){
    assert.equal((await hubA.commitPairing(intent)).status,'BLOCKED');
    assert.equal((await hubB.commitPairing(intent)).status,'BLOCKED');
  }
  assert.equal((await hubA.claimEnrollment(claim)).status,'BLOCKED');
  assert.equal((await hubB.claimEnrollment(claim)).status,'BLOCKED');
});
