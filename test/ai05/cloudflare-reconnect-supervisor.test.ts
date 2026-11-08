import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CloudflareConnectorExitedError,
  cloudflareReconnectWaitMs,
  superviseCloudflareConnection,
  type CloudflareForegroundHandle,
} from '../../src/mcp/local-first-cloudflare.js';

test('AI-05 cloudflare recovery jitter is bounded and never spins',()=>{
  assert.equal(cloudflareReconnectWaitMs(1,()=>0),800);
  assert.equal(cloudflareReconnectWaitMs(1,()=>0.5),1_000);
  assert.equal(cloudflareReconnectWaitMs(2,()=>0.5),2_000);
  assert.equal(cloudflareReconnectWaitMs(8,()=>1),30_000);
  assert.equal(cloudflareReconnectWaitMs(999,()=>0.5),30_000);
  assert.equal(cloudflareReconnectWaitMs(1,()=>Number.NaN),1_000);
});

test('AI-05 unexpected connector exit closes old origin before single recovery attempt',async()=>{
  const shutdown=new AbortController();
  let starts=0,active=0,peak=0;
  const waits:number[]=[];
  const start=async():Promise<CloudflareForegroundHandle>=>{
    assert.equal(active,0,'old connector must be disposed before rebind');
    starts++;
    active++;
    peak=Math.max(peak,active);
    let closed=false;
    let resolveDone:()=>void=()=>{};
    const done=starts===1
      ? Promise.reject(new CloudflareConnectorExitedError())
      : new Promise<void>(resolve=>{resolveDone=resolve;});
    if(starts===2)queueMicrotask(()=>shutdown.abort());
    return {done,close:async()=>{
      if(!closed){closed=true;active--;resolveDone();}
    }};
  };
  await superviseCloudflareConnection(start,shutdown.signal,{
    random:()=>0.5,wait:async(ms)=>{waits.push(ms);},
  });
  assert.equal(starts,2);
  assert.equal(peak,1);
  assert.equal(active,0);
  assert.deepEqual(waits,[1_000]);
});

test('AI-05 startup trust/preflight failures are fatal, not retried',async()=>{
  const shutdown=new AbortController();
  let attempts=0;
  await assert.rejects(
    superviseCloudflareConnection(async()=>{
      attempts++;
      throw new Error('Cloudflare tunnel credential custody unsafe');
    },shutdown.signal,{wait:async()=>{throw new Error('unexpected retry');}}),
    /credential custody unsafe/,
  );
  assert.equal(attempts,1);
});

test('AI-05 cleanup drift fails closed instead of recovering',async()=>{
  const shutdown=new AbortController();
  let attempts=0;
  await assert.rejects(
    superviseCloudflareConnection(async()=>{
      attempts++;
      return {done:Promise.reject(new Error('unsafe runtime cleanup')),
        close:async()=>{}};
    },shutdown.signal,{wait:async()=>{throw new Error('unexpected retry');}}),
    /unsafe runtime cleanup/,
  );
  assert.equal(attempts,1);
});

test('AI-05 prolonged outage backoff resets only after stable connector lifetime',async()=>{
  const shutdown=new AbortController();
  const times=[0,5,5,10,10,15_010];
  const delays:number[]=[];
  let attempts=0;
  await superviseCloudflareConnection(async()=>{
    attempts++;
    return {done:Promise.reject(new CloudflareConnectorExitedError()),close:async()=>{}};
  },shutdown.signal,{
    now:()=>times.shift()!,
    random:()=>0.5,
    wait:async(ms)=>{
      delays.push(ms);
      if(delays.length===3)shutdown.abort();
    },
  });
  assert.equal(attempts,3);
  assert.deepEqual(delays,[1_000,2_000,1_000]);
});

test('AI-05 shutdown interrupts in-flight recovery wait without another launch',async()=>{
  const shutdown=new AbortController();
  let starts=0;
  const began=Date.now();
  const task=superviseCloudflareConnection(async()=>{
    starts++;
    return {done:Promise.reject(new CloudflareConnectorExitedError()),
      close:async()=>{}};
  },shutdown.signal,{random:()=>0.5});
  setTimeout(()=>shutdown.abort(),40);
  await task;
  assert.equal(starts,1);
  assert.ok(Date.now()-began<900,'shutdown must not wait for the full retry delay');
});

test('AI-05 pre-aborted supervisor never starts a connector',async()=>{
  const shutdown=new AbortController();
  shutdown.abort();
  let starts=0;
  await superviseCloudflareConnection(async()=>{
    starts++;
    throw new Error('unexpected start');
  },shutdown.signal);
  assert.equal(starts,0);
});
