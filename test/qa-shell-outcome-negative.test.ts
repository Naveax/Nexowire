import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentBroker} from '../src/core/agent-broker.js';
import {AgentProvider} from '../src/providers/agent-provider.js';

class NoOSExecutionBroker extends AgentBroker{
 constructor(readonly raw:unknown){super()}
 override async request():Promise<unknown>{return this.raw}
}
for(const [name,payload,status,result] of [
 ['error with transport success',{exitCode:7,data:{timedOut:false}},'failed',false],
 ['timeout outranks exit zero',{exitCode:0,data:{timedOut:true}},'timed_out',false],
 ['missing exit code',{stdout:'started'},'unknown',null],
 ['null exit code',{exitCode:null,data:{timedOut:false}},'unknown',null],
 ['untrusted malformed exit code',{exitCode:'0',data:{timedOut:false}},'unknown',null],
] as const){
 test('negative shell outcome: '+name,async()=>{
  const provider=new AgentProvider(new NoOSExecutionBroker(payload));
  const response=await provider.execute({
   targetId:'synthetic-target',capability:'shell.exec',
   input:{command:'NOT_EXECUTED'},requestId:'00000000-0000-4000-8000-000000000001'
  });
  assert.equal(response.ok,true,'transport success is separate from task completion');
  assert.equal(response.taskStatus,status);
  assert.equal(response.taskSuccess,result);
  assert.notEqual(response.taskSuccess,true);
 });
}
