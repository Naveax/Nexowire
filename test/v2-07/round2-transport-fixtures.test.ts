import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {type AddressInfo} from 'node:net';
import {WebSocket,WebSocketServer} from 'ws';
import {
  classifyHubReconnectFailure,
  parseHubHandshakeStatus,
  planNextHubAttempt,
} from '../../src/agent/native-agent.js';

function waitForError(socket:WebSocket):Promise<Error> {
  return new Promise<Error>((resolve,reject)=>{
    socket.once('open',()=>reject(Error('unexpected WebSocket authorization success')));
    socket.once('error',resolve);
  });
}
async function port(server:ReturnType<typeof createServer>):Promise<number> {
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  return (server.address() as AddressInfo).port;
}

for(const status of [401,403,429,503] as const) {
  test('round2 TCP: WebSocket HTTP '+status+' retry decision is bounded and explicit',async t=>{
    let upgrades=0;
    const server=createServer((_request,response)=>{
      response.writeHead(status,{'connection':'close'});response.end();
    });
    server.on('upgrade',(_request,socket)=>{
      upgrades++;socket.end('HTTP/1.1 '+status+' Rejected\r\nConnection: close\r\n\r\n');
    });
    const at=await port(server);
    t.after(async()=>new Promise<void>(resolve=>server.close(()=>resolve())));
    const socket=new WebSocket('ws://127.0.0.1:'+at+'/agent');
    const failure=await waitForError(socket);
    const parsed=parseHubHandshakeStatus(failure.message);
    assert.equal(parsed,status);
    const verdict=classifyHubReconnectFailure({httpStatus:parsed});
    assert.equal(verdict.retryable,status===429||status===503);
    assert.equal(verdict.minimumDelayMs,status===429||status===503?5_000:0);
    assert.equal(upgrades,1,'one initial TCP Upgrade only');
    // Runtime's caller breaks on !retryable; it must not schedule another dial.
    if (!verdict.retryable) assert.ok(['reauthorization_required'].includes(verdict.reason));
    else assert.ok(planNextHubAttempt({
      currentIndex:0,endpointCount:1,connectedMs:0,
      backoffMs:1_000,random:()=>0.5,
    }).waitMs<=verdict.minimumDelayMs);
  });
}

for(const code of [1006,1011,1013] as const) {
  test('round2 TCP: real WSS close '+code+' is classified for reconnect',async t=>{
    const server=createServer();
    const wss=new WebSocketServer({server});
    wss.on('connection',socket=>{
      if(code===1006)socket.terminate();
      else socket.close(code,'synthetic transient fault');
    });
    const at=await port(server);
    const socket=new WebSocket('ws://127.0.0.1:'+at+'/agent');
    t.after(async()=>{
      socket.terminate();
      for(const s of wss.clients)s.terminate();
      await new Promise<void>(resolve=>wss.close(()=>resolve()));
      await new Promise<void>(resolve=>server.close(()=>resolve()));
    });
    const observed=await new Promise<number>((resolve,reject)=>{
      socket.once('close',resolve);
      socket.once('error',reject);
    });
    assert.equal(observed,code);
    const verdict=classifyHubReconnectFailure({wsCloseCode:observed});
    assert.equal(verdict.retryable,true);
    assert.equal(verdict.minimumDelayMs,code===1013?5_000:0);
  });
}

test('round2 DNS: injected temporary lookup failure maps to bounded endpoint fallback',async()=>{
  let lookups=0;
  const lookup=((_host:string,_opts:unknown,callback:(error:NodeJS.ErrnoException)=>void)=>{
    lookups++;
    const error=Object.assign(new Error('synthetic DNS loss'),{code:'EAI_AGAIN'});
    callback(error);
  }) as typeof import('node:dns').lookup;
  const socket=new WebSocket('ws://synthetic.invalid/agent',{lookup});
  const error=await waitForError(socket);
  assert.equal((error as NodeJS.ErrnoException).code,'EAI_AGAIN');
  assert.equal(lookups,1);
  const verdict=classifyHubReconnectFailure({errorCode:'EAI_AGAIN'});
  assert.equal(verdict.retryable,true);
  const plan=planNextHubAttempt({currentIndex:0,endpointCount:2,
    backoffMs:1_000,connectedMs:0,random:()=>0.5});
  assert.equal(plan.endpointIndex,1);
  assert.equal(plan.waitMs,250);
});
