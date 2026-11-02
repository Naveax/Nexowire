import test from 'node:test';
import assert from 'node:assert/strict';
import {costMatrix,meters,type CostInput} from '../../scripts/delegated/s5-cost-matrix.js';
// Arithmetic-only fictional rates: not provider quotations, never shipped defaults.
const fixture=():CostInput=>({currency:'TEST',asOf:'2026-10-31',source:'synthetic arithmetic fixture',period:'one synthetic day',workload:[{share:1,perUser:{ingressRequests:2,d1Reads:3,d1Writes:1,cpuMs:4,relayGB:0.5}}],prices:Object.fromEntries(meters.map(m=>[m,{amount:2,per:10,source:'synthetic test rate',verifiedOn:'2026-10-31'}])) as CostInput['prices']});
test('hypothetical populations and arithmetic',()=>{const r=costMatrix(fixture());assert.deepEqual(r.scenarios.map(s=>s.hypotheticalUsers),[100,1000,10000]);assert.equal(r.scenarios[0]!.knownSubtotal,210);assert.equal(r.scenarios[0]!.total,'UNKNOWN')});
test('missing price propagates UNKNOWN',()=>{const f=fixture();f.prices.relayGB=null;assert.equal(costMatrix(f).scenarios[0]!.modeledVariableTotal,'UNKNOWN')});
test('missing workload propagates UNKNOWN',()=>{const f=fixture();f.workload[0]!.perUser.cpuMs=null;assert.equal(costMatrix(f).scenarios[0]!.components.cpuMs,'UNKNOWN')});
test('all unknown has zero known subtotal but unknown total',()=>{const f=fixture();for(const m of meters)f.prices[m]=null;const r=costMatrix(f).scenarios[0]!;assert.equal(r.knownSubtotal,0);assert.equal(r.modeledVariableTotal,'UNKNOWN');assert.equal(r.total,'UNKNOWN')});
test('weighted mix',()=>{const f=fixture();f.workload=[{...f.workload[0]!,share:0.5},{share:0.5,perUser:{ingressRequests:0,d1Reads:0,d1Writes:0,cpuMs:0,relayGB:0}}];assert.equal(costMatrix(f).scenarios[0]!.knownSubtotal,105)});
test('invalid shares rejected',()=>{const f=fixture();f.workload[0]!.share=.9;assert.throws(()=>costMatrix(f))});
test('metadata and price provenance required',()=>{const f=fixture();assert.throws(()=>costMatrix({...f,source:''}));f.prices.cpuMs!.source='';assert.throws(()=>costMatrix(f))});
test('negative price, zero denominator, future verification rejected',()=>{for(const patch of [{amount:-1},{per:0},{verifiedOn:'2027-01-01'}]){const f=fixture();Object.assign(f.prices.cpuMs!,patch);assert.throws(()=>costMatrix(f))}});
test('zero price explicitly supplied remains zero',()=>{const f=fixture();for(const m of meters)f.prices[m]!.amount=0;assert.equal(costMatrix(f).scenarios[0]!.modeledVariableTotal,0)});
test('nonfinite metrics rejected',()=>{const f=fixture();f.workload[0]!.perUser.cpuMs=Infinity;assert.throws(()=>costMatrix(f))});
test('mixed explicit currency rejected',()=>{const f=fixture();Object.assign(f.prices.cpuMs!,{currency:'EUR'});assert.throws(()=>costMatrix(f))});
test('mixed price unit rejected',()=>{const f=fixture();Object.assign(f.prices.cpuMs!,{unit:'seconds'});assert.throws(()=>costMatrix(f))});
test('matching explicit price units and currency accepted',()=>{const f=fixture();Object.assign(f.prices.cpuMs!,{unit:'ms',currency:'TEST'});assert.equal(costMatrix(f).scenarios[0]!.knownSubtotal,210)});
test('workload unit overrides and unknown metric keys rejected',()=>{const f=fixture();Object.assign(f.workload[0]!.perUser,{cpuSeconds:4});assert.throws(()=>costMatrix(f))});
test('NaN Infinity negative metrics and prices rejected',()=>{for(const value of [NaN,Infinity,-1]){const f=fixture();f.workload[0]!.perUser.cpuMs=value;assert.throws(()=>costMatrix(f));const g=fixture();g.prices.cpuMs!.amount=value;assert.throws(()=>costMatrix(g))}});
test('empty workload and absent price rejected rather than invented',()=>{assert.throws(()=>costMatrix({...fixture(),workload:[]}));const f=fixture();delete (f.prices as Partial<CostInput['prices']>).cpuMs;assert.throws(()=>costMatrix(f))});
test('arithmetic overflow cannot serialize as null',()=>{const f=fixture();f.workload[0]!.perUser.cpuMs=Number.MAX_VALUE;assert.throws(()=>costMatrix(f))});
test('unknown currency cannot label numeric prices',()=>{assert.throws(()=>costMatrix({...fixture(),currency:'UNKNOWN'}))});
test('made-up three-letter currency cannot label numeric prices',()=>{assert.throws(()=>costMatrix({...fixture(),currency:'ZZZ'}));assert.equal(costMatrix({...fixture(),currency:'TRY'}).currency,'TRY')});
test('impossible pricing date rejected',()=>{const f=fixture();f.prices.cpuMs!.verifiedOn='2026-02-30';assert.throws(()=>costMatrix(f))});
test('unmodeled price keys cannot silently disappear from a complete modeled subtotal',()=>{
 const f=fixture();Object.assign(f.prices,{relayGiB:{amount:100,per:1,source:'synthetic',verifiedOn:'2026-10-31'}});
 assert.throws(()=>costMatrix(f),/Unknown pricing meter/);
});
test('explicit UNKNOWN provenance cannot authorize numeric prices',()=>{
 const f=fixture();f.prices.cpuMs!.source='UNKNOWN';assert.throws(()=>costMatrix(f));
 f.prices.cpuMs=null;assert.equal(costMatrix(f).scenarios[0]!.components.cpuMs,'UNKNOWN');
});
test('positive price rate underflow fails instead of reporting a zero charge',()=>{
 const f=fixture();f.prices.relayGB={amount:Number.MIN_VALUE,per:1e100,source:'synthetic',verifiedOn:'2026-10-31'};
 assert.throws(()=>costMatrix(f),/underflow/);
});
test('positive weighted usage underflow fails instead of reporting zero quantity',()=>{
 const f=fixture();f.workload=[{share:.5,perUser:{...f.workload[0]!.perUser,relayGB:Number.MIN_VALUE}},{share:.5,perUser:{...f.workload[0]!.perUser,relayGB:0}}];
 assert.throws(()=>costMatrix(f),/underflow/);
});
test('positive charge underflow fails even when rate and quantity are representable',()=>{
 const f=fixture();f.workload[0]!.perUser.relayGB=Number.MIN_VALUE;
 f.prices.relayGB={amount:Number.MIN_VALUE,per:1,source:'synthetic',verifiedOn:'2026-10-31'};
 assert.throws(()=>costMatrix(f),/underflow/);
});

test('invalid cost CLI emits no misleading JSON',async()=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {spawnSync}=await import('node:child_process');
 const dir=mkdtempSync(join(tmpdir(),'s5-invalid-cost-cli-'));
 try{
  const f=fixture();Object.assign(f.prices.cpuMs!,{currency:'EUR'});
  const file=join(dir,'invalid.json');writeFileSync(file,JSON.stringify(f));
  const r=spawnSync(process.execPath,['--import','tsx','scripts/delegated/s5-cost-matrix.ts',file],{encoding:'utf8'});
  assert.equal(r.status,2);assert.equal(r.stdout,'');assert.notEqual(r.stderr,'');
 }finally{rmSync(dir,{recursive:true,force:true})}
});
