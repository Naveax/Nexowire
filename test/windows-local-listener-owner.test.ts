import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {readFileSync} from 'node:fs';
import {assertWindowsLocalTcpListenerOwnedByPid} from '../src/security/windows-local-listener-owner.js';

test('read-only local listener inspector denies invalid ports or PIDs',()=>{
  if(process.platform!=='win32'){
    assert.throws(()=>assertWindowsLocalTcpListenerOwnedByPid(43110,123),
      /HUB_BOOT_LISTENER_WINDOWS_ONLY/);
    return;
  }
  for(const [port,pid] of [[0,123],[65536,123],[43110,0],
    [NaN,123],[43110,1.5]] as Array<readonly [number,number]>){
    assert.throws(()=>assertWindowsLocalTcpListenerOwnedByPid(port,pid),
      /HUB_BOOT_LISTENER_IDENTITY_INVALID/);
  }
});

test('real Windows loopback listener requires exact live socket owner, not merely an alive PID',{
  skip:process.platform!=='win32',
},async()=>{
  const server=createServer(socket=>socket.end());
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>resolve());
  });
  try{
    const bound=server.address();
    assert.ok(bound&&typeof bound==='object');
    const port=bound.port;
    assert.doesNotThrow(()=>assertWindowsLocalTcpListenerOwnedByPid(port,process.pid));
    assert.throws(()=>assertWindowsLocalTcpListenerOwnedByPid(port,process.pid+1),
      /HUB_BOOT_LISTENER_PID_MISMATCH/);
  }finally{
    await new Promise<void>((resolve,reject)=>
      server.close(error=>error?reject(error):resolve()));
  }
});

test('Hub Boot success requires listener owner binding after health response',()=>{
  const src=readFileSync(new URL('../src/hub/hub-boot-lifecycle.ts',import.meta.url),'utf8');
  const begin=src.indexOf('async function waitForBootHub(');
  const end=src.indexOf('function hardenProgramDataAcl(',begin);
  const probe=src.slice(begin,end);
  const health=probe.indexOf('if(response.ok)');
  const owner=probe.indexOf('assertWindowsLocalTcpListenerOwnedByPid(port,pid)');
  const accepted=probe.indexOf('return pid',health);
  assert.ok(health>=0&&health<owner&&owner<accepted);
  const inspector=readFileSync(
    new URL('../src/security/windows-local-listener-owner.ts',import.meta.url),'utf8');
  for(const expected of [
    'Get-NetTCPConnection -State Listen -LocalPort $listenPort',
    'OwningProcess -eq $expectedProcess',
    'NetTCPIP\\NetTCPIP.psd1',
    "result.stdout.trim()!=='HUB_BOOT_LISTENER_PID_VERIFIED'",
    'env:{',
    'protectedWindowsAclEnvironment()',
  ])assert.ok(inspector.includes(expected),expected);
  assert.doesNotMatch(inspector,/Set-Acl|icacls\.exe|Stop-Process|Start-ScheduledTask/);
});