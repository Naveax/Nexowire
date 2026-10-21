import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentBroker } from '../src/core/agent-broker.js';
import { ProviderRegistry } from '../src/core/provider-registry.js';
import { AgentProvider } from '../src/providers/agent-provider.js';
import { createNexowireMcpServer } from '../src/mcp/create-server.js';
import { AuditLog } from '../src/audit/log.js';
import { IdempotencyStore, operationFingerprint } from '../src/operations/idempotency-store.js';
import { idempotencyEligibility } from '../src/operations/idempotency-policy.js';
import { WorkspaceStore } from '../src/workspace/store.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { classifyFailure } from '../src/protocol/error-contract-v2.js';
import { explainHypervElevation } from '../src/protocol/hyperv-elevation-evidence.js';

const DEVICE='qa02-hyperv-synthetic-device';
const VM_ID='3a4b5c6d-7e8f-4091-a2b3-4c5d6e7f8090';
const TOKEN='SyntheticQA617BearerSecret123ABC';

class DroppedConfirmationBroker extends AgentBroker {
  calls=0;
  requestIds:string[]=[];
  constructor(private readonly failureCode:string){super();}
  override list() {
    return [{id:DEVICE,name:'Synthetic HyperV QA',platform:process.platform,
      arch:process.arch,agentVersion:'fixture-1.0.5',
      capabilities:['shell.exec','files.read','files.write'],
      instanceId:'11111111-1111-4111-8111-111111111111',
      connectedAt:new Date().toISOString()}];
  }
  override async request(_targetId:string,_capability:string,_input:unknown,
    _timeoutMs:number,requestId?:string):Promise<never> {
    this.calls++;
    this.requestIds.push(requestId??'');
    const e=new Error('Bearer '+TOKEN+' lost acknowledgement') as Error&{code:string};
    e.code=this.failureCode;
    throw e;
  }
}

async function setup(broker:DroppedConfirmationBroker,root:string){
  const providers=new ProviderRegistry();
  providers.register(new AgentProvider(broker));
  const audit=new AuditLog(path.join(root,'audit.jsonl'));
  const server=createNexowireMcpServer({
    broker,providers,audit,idempotency:new IdempotencyStore(root),
    workspaces:new WorkspaceStore(root),
    skills:new SkillRegistry(path.join(process.cwd(),'skills')),
  });
  const client=new Client({name:'qa-02-hyperv-synthetic',version:'1.0.0'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b),client.connect(a)]);
  return {client,audit,async close(){await client.close();await server.close();}};
}

test('617 QA02 real MCP shell.exec adapter: UAC lost confirmation retains requestId and unknown audit, no implicit re-dispatch',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nw-qa02-hyperv-shell-'));
  try{
    for(const code of ['MUTATION_STATE_UNKNOWN','AGENT_DISCONNECTED']){
      const broker=new DroppedConfirmationBroker(code);
      const connection=await setup(broker,root);
      let operationId:string;
      try{
        // This command is a *string in a fake AgentBroker*, never executed.
        const response=await connection.client.callTool({
          name:'shell_exec',arguments:{device_id:DEVICE,command:'synthetic-RunAs-fixture-NOT-EXECUTED'},
        });
        const data=response.structuredContent as Record<string,any>;
        operationId=data.operationId as string;
        assert.match(operationId,/^[0-9a-f-]{36}$/i);
        assert.equal(data.ok,false);
        // The MCP/Hub boundary must normalize a lost post-dispatch Agent
        // connection to UNKNOWN; reporting AGENT_DISCONNECTED as a definite
        // non-execution would be unsafe.
        assert.equal(data.error.code,'MUTATION_STATE_UNKNOWN');
        assert.equal(data.error.attribution.retrySafety,'reconcile_first');
        assert.equal(data.error.attribution.dispatchState,'unknown');
        assert.equal(data.error.attribution.operationId,operationId);
        assert.equal(broker.calls,1);
        assert.deepEqual(broker.requestIds,[operationId]);
        const events=(await connection.audit.query({operationId})).events;
        assert.deepEqual(events.map(e=>e.status),['unknown','started'],
          'a dispatched shell with lost confirmation must not be audited as failed or succeeded');
        assert.ok(events.every(e=>e.operationId===operationId));
        assert.ok(!JSON.stringify(data).includes(TOKEN));
        assert.ok(!(await fs.readFile(path.join(root,'audit.jsonl'),'utf8')).includes(TOKEN));
        assert.equal(idempotencyEligibility('shell.exec',{command:'anything'}).eligible,false,
          'arbitrary privileged shell must not be silently admitted to replay-safe allowlist');
      }finally{await connection.close();}
      // New MCP/Hub instance and audit readback: no client retry is triggered.
      const again=await setup(broker,root);
      try{
        assert.deepEqual((await again.audit.query({operationId:operationId!})).events.map(e=>e.status),
          ['unknown','started']);
        assert.equal(broker.calls,1,'restarting MCP must not automatically re-execute a lost shell mutation');
      }finally{await again.close();}
    }
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('617 QA02 source-only Hyper-V reservation: journal unknown stays unknown after restart and stale VM status cannot authorize replay',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nw-qa02-hyperv-journal-'));
  try{
    const key='qa02-hyperv-unknown-fixed-request';
    const fingerprint=operationFingerprint({
      targetId:DEVICE,capability:'hyperv.vm.start',
      payload:{vmId:VM_ID,deviceId:DEVICE},
    });
    const first=new IdempotencyStore(root);
    const reservation=await first.begin({
      key,fingerprint,capability:'hyperv.vm.start',targetId:DEVICE,
    });
    assert.equal(reservation.created,true);
    const requestId=reservation.record.operationId;
    const audit=new AuditLog(path.join(root,'hyperv-audit.jsonl'));
    await audit.write({
      operationId:requestId,status:'started',capability:'hyperv.vm.start',
      targetId:DEVICE,providerId:'synthetic-no-hyperv-executor',
    });
    // A possible dispatch has no trusted VM postcondition. No Start-VM occurs.
    await first.complete(key,'unknown');
    await audit.write({
      operationId:requestId,status:'unknown',capability:'hyperv.vm.start',
      targetId:DEVICE,providerId:'synthetic-no-hyperv-executor',
      errorCode:'MUTATION_STATE_UNKNOWN',message:'Bearer '+TOKEN+' confirmation lost',
    });
    const second=new IdempotencyStore(root);
    const duplicate=await second.begin({
      key,fingerprint,capability:'hyperv.vm.start',targetId:DEVICE,
    });
    assert.equal(duplicate.created,false);
    assert.equal(duplicate.record.operationId,requestId);
    assert.equal(duplicate.record.status,'unknown');
    assert.equal((await second.getByOperationId(requestId))?.status,'unknown');
    assert.equal(duplicate.cachedResult,undefined);
    const history=(await new AuditLog(path.join(root,'hyperv-audit.jsonl'))
      .query({operationId:requestId})).events;
    assert.deepEqual(history.map(e=>e.status),['unknown','started']);
    assert.ok(history.every(e=>e.operationId===requestId));
    assert.ok(!(await fs.readFile(path.join(root,'hyperv-audit.jsonl'),'utf8')).includes(TOKEN));
    assert.equal(idempotencyEligibility('hyperv.vm.start',{vmId:VM_ID}).eligible,false,
      'no production Hyper-V dispatch capability has been safely allowlisted');
    const failure=classifyFailure({code:'MUTATION_STATE_UNKNOWN',
      observedAt:'mcp_hub',dispatched:'unknown',readOnly:false,
      correlationId:requestId,operationId:requestId});
    assert.equal(failure.retrySafety,'reconcile_first');
    assert.equal(failure.correlationId,requestId);
    const stale=explainHypervElevation({
      capability:'hyperv.vm.start',deviceId:DEVICE,vmName:'Synthetic HyperV Lab',
      vmId:VM_ID,agentConnected:true,processIntegrity:'medium',
      currentProcessElevated:false,
      broker:{authenticatedHealth:'unverified',elevatedToken:'unverified',
        versionMatch:'unverified',capabilityAllowed:false},
      localApproval:'not_verified',ownerPolicyApproved:false,
      ownerGrant:'root',rootLease:'unverified',coreEnrollment:'unverified',
      dispatch:'lost_confirmation',
      // External stale records are intentionally not part of the evidence contract.
      ...{vmState:'Running',vmStateObservedAt:'2024-01-01T00:00:00Z',
        consentExeObserved:true},
    });
    assert.equal(stale.execution.status,'unknown');
    assert.equal(stale.execution.denialSource,'undetermined');
    assert.equal(stale.execution.effectVerified,false);
    assert.equal(stale.execution.automaticallyRetryable,false);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
