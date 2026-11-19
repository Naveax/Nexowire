import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeOfflineTransferProgress} from '../../src/ops/scale-transport-metrics.js';

const base=()=>({
  phase:'PARTIAL' as const,totalBytes:226_304,sentBytes:226_304,
  receivedBytes:225_280,acknowledgedBytes:184_320,
  finalReceiptVerified:false,
});

test('synthetic sent bytes reaching total cannot falsely certify transfer completion',()=>{
  const result=summarizeOfflineTransferProgress(base());
  assert.equal(result.classification,'SYNTHETIC_EVIDENCE_ONLY');
  assert.equal(result.complete,false);
  assert.notEqual(result.progressPercent,100);
  const noReceipt=summarizeOfflineTransferProgress({
    ...base(),phase:'COMPLETE',receivedBytes:226_304,
    acknowledgedBytes:226_304,finalReceiptVerified:false,
  });
  assert.equal(noReceipt.complete,false);
  assert.equal(noReceipt.progressPercent,99);
});

test('only complete or already-present phase plus full ack and receipt can show 100%',()=>{
  for(const phase of ['COMPLETE','ALREADY_PRESENT'] as const){
    const result=summarizeOfflineTransferProgress({
      ...base(),phase,receivedBytes:226_304,
      acknowledgedBytes:226_304,finalReceiptVerified:true,
    });
    assert.equal(result.complete,true);
    assert.equal(result.progressPercent,100);
  }
  for(const phase of ['PARTIAL','FAILED','INTERRUPTED'] as const){
    const result=summarizeOfflineTransferProgress({
      ...base(),phase,receivedBytes:226_304,
      acknowledgedBytes:226_304,finalReceiptVerified:true,
    });
    assert.equal(result.complete,false);
    assert.equal(result.progressPercent,99);
  }
});

test('retransmission bytes exceed object size without implying complete transfer',()=>{
  const result=summarizeOfflineTransferProgress({
    phase:'PARTIAL',totalBytes:268_435_457,
    sentBytes:314_572_800,receivedBytes:241_172_480,
    acknowledgedBytes:209_715_200,finalReceiptVerified:false,
  });
  assert.equal(result.classification,'SYNTHETIC_EVIDENCE_ONLY');
  assert.equal(result.complete,false);
  assert.ok(result.progressPercent!==null&&result.progressPercent<100);
});

test('invalid or inconsistent byte counters fail closed as UNKNOWN',()=>{
  for(const patch of [
    {acknowledgedBytes:226_305},
    {acknowledgedBytes:225_281},
    {receivedBytes:226_305},
    {receivedBytes:Infinity},
    {sentBytes:-1},
    {totalBytes:NaN},
    {totalBytes:Number.MAX_SAFE_INTEGER+1},
    {acknowledgedBytes:undefined},
    {phase:'COMPLETED'},
    {finalReceiptVerified:'true'},
  ]){
    const result=summarizeOfflineTransferProgress({...base(),...patch});
    assert.equal(result.classification,'UNKNOWN');
    assert.equal(result.progressPercent,null);
    assert.equal(result.complete,false);
  }
});

test('zero-length synthetic transfer requires final verified receipt',()=>{
  const empty={phase:'COMPLETE',totalBytes:0,sentBytes:0,
    receivedBytes:0,acknowledgedBytes:0,finalReceiptVerified:false};
  assert.equal(summarizeOfflineTransferProgress(empty).progressPercent,0);
  const done=summarizeOfflineTransferProgress({...empty,finalReceiptVerified:true});
  assert.equal(done.progressPercent,100);
  assert.equal(done.complete,true);
});
