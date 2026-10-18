import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ScaleControlPlaneMetrics, withScaleHttpMetrics, instrumentD1Database,
} from '../src/ops/scale-control-plane-metrics.js';
import type {
  D1DatabaseLike, D1PreparedStatementLike,
} from '../src/product/d1-control-plane-store.js';
import { MemoryControlPlaneStore } from '../src/product/memory-control-plane-store.js';
import { ControlPlaneService } from '../src/product/control-plane-service.js';
import { createControlPlaneHttpHandler } from '../src/product/control-plane-http.js';

test('opt-in HTTP metrics observe status without storing URL, headers or body', async () => {
  const metrics=new ScaleControlPlaneMetrics();
  const handler=createControlPlaneHttpHandler(
    new ControlPlaneService(new MemoryControlPlaneStore()),
    {authenticate:async()=>null,scaleMetrics:metrics},
  );
  const safeUrl='https://example.test/api/v1/public/usage-policy?secret=DO_NOT_CAPTURE';
  const valid=await handler(new Request(safeUrl,{
    headers:{Authorization:'Bearer SECRET_THAT_MUST_NOT_APPEAR'},
  }));
  const denied=await handler(new Request('https://example.test/api/v1/me/dashboard'));
  assert.equal(valid.status,200);
  assert.equal(denied.status,401);
  const data=metrics.snapshot();
  assert.equal(data['http.requests'].events,2);
  assert.equal(data['http.success'].events,1);
  assert.equal(data['http.client_denials'].events,1);
  assert.equal(data['http.server_errors'].events,0);
  assert.equal(Object.keys(data).length,13);
  const serialized=JSON.stringify(data);
  assert.equal(serialized.includes('SECRET_THAT_MUST_NOT_APPEAR'),false);
  assert.equal(serialized.includes('DO_NOT_CAPTURE'),false);
  assert.equal(serialized.includes('example.test'),false);
  (data['http.requests'].latencyBuckets as unknown as number[])[0]=12345;
  assert.equal(metrics.snapshot()['http.requests'].latencyBuckets[0],2);
});

test('HTTP observer failures cannot swallow original handler errors',async()=>{
  const metrics=new ScaleControlPlaneMetrics();
  const handler=withScaleHttpMetrics(async()=>{throw new Error('ORIGINAL_ERROR')},metrics);
  await assert.rejects(handler(new Request('http://localhost/mcp')),/ORIGINAL_ERROR/);
  assert.equal(metrics.snapshot()['http.requests'].events,1);
  assert.equal(metrics.snapshot()['http.handler_failures'].events,1);
});

test('D1 instrumentation preserves binding and batch identity; never stores SQL or params',async()=>{
  const metrics=new ScaleControlPlaneMetrics();
  let clock=0;
  const rawStatements=new Set<D1PreparedStatementLike>();
  const db:D1DatabaseLike={
    prepare(_sql:string) {
      const state={params:[] as unknown[]};
      const raw:D1PreparedStatementLike={
        bind(...values:unknown[]) {state.params=values;return raw},
        async first<T>() {clock+=6;return {yes:true} as T},
        async all<T>() {clock+=26;return {results:[{param:state.params[0]} as T]}},
        async run<T>() {clock+=103;return {meta:{changes:1}}}
      };
      rawStatements.add(raw);
      return raw;
    },
    async batch(statements) {
      assert.equal(statements.every(x=>rawStatements.has(x)),true);
      clock+=31;
      return Promise.all(statements.map(s=>s.run()));
    },
  };
  const instrumented=instrumentD1Database(db,metrics,()=>clock);
  const stmt=instrumented.prepare('SECRET_QUERY DO NOT LOG').bind('SECRET_PARAM');
  assert.deepEqual(await stmt.first<{yes:boolean}>(),{yes:true});
  assert.equal((await stmt.all<{param:string}>()).results?.[0]?.param,'SECRET_PARAM');
  await stmt.run();
  const batch1=instrumented.prepare('INSERT SECRET_2').bind('ANOTHER_TOKEN');
  const batch2=instrumented.prepare('INSERT SECRET_3');
  assert.equal((await instrumented.batch([batch1,batch2])).length,2);
  const snap=metrics.snapshot();
  assert.equal(snap['d1.prepare'].events,3);
  assert.equal(snap['d1.bind'].events,2);
  assert.equal(snap['d1.first'].events,1);
  assert.equal(snap['d1.all'].events,1);
  assert.equal(snap['d1.run'].events,1);
  assert.equal(snap['d1.batch'].events,1);
  assert.equal(snap['d1.batch_statements'].events,2);
  assert.equal(snap['d1.first'].latencyBuckets[1],1);
  assert.equal(snap['d1.all'].latencyBuckets[2],1);
  assert.equal(snap['d1.run'].latencyBuckets[3],1);
  assert.equal(snap['d1.failures'].events,0);
  const text=JSON.stringify(snap);
  for(const forbidden of ['SECRET_QUERY','SECRET_PARAM','ANOTHER_TOKEN']) {
    assert.equal(text.includes(forbidden),false);
  }
});

test('D1 instrumentation rethrows original errors and records only fixed counter',async()=>{
  const metrics=new ScaleControlPlaneMetrics();
  const db:D1DatabaseLike={
    prepare(){
      return {
        bind(){throw new Error('BIND_FAILURE')},
        async first(){throw new Error('QUERY_FAILURE')},
        async all(){return {results:[]}},
        async run(){return {meta:{changes:0}}},
      };
    },
    async batch(){throw new Error('BATCH_FAILURE')},
  };
  const instrumented=instrumentD1Database(db,metrics);
  assert.throws(()=>instrumented.prepare('SECRET').bind('token'),/BIND_FAILURE/);
  await assert.rejects(instrumented.prepare('SECRET').first(),/QUERY_FAILURE/);
  await assert.rejects(instrumented.batch([]),/BATCH_FAILURE/);
  assert.equal(metrics.snapshot()['d1.failures'].events,3);
  assert.equal(JSON.stringify(metrics.snapshot()).includes('SECRET'),false);
  for(const bad of [-1,NaN,Infinity])assert.throws(()=>metrics.record('d1.first',bad));
});

test('broken telemetry clock never changes HTTP or D1 results',async()=>{
  const brokenClock=():number=>{throw new Error('METRIC_CLOCK_FAILURE')};
  const metrics=new ScaleControlPlaneMetrics();
  const wrappedHandler=withScaleHttpMetrics(
    async()=>new Response('SAFE_RESPONSE',{status:200}),metrics,brokenClock,
  );
  const result=await wrappedHandler(new Request('https://example.test/api/v1/me/dashboard'));
  assert.equal(await result.text(),'SAFE_RESPONSE');
  let didRun=false;
  const db:D1DatabaseLike={
    prepare(){
      return {
        bind(){return this},
        async first<T>(){didRun=true;return {ok:1} as T},
        async all<T>(){return {results:[] as T[]}},
        async run<T>(){return {meta:{changes:1}}},
      };
    },
    async batch(){return []},
  };
  const instrumented=instrumentD1Database(db,metrics,brokenClock);
  assert.deepEqual(await instrumented.prepare('select 1').first(),{ok:1});
  assert.equal(didRun,true);
  assert.equal(metrics.snapshot()['http.success'].events,1);
  assert.equal(metrics.snapshot()['d1.first'].events,1);
});
