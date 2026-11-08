import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import WebSocket from 'ws';
import {AgentBroker} from '../src/core/agent-broker.js';
import {AGENT_PROTOCOL_VERSION, AgentHelloSchema, type AgentHello} from '../src/protocol/agent.js';
import {classifyHubReconnectFailure} from '../src/agent/native-agent.js';
import {
  createWindowsPreloginAgentIdentity,
  parseWindowsPreloginAgentIdentity,
  preloginHandoffTaskObservation,
  preloginBootstrapAllowsCapability,
} from '../src/agent/windows-prelogin-bootstrap.js';

class FakeSocket extends EventEmitter {
  readyState:number=WebSocket.OPEN;
  closeCode:number|undefined;
  close(code?:number):void {
    this.closeCode=code;
    this.readyState=WebSocket.CLOSED;
    this.emit('close');
  }
}

function hello(id:string, name:string):AgentHello {
  return AgentHelloSchema.parse({
    type:'hello',protocolVersion:AGENT_PROTOCOL_VERSION,instanceId:randomUUID(),
    device:{id,name,platform:'win32',arch:'x64',agentVersion:'1.0.8',
      capabilities:['machine.health'],privilegeMode:'broker',adminBridgeReady:false},
  });
}

test('machine-scoped prelogin IDs use a separate namespace from interactive owner IDs',()=>{
  const a=createWindowsPreloginAgentIdentity();
  const b=createWindowsPreloginAgentIdentity();
  assert.match(a.id,/^prelogin-system:[0-9a-f-]{36}$/);
  assert.notEqual(a.id,b.id);
  assert.equal(parseWindowsPreloginAgentIdentity(a),a.id);
  assert.notEqual(a.id,randomUUID());
});

test('damaged or legacy machine identities fail stage readback rather than silently changing Hub identity',()=>{
  for(const identity of [null,{}, {id:''},{id:randomUUID()},
    {id:'prelogin-system:invalid'}, {id:'prelogin-system:'+randomUUID().toUpperCase()}]){
    assert.throws(()=>parseWindowsPreloginAgentIdentity(identity),/MACHINE_IDENTITY_INVALID/);
  }
});

test('handoff observations are task-level only and never claim a connected WebSocket',()=>{
  assert.equal(preloginHandoffTaskObservation('not-installed','Running',false),'identity-unverified');
  assert.equal(preloginHandoffTaskObservation('Ready','Running',true),'system-task-not-running');
  assert.equal(preloginHandoffTaskObservation('Running','Ready',true),'prelogin-only');
  assert.equal(preloginHandoffTaskObservation('Running','Running',true),'owner-task-running');
});

test('SYSTEM and logged-on owner occupy two independent broker entries',()=>{
  const broker=new AgentBroker();
  const machine=new FakeSocket();
  const user=new FakeSocket();
  const machineId=createWindowsPreloginAgentIdentity().id;
  const userId=randomUUID();
  broker.register(machine as unknown as WebSocket,hello(machineId,'PC (prelogin)'));
  broker.register(user as unknown as WebSocket,hello(userId,'PC'));
  assert.equal(broker.has(machineId),true);
  assert.equal(broker.has(userId),true);
  assert.equal(broker.list().length,2);
  assert.equal(machine.closeCode,undefined);
  assert.equal(user.closeCode,undefined);
  machine.close();
  assert.equal(broker.has(userId),true,'SYSTEM disconnect must not evict logged-on Agent');
});

test('duplicate SYSTEM transport replaces only its own socket without starting an owner reconnect loop',()=>{
  const broker=new AgentBroker();
  const systemId=createWindowsPreloginAgentIdentity().id;
  const userId=randomUUID();
  const first=new FakeSocket(),second=new FakeSocket(),user=new FakeSocket();
  broker.register(first as unknown as WebSocket,hello(systemId,'PC (prelogin)'));
  broker.register(user as unknown as WebSocket,hello(userId,'PC'));
  broker.register(second as unknown as WebSocket,hello(systemId,'PC (prelogin)'));
  assert.equal(first.closeCode,4001);
  assert.equal(broker.has(systemId),true);
  assert.equal(broker.has(userId),true);
  assert.equal(user.closeCode,undefined);
  assert.equal(broker.list().length,2);
});

test('transient disconnect can retry; authorization rejection cannot spin in a loop',()=>{
  assert.equal(classifyHubReconnectFailure({httpStatus:503}).retryable,true);
  assert.equal(classifyHubReconnectFailure({httpStatus:401}).retryable,false);
  assert.equal(classifyHubReconnectFailure({httpStatus:403}).retryable,false);
  assert.equal(preloginBootstrapAllowsCapability('machine.health'),true);
  assert.equal(preloginBootstrapAllowsCapability('shell.exec'),false);
});

test('prelogin lifecycle never changes interactive Agent task or removes its profile during rollback',()=>{
  const source=readFileSync(new URL('../src/agent/windows-prelogin-lifecycle.ts',import.meta.url),'utf8');
  const uninstall=source.slice(source.indexOf('export async function uninstallSystemAgentPrelogin('),
    source.indexOf('export async function runSystemAgentPreloginLifecycleCommand('));
  assert.doesNotMatch(uninstall,/Unregister-ScheduledTask[^\n]*Native Agent/);
  assert.doesNotMatch(uninstall,/fs\.rm\(/);
  assert.match(source,/ownerAgentTaskState/);
  assert.match(source,/parseWindowsPreloginAgentIdentity\(JSON\.parse\(await fs\.readFile\(plan\.identityFile/);
});
