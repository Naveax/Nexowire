import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import type {Socket} from 'node:net';
import {
  HUB_HANDSHAKE_TIMEOUT_MS,
  openHubTransportSocket,
  classifyHubReconnectFailure,
  planNextHubAttempt,
} from '../../src/agent/native-agent.js';

test('AI-05 Hub handshake deadline has bounded production defaults',()=>{
  assert.equal(HUB_HANDSHAKE_TIMEOUT_MS,10_000);
  assert.throws(()=>openHubTransportSocket('ws://127.0.0.1:1/agent',undefined,0),/handshake timeout/);
  assert.throws(()=>openHubTransportSocket('ws://127.0.0.1:1/agent',undefined,30_001),/handshake timeout/);
});

test('AI-05 silent TCP peer cannot block Hub endpoint failover indefinitely',{timeout:5_000},async()=>{
  const peers=new Set<Socket>();
  const server=createServer(peer=>{
    peers.add(peer);
    peer.on('error',()=>{});
    peer.once('close',()=>peers.delete(peer));
    // Deliberately accept TCP without completing any HTTP/WebSocket handshake.
  });
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});
  });
  const addr=server.address();
  assert.ok(addr&&typeof addr!=='string');
  const start=Date.now();
  let error:Error|undefined;
  const ws=openHubTransportSocket('ws://127.0.0.1:'+addr.port+'/agent',undefined,300);
  ws.on('error',err=>{error=err;});
  try {
    await new Promise<void>(resolve=>ws.once('close',()=>resolve()));
    assert.ok(error,'the stalled handshake must fail instead of staying CONNECTING');
    assert.match(error.message,/handshake.*timed out/i);
    assert.ok(Date.now()-start<3_000);
    const retry=classifyHubReconnectFailure({errorCode:(error as NodeJS.ErrnoException).code});
    assert.equal(retry.retryable,true);
    const next=planNextHubAttempt({
      currentIndex:0,endpointCount:2,backoffMs:1_000,connectedMs:0,random:()=>0.5,
    });
    assert.equal(next.endpointIndex,1,'the next configured Hub must be tried');
  } finally {
    ws.terminate();
    for(const peer of peers)peer.destroy();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
