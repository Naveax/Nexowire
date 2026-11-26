import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign,verify} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {bindRecoveryEvidence,type RecoveryEvidenceBinding} from '../../src/security/recovery-evidence-binding.js';
import {RecoveryAuthorizationUseLedger} from '../../src/security/recovery-authorization-use-ledger.js';

const bytes=(label:string)=>Buffer.from('inert test packet: '+label);
function evidence():RecoveryEvidenceBinding{
  return {purpose:'rollback',transactionIdentity:bytes('stable transaction'),scope:bytes('scope'),
    ownerApproval:bytes('approval'),sqliteContinuity:bytes('sqlite'),writerFence:bytes('fence'),
    recoveryTaskAbsence:bytes('task absence'),activationFence:bytes('activation'),
    runtimeManifest:bytes('manifest'),releaseAnchor:bytes('anchor'),runtimeHeldIdentity:bytes('runtime'),
    helperHeldIdentity:bytes('helper')};
}
function store(t:TestContext){
  const root=mkdtempSync(path.join(os.tmpdir(),'nx-ai02-bind-'));
  const file=path.join(root,'authority.sqlite'),authorityId=randomUUID(),storeId=randomUUID();
  const handles:DatabaseSync[]=[];
  t.after(()=>{for(const db of handles)if(db.isOpen)db.close();rmSync(root,{recursive:true,force:true});});
  const open=()=>{const db=new DatabaseSync(file);handles.push(db);db.exec('PRAGMA synchronous=FULL');return db;};
  const db=open();db.exec(readFileSync(new URL('../../sql/recovery-authorization-ledger.sql',import.meta.url),'utf8'));
  db.prepare('INSERT INTO recovery_authority_metadata VALUES(1,?,?)').run(authorityId,storeId);
  return {root,db,handles,open,authorityId,storeId,ledger:new RecoveryAuthorizationUseLedger(db,authorityId,storeId)};
}
test('each evidence packet and purpose is bound; refreshed evidence cannot create a new transaction key',()=>{
  const input=evidence(),first=bindRecoveryEvidence(input);
  assert.deepEqual(bindRecoveryEvidence(input),first);
  for(const key of ['scope','ownerApproval','sqliteContinuity','writerFence','recoveryTaskAbsence',
    'activationFence','runtimeManifest','releaseAnchor','runtimeHeldIdentity','helperHeldIdentity'] as const){
    const changed=bindRecoveryEvidence({...input,[key]:bytes('changed '+key)});
    assert.equal(changed.transactionSha256,first.transactionSha256,key);
    assert.notEqual(changed.bindingSha256,first.bindingSha256,key);
    assert.throws(()=>bindRecoveryEvidence({...input,[key]:Buffer.alloc(0)}),/BINDING_INVALID/);
  }
  assert.throws(()=>bindRecoveryEvidence({...input,purpose:'coordinated-uninstall'}),/BINDING_INVALID/);
  const uninstall=bindRecoveryEvidence({...input,purpose:'coordinated-uninstall',terminalReceipt:bytes('receipt')});
  assert.equal(uninstall.transactionSha256,first.transactionSha256);
  assert.notEqual(uninstall.bindingSha256,first.bindingSha256);
  assert.notEqual(bindRecoveryEvidence({...input,transactionIdentity:bytes('other transaction')}).transactionSha256,first.transactionSha256);
  assert.equal(Object.isFrozen(first),true);
});
test('length framing distinguishes adjacent variable-length packets',()=>{
  const input=evidence();
  assert.notEqual(bindRecoveryEvidence({...input,scope:Buffer.from('ab'),ownerApproval:Buffer.from('c')}).bindingSha256,
    bindRecoveryEvidence({...input,scope:Buffer.from('a'),ownerApproval:Buffer.from('bc')}).bindingSha256);
});
test('signed fixture envelope and exact evidence binding burn one stable transaction across connections',t=>{
  const f=store(t),input=evidence(),binding=bindRecoveryEvidence(input);
  const reservation=f.ledger.reserve({...binding,authorizationId:randomUUID(),deviceId:randomUUID()});
  // Disposable key only tests byte binding. It is not a production signer or observer.
  const keys=generateKeyPairSync('ed25519'),payload=Buffer.from(JSON.stringify(reservation));
  const signature=sign(null,payload,keys.privateKey);
  assert.equal(verify(null,payload,keys.publicKey,signature),true);
  const envelope=Buffer.from(JSON.stringify({payload:payload.toString('base64url'),signature:signature.toString('base64url')}));
  f.ledger.seal(reservation,envelope);
  const other=new RecoveryAuthorizationUseLedger(f.open(),f.authorityId,f.storeId);
  for(const key of ['sqliteContinuity','writerFence','recoveryTaskAbsence','runtimeHeldIdentity','helperHeldIdentity'] as const){
    const changed=bindRecoveryEvidence({...input,[key]:bytes('new observation')});
    assert.throws(()=>other.consume({...reservation,...changed},envelope),/CONSUME_DENIED/);
    assert.throws(()=>other.reserve({...changed,authorizationId:randomUUID(),deviceId:reservation.deviceId}),/RESERVATION_ALREADY_USED/);
  }
  other.consume(reservation,envelope);
  assert.throws(()=>f.ledger.consume(reservation,envelope),/CONSUME_DENIED/);
  assert.equal(f.db.prepare('SELECT state FROM recovery_authorization_uses').get()?.state,'CONSUMED');
});
test('a real disposable SQLite WAL byte change alters the commitment, not the stable transaction',t=>{
  const f=store(t),file=path.join(f.root,'disposable-ledger.sqlite'),db=new DatabaseSync(file);
  f.handles.push(db);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE records(id INTEGER PRIMARY KEY); INSERT INTO records VALUES(1)');
  const input=evidence(),wal=file+'-wal',before=readFileSync(wal);
  const first=bindRecoveryEvidence({...input,sqliteContinuity:before});
  db.exec('INSERT INTO records VALUES(2)');
  const after=readFileSync(wal),second=bindRecoveryEvidence({...input,sqliteContinuity:after});
  assert.notDeepEqual(after,before);
  assert.equal(second.transactionSha256,first.transactionSha256);
  assert.notEqual(second.bindingSha256,first.bindingSha256);
});
