import test from 'node:test';
import assert from 'node:assert/strict';
import {summarize,markdown,csv,type Measurement} from '../../scripts/delegated/s5-report-from-json.js';
const fixture=():Measurement=>({schema:'delegated-s5-samples-v1',kind:'synthetic',startedAtUtc:'2026-10-31T00:00:00Z',endedAtUtc:'2026-10-31T00:01:00Z',environment:'offline fixture',unit:'ms',samples:Array.from({length:100},(_,i)=>({ok:i<90,latency:i+1}))});
test('nearest rank known 100-sample distribution',()=>{const r=summarize(fixture());assert.deepEqual([r.p50,r.p95,r.p99],[50,95,99]);assert.equal(r.capacity,'UNKNOWN')});
test('success and failure counts preserved',()=>{const r=summarize(fixture());assert.equal(r.success,90);assert.equal(r.errors,10);assert.equal(r.samples,100)});
test('empty samples remain unknown',()=>{const f=fixture();f.samples=[];assert.equal(summarize(f).p50,'UNKNOWN')});
test('null latency excluded without losing outcome',()=>{const f=fixture();f.samples=[{ok:false,latency:null}];const r=summarize(f);assert.equal(r.errors,1);assert.equal(r.latencySamples,0);assert.equal(r.p99,'UNKNOWN')});
test('small sample warns and zero latency valid',()=>{const f=fixture();f.samples=[{ok:true,latency:0}];assert.match(summarize(f).warning,/INSUFFICIENT/);assert.equal(summarize(f).p99,0)});
test('reject negative and nonfinite latencies',()=>{for(const n of [-1,NaN,Infinity]){const f=fixture();f.samples[0]!.latency=n;assert.throws(()=>summarize(f))}});
test('reject unknown unit/schema and reversed time',()=>{const f=fixture();assert.throws(()=>summarize({...f,unit:'s'} as unknown as Measurement));assert.throws(()=>summarize({...f,endedAtUtc:'2025-01-01T00:00:00Z'}));assert.throws(()=>summarize({...f,schema:'other'} as unknown as Measurement))});
test('markdown preserves context and never declares capacity',()=>{const s=markdown(fixture());for(const value of ['offline fixture','synthetic','2026-10-31T00:00:00Z','UNKNOWN','ms'])assert.ok(s.includes(value))});
test('CSV quotes commas, quotes and newlines',()=>{const f=fixture();f.environment='a,"b"\nc';assert.ok(csv(f).includes('"a,""b""\nc"'))});
test('input order and caller arrays unchanged',()=>{const f=fixture();f.samples.reverse();const before=JSON.stringify(f);assert.equal(summarize(f).p95,95);assert.equal(JSON.stringify(f),before)});
test('single positive sample gives identical percentiles',()=>{const f=fixture();f.samples=[{ok:true,latency:7}];const r=summarize(f);assert.deepEqual([r.p50,r.p95,r.p99],[7,7,7])});
test('nearest rank odd and tied distributions',()=>{const f=fixture();f.samples=[9,1,1,5,3].map(latency=>({ok:true,latency}));const r=summarize(f);assert.deepEqual([r.p50,r.p95,r.p99],[3,9,9])});
test('per-sample seconds cannot silently override milliseconds',()=>{const f=fixture();Object.assign(f.samples[0]!,{unit:'s'});assert.throws(()=>summarize(f))});
test('impossible dates and noncanonical timestamps rejected',()=>{for(const t of ['2026-02-30T00:00:00Z','2026-10-31Z','2026-10-31T00:00:00+00:00'])assert.throws(()=>summarize({...fixture(),startedAtUtc:t}))});
test('CSV formula prefixes neutralized including whitespace',()=>{for(const value of ['=1+1','+1','-1','@SUM(1)','\t=1','\r\n=1']){const f=fixture();f.environment=value;assert.ok(csv(f).includes('"\''+value+'"'))}});
test('CSV preserves embedded CRLF and doubled quotes',()=>{const f=fixture();f.environment='alpha,"beta"\r\ngamma';assert.ok(csv(f).includes('"alpha,""beta""\r\ngamma"'))});
test('empty percentiles all UNKNOWN and count zero',()=>{const f=fixture();f.samples=[];const r=summarize(f);assert.deepEqual([r.p50,r.p95,r.p99,r.samples,r.success,r.errors],['UNKNOWN','UNKNOWN','UNKNOWN',0,0,0])});

test('invalid local JSON never emits a partial report',async()=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {spawnSync}=await import('node:child_process');
 const dir=mkdtempSync(join(tmpdir(),'s5-invalid-cli-'));
 try{
  for(const content of ['{"latency":NaN}',JSON.stringify({...fixture(),unit:'s'})]){
   const file=join(dir,'invalid.json');writeFileSync(file,content);
   const r=spawnSync(process.execPath,['--import','tsx','scripts/delegated/s5-report-from-json.ts',file],{encoding:'utf8'});
   assert.equal(r.status,2);assert.equal(r.stdout,'');assert.notEqual(r.stderr,'');
  }
 }finally{rmSync(dir,{recursive:true,force:true})}
});
