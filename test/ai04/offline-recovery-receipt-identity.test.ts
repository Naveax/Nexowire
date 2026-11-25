import test from 'node:test';
import assert from 'node:assert/strict';
import {captureOfflineRecoveryReceiptIdentity} from '../../src/hub/offline-recovery-receipt-identity.js';
const expected={version:1,host:'FIXTURE',marker:'fixture-transaction',sourceRoot:'fixture-source',
  launcherPath:'fixture-launcher',launcherSha256:'a'.repeat(64),port:43110,
  originalUserPrincipal:'fixture-user',createdAt:'2026-11-25T00:00:00.000Z'};
const denied=/AI02_OFFLINE_RECOVERY_RECEIPT_IDENTITY_UNVERIFIED/;
test('offline receipt identity must include every expected transaction field',()=>{
  for(const input of [undefined,null,[],{},Object.create(expected)])
    assert.throws(()=>captureOfflineRecoveryReceiptIdentity(input),denied);
  for(const key of Object.keys(expected)){
    const partial:Record<string,unknown>={...expected};delete partial[key];
    assert.throws(()=>captureOfflineRecoveryReceiptIdentity(partial),denied);
    assert.throws(()=>captureOfflineRecoveryReceiptIdentity({...expected,[key]:undefined}),denied);
  }
});
test('invalid typed identity and noncanonical timestamps cannot match a terminal receipt',()=>{
  for(const patch of [{version:2},{host:''},{marker:' '},{sourceRoot:'\0'},{launcherPath:''},
    {launcherSha256:'A'.repeat(64)},{launcherSha256:'a'.repeat(63)},
    {port:0},{port:65536},{port:43110.5},{port:'43110'},
    {originalUserPrincipal:''},{createdAt:'2026-02-30T00:00:00.000Z'},
    {createdAt:'2026-11-25T00:00:00Z'},{createdAt:'invalid'}])
    assert.throws(()=>captureOfflineRecoveryReceiptIdentity({...expected,...patch}),denied);
});
test('receipt expectation rejects getters and extra fields without invoking getters',()=>{
  let invoked=0;
  const accessor={...expected};
  Object.defineProperty(accessor,'marker',{enumerable:true,get(){invoked++;return expected.marker}});
  assert.throws(()=>captureOfflineRecoveryReceiptIdentity(accessor),denied);
  assert.equal(invoked,0);
  assert.throws(()=>captureOfflineRecoveryReceiptIdentity({...expected,phase:'ROLLED_BACK'}),denied);
  assert.throws(()=>captureOfflineRecoveryReceiptIdentity({...expected,[Symbol('extra')]:true}),denied);
});
test('valid receipt expectation becomes an immutable detached value, not authorization',()=>{
  const source={...expected};
  const pinned=captureOfflineRecoveryReceiptIdentity(source);
  assert.deepEqual(pinned,expected);assert.ok(Object.isFrozen(pinned));
  source.marker='changed';assert.equal(pinned.marker,expected.marker);
  assert.equal(Object.hasOwn(pinned,'productionUninstallAuthorized'),false);
});
