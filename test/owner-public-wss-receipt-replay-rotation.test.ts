import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {
  ProposedOwnerPublicWssEnrollmentLease,
  ProposedOwnerWssSqliteReceiptJournal,
  ProposedEnrolledOwnerQuotaWsSession,
} from '../src/product/owner-public-wss-enrollment-lease-proposal.js';
import {
  serializeOwnerPublicWssEnrollment,
  type SignedOwnerPublicWssEnrollment,
  type TrustedOwnerPublicWssEnrollmentContext,
} from '../src/product/owner-public-wss-operator-enrollment-proposal.js';

const now=1_800_000_000_000;
const ownerKeys=generateKeyPairSync('ed25519');
const keyPem=(key:typeof ownerKeys.publicKey)=>key.export({
  format:'pem',type:'spki',
}).toString();
const trusted:TrustedOwnerPublicWssEnrollmentContext={
  operatorId:'owner-operator-001',keyId:'owner-operator-key-001',
  operatorPublicKeyPem:keyPem(ownerKeys.publicKey),
  accountId:'owner-account-001',deviceId:'device-bound-001',
  activeSessionGeneration:4,minimumProfileRevision:3,nowMs:now,
};
function receipt(ctx=trusted,privateKey=ownerKeys.privateKey):
SignedOwnerPublicWssEnrollment {
  const e:SignedOwnerPublicWssEnrollment={
    version:1,operatorId:ctx.operatorId,keyId:ctx.keyId,
    accountId:ctx.accountId,deviceId:ctx.deviceId,
    sessionGeneration:ctx.activeSessionGeneration,profileRevision:3,
    issuedAtMs:now-1000,expiresAtMs:now+60_000,
    profile:{
      endpoint:'wss://edge.example.com/internal/owner-quota/v1/outbound',
      expectedHostname:'edge.example.com',caMode:'system',
      trustedSpkiSha256:['a'.repeat(64)],
    },signature:'',
  };
  e.signature=sign(null,serializeOwnerPublicWssEnrollment(e),
    privateKey).toString('base64url');
  return e;
}

function durableLedger(){
  const directory=mkdtempSync(path.join(tmpdir(),'nexowire-wss-receipt-'));
  const dbPath=path.join(directory,'owner-staging.sqlite');
  const open=()=>new DatabaseSync(dbPath);
  const db=open();
  db.exec(readFileSync(path.join(process.cwd(),'test','fixtures',
    'scale-v2-owner-wss-device-enrollment-dev.sql'),'utf8'));
  return {db,open,cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}
const reader=async()=>({...trusted});

test('same signed owner receipt fails on reconnect and after SQLite process reopen',async()=>{
  const store=durableLedger();
  try{
    const env=receipt();
    const first=await ProposedOwnerPublicWssEnrollmentLease.establishOnce(
      env,reader,new ProposedOwnerWssSqliteReceiptJournal(store.db),
    );
    await first.requireCurrent();
    await assert.rejects(
      ProposedOwnerPublicWssEnrollmentLease.establishOnce(
        env,reader,new ProposedOwnerWssSqliteReceiptJournal(store.db),
      ),/replay|journal unavailable/);
    store.db.close();
    const reopened=store.open();
    try{
      await assert.rejects(
        ProposedOwnerPublicWssEnrollmentLease.establishOnce(
          env,reader,new ProposedOwnerWssSqliteReceiptJournal(reopened),
        ),/replay|journal unavailable/);
      const row=reopened.prepare(
        'SELECT COUNT(*) AS n FROM proposed_owner_wss_consumed_receipts'
      ).get() as {n:number};
      assert.equal(row.n,1);
    }finally{reopened.close()}
  }finally{try{store.db.close()}catch{}store.cleanup()}
});

test('two concurrent reconnections with identical receipt get exactly one owner acceptance',async()=>{
  const store=durableLedger();
  try{
    const env=receipt();
    const journal=new ProposedOwnerWssSqliteReceiptJournal(store.db);
    const outcomes=await Promise.allSettled([
      ProposedOwnerPublicWssEnrollmentLease.establishOnce(env,reader,journal),
      ProposedOwnerPublicWssEnrollmentLease.establishOnce(env,reader,journal),
    ]);
    assert.equal(outcomes.filter(v=>v.status==='fulfilled').length,1);
    assert.equal(outcomes.filter(v=>v.status==='rejected').length,1);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM proposed_owner_wss_consumed_receipts')
      .get() as {n:number}).n,1);
  }finally{store.db.close();store.cleanup()}
});

test('foreign owner receipt even when signed by real operator cannot be redeemed for this owner',async()=>{
  const store=durableLedger();
  try{
    const foreign=receipt({...trusted,accountId:'foreign-owner-001'});
    await assert.rejects(
      ProposedOwnerPublicWssEnrollmentLease.establishOnce(
        foreign,reader,new ProposedOwnerWssSqliteReceiptJournal(store.db),
      ),/account|device|mismatch/);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM proposed_owner_wss_consumed_receipts')
      .get() as {n:number}).n,0);
  }finally{store.db.close();store.cleanup()}
});

test('rotated operator root and revoked owner session reject stale unclaimed receipt',async()=>{
  const store=durableLedger();
  try{
    const env=receipt();
    const other=generateKeyPairSync('ed25519');
    const ledger=new ProposedOwnerWssSqliteReceiptJournal(store.db);
    await assert.rejects(
      ProposedOwnerPublicWssEnrollmentLease.establishOnce(
        env,async()=>({...trusted,operatorPublicKeyPem:keyPem(other.publicKey)}),
        ledger,
      ),/signature/);
    await assert.rejects(
      ProposedOwnerPublicWssEnrollmentLease.establishOnce(
        env,async()=>({...trusted,keyId:'rotated-operator-key-002'}),
        ledger,
      ),/mismatch/);
    await assert.rejects(
      ProposedOwnerPublicWssEnrollmentLease.establishOnce(
        env,async()=>({...trusted,activeSessionGeneration:5}),
        ledger,
      ),/mismatch/);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM proposed_owner_wss_consumed_receipts')
      .get() as {n:number}).n,0);
    // A valid NEW issuer-signed receipt after key rotation succeeds.
    const rotatedCtx={...trusted,operatorPublicKeyPem:keyPem(other.publicKey),
      keyId:'rotated-operator-key-002'};
    const rotated=receipt(rotatedCtx,other.privateKey);
    const after=await ProposedOwnerPublicWssEnrollmentLease.establishOnce(
      rotated,async()=>rotatedCtx,ledger,
    );
    await after.requireCurrent();
  }finally{store.db.close();store.cleanup()}
});

test('missing or unavailable durable receipt journal denies before any public WSS dial',async()=>{
  const env=receipt();
  await assert.rejects(
    ProposedEnrolledOwnerQuotaWsSession.connect(env,reader,undefined!),
    /journal required/,
  );
  const noSchema=new DatabaseSync(':memory:');
  try{
    await assert.rejects(
      ProposedOwnerPublicWssEnrollmentLease.establishOnce(
        env,reader,new ProposedOwnerWssSqliteReceiptJournal(noSchema),
      ),/journal unavailable/,
    );
  }finally{noSchema.close()}
});
test('independent SQLite handles on the same file fence cross-Hub duplicate receipt claims',async()=>{
  const store=durableLedger();
  const second=store.open();
  try{
    const e=receipt();
    const results=await Promise.allSettled([
      ProposedOwnerPublicWssEnrollmentLease.establishOnce(e,reader,
        new ProposedOwnerWssSqliteReceiptJournal(store.db)),
      ProposedOwnerPublicWssEnrollmentLease.establishOnce(e,reader,
        new ProposedOwnerWssSqliteReceiptJournal(second)),
    ]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(results.filter(r=>r.status==='rejected').length,1);
    assert.equal((second.prepare(
      'SELECT COUNT(*) AS n FROM proposed_owner_wss_consumed_receipts'
    ).get() as {n:number}).n,1);
  }finally{second.close();store.db.close();store.cleanup()}
});
test('owner revoke after journal claim denies session and burns receipt permanently',async()=>{
  const store=durableLedger();
  try{
    const env=receipt();
    let calls=0;
    const activeThenRevoked=async()=>{
      calls++;
      return calls===1 ? {...trusted}
        : {...trusted,activeSessionGeneration:5};
    };
    await assert.rejects(
      ProposedOwnerPublicWssEnrollmentLease.establishOnce(
        env,activeThenRevoked,
        new ProposedOwnerWssSqliteReceiptJournal(store.db),
      ),/revoked|unavailable/);
    assert.equal((store.db.prepare(
      'SELECT COUNT(*) AS n FROM proposed_owner_wss_consumed_receipts'
    ).get() as {n:number}).n,1);
    await assert.rejects(
      ProposedOwnerPublicWssEnrollmentLease.establishOnce(env,reader,
        new ProposedOwnerWssSqliteReceiptJournal(store.db)),
      /replay/,
    );
  }finally{store.db.close();store.cleanup()}
});
