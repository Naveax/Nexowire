import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeOfflineTransferProgress as summarize} from '../../../src/ops/scale-transport-metrics.js';

// Offline arithmetic only: no allocation proportional to file size, device I/O,
// authenticated receipt validation, or real transfer acceptance.
const row={phase:'COMPLETE',totalBytes:1_073_741_825,sentBytes:1_073_741_825,
  receivedBytes:1_073_741_825,acknowledgedBytes:1_073_741_825,finalReceiptVerified:true};

test('AI-07 all requested size boundaries stay below 100 without final receipt',()=>{
  for(const size of [221*1024,1_048_576,268_435_456,268_435_457,1_073_741_825,Number.MAX_SAFE_INTEGER]){
    const input={...row,totalBytes:size,sentBytes:size,receivedBytes:size,
      acknowledgedBytes:size,finalReceiptVerified:false};
    const pending=summarize(input);
    assert.equal(pending.classification,'SYNTHETIC_EVIDENCE_ONLY');
    assert.equal(pending.progressPercent,99);
    assert.equal(pending.complete,false);
    const completed=summarize({...input,finalReceiptVerified:true});
    assert.equal(completed.progressPercent,100);
    assert.equal(completed.complete,true);
    assert.equal(completed.classification,'SYNTHETIC_EVIDENCE_ONLY');
  }
});

test('AI-07 interrupted or failed phase cannot become complete through counters',()=>{
  for(const phase of ['PARTIAL','INTERRUPTED','FAILED']){
    const result=summarize({...row,phase});
    assert.equal(result.progressPercent,99);
    assert.equal(result.complete,false);
  }
});

test('AI-07 incomplete acknowledged prefix remains incomplete even with receipt flag',()=>{
  const result=summarize({...row,acknowledgedBytes:row.totalBytes-1});
  assert.equal(result.complete,false);
  assert.equal(result.progressPercent,99);
});

test('AI-07 inconsistent byte ordering and counts are UNKNOWN',()=>{
  for(const input of [
    {...row,acknowledgedBytes:row.totalBytes+1},
    {...row,receivedBytes:row.totalBytes-1},
    {...row,sentBytes:row.totalBytes-1},
    {...row,acknowledgedBytes:-1},
    {...row,receivedBytes:0.5},
    {...row,totalBytes:Number.MAX_SAFE_INTEGER+1},
    {...row,sentBytes:Infinity},
    {...row,receivedBytes:NaN},
    {...row,acknowledgedBytes:String(row.totalBytes)},
  ]){
    const result=summarize(input);
    assert.equal(result.classification,'UNKNOWN');
    assert.equal(result.progressPercent,null);
    assert.equal(result.complete,false);
  }
});

test('AI-07 repeated transport bytes do not inflate durable acknowledged progress',()=>{
  const result=summarize({...row,phase:'PARTIAL',sentBytes:2*row.totalBytes,
    receivedBytes:2*row.totalBytes,acknowledgedBytes:Math.floor(row.totalBytes/2),
    finalReceiptVerified:false});
  assert.equal(result.classification,'SYNTHETIC_EVIDENCE_ONLY');
  assert.equal(result.progressPercent,49);
  assert.equal(result.complete,false);
});

test('AI-07 zero byte transfer requires an explicit final receipt',()=>{
  const empty={...row,totalBytes:0,sentBytes:0,receivedBytes:0,acknowledgedBytes:0};
  const pending=summarize({...empty,finalReceiptVerified:false});
  assert.equal(pending.progressPercent,0);
  assert.equal(pending.complete,false);
  assert.equal(summarize(empty).progressPercent,100);
  assert.equal(summarize(empty).classification,'SYNTHETIC_EVIDENCE_ONLY');
});

test('AI-07 invalid phases, absent fields and non-boolean receipts stay UNKNOWN',()=>{
  for(const input of [null,[],{}, {...row,phase:'UNKNOWN'},
    {...row,phase:'VERIFIED'}, {...row,finalReceiptVerified:'true'},
    {...row,finalReceiptVerified:1}, {...row,finalReceiptVerified:undefined}]){
    const result=summarize(input);
    assert.equal(result.classification,'UNKNOWN');
    assert.equal(result.complete,false);
    assert.equal(result.progressPercent,null);
  }
});

test('AI-07 safe-integer arithmetic does not round partial transfer to completion',()=>{
  const n=Number.MAX_SAFE_INTEGER;
  const result=summarize({...row,totalBytes:n,sentBytes:n,receivedBytes:n,acknowledgedBytes:n-1});
  assert.equal(result.progressPercent,99);
  assert.equal(result.complete,false);
});
