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
