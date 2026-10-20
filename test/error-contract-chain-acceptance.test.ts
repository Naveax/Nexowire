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
import type { Provider } from '../src/protocol/provider.js';
import { createNexowireMcpServer } from '../src/mcp/create-server.js';
import { AuditLog } from '../src/audit/log.js';
import { IdempotencyStore } from '../src/operations/idempotency-store.js';
import { WorkspaceStore } from '../src/workspace/store.js';
import { SkillRegistry } from '../src/skills/registry.js';
import {
  classifyFailure, classifyUndeliveredUpstreamRefusal,
} from '../src/protocol/error-contract-v2.js';

const DEVICE = 'synthetic-chain-device';
const SECRET = 'SyntheticChainSecretNeverPersist123';
type BrokerResponse = { stdout?: string; stderr?: string;
  exitCode?: number | null; data?: unknown };

class ChainBroker extends AgentBroker {
  calls = 0;
  requestIds: Array<string | undefined> = [];
  constructor(private readonly outcome?: BrokerResponse, private readonly failure?: Error) {
    super();
  }
  override list() {
    return [{
      id: DEVICE, name: 'Nonphysical Acceptance Device', platform: process.platform,
      arch: process.arch, agentVersion: 'synthetic',
      capabilities: ['shell.exec', 'files.read', 'files.write'],
      instanceId: '11111111-1111-4111-8111-111111111111',
      connectedAt: new Date().toISOString(),
    }];
  }
  override async request(
    _targetId: string, _capability: string, _input: unknown, _timeoutMs: number,
    requestId?: string,
  ): Promise<unknown> {
    this.calls++;
    this.requestIds.push(requestId);
    if (this.failure) throw this.failure;
    return this.outcome ?? {};
  }
}
function agentError(code: string, message = 'Synthetic failure'): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

async function withChain(
  broker: ChainBroker,
  action: (client: Client, audit: AuditLog, root: string) => Promise<void>,
  overrideProvider?: Provider,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nw-error-chain-'));
  const providers = new ProviderRegistry();
  providers.register(overrideProvider ?? new AgentProvider(broker));
  const audit = new AuditLog(path.join(root, 'audit.jsonl'));
  const server = createNexowireMcpServer({
    broker, providers, audit, idempotency: new IdempotencyStore(root),
    workspaces: new WorkspaceStore(root),
    skills: new SkillRegistry(path.join(process.cwd(), 'skills')),
  });
  const client = new Client({ name: 'isolated-error-chain-acceptance', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(b), client.connect(a)]);
    await action(client, audit, root);
  } finally {
    await client.close();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({
    name, arguments: { device_id: DEVICE, ...args },
  });
  return { response, data: response.structuredContent as Record<string, any> };
}
function assertCorrelation(
  broker: ChainBroker, operationId: string, log: Array<{operationId:string}>,
) {
  assert.match(operationId, /^[0-9a-f-]{36}$/i);
  if (broker.calls > 0) assert.equal(broker.requestIds[0], operationId);
  assert.ok(log.length >= 1);
  assert.ok(log.every(entry => entry.operationId === operationId));
}

test('AC01 nonzero shell exit is task failure in response AND durable audit, not transport failure', async () => {
  const broker = new ChainBroker({
    exitCode: 1, stdout: 'api_key=' + SECRET, stderr: 'password="' + SECRET + '"',
    data: { timedOut: false },
  });
  await withChain(broker, async (client, audit, root) => {
    const { response, data } = await call(client, 'shell_exec', { command: 'synthetic; NEVER EXECUTED' });
    assert.equal(response.isError, undefined);
    assert.equal(data.ok, true);
    assert.equal(data.exitCode, 1);
    assert.equal(data.taskStatus, 'failed');
    assert.equal(data.taskSuccess, false);
    assert.equal(data.diagnostic.code, 'SHELL_EXIT_NONZERO');
    assert.equal(data.diagnostic.causeLayer, 'operation');
    assert.equal(data.diagnostic.correlationId, data.operationId);
    const history = (await audit.query({operationId: data.operationId})).events;
    assertCorrelation(broker, data.operationId, history);
    assert.deepEqual(history.map(x => x.status), ['failed', 'started']);
    assert.equal(history[0]?.errorCode, 'SHELL_EXIT_NONZERO');
    assert.ok(!JSON.stringify(response).includes(SECRET));
    assert.ok(!(await fs.readFile(path.join(root, 'audit.jsonl'), 'utf8')).includes(SECRET));
  });
});

test('AC02 timeout is taskStatus timed_out and UNKNOWN completion, never succeeded', async () => {
  const broker = new ChainBroker({ exitCode: 0, data: { timedOut: true } });
  await withChain(broker, async (client, audit) => {
    const {data} = await call(client,'shell_exec',{command:'synthetic timeout'});
    assert.equal(data.ok,true);
    assert.equal(data.taskStatus,'timed_out');
    assert.equal(data.taskSuccess,false);
    assert.equal(data.diagnostic.code,'SHELL_TASK_TIMED_OUT');
    assert.equal(data.diagnostic.retrySafety,'reconcile_first');
    const events = (await audit.query({operationId:data.operationId})).events;
    assertCorrelation(broker,data.operationId,events);
    assert.deepEqual(events.map(x=>x.status),['unknown','started']);
    assert.equal(events[0]?.errorCode,'SHELL_TASK_TIMED_OUT');
  });
});

test('AC03 shell missing exit has unknown taskSuccess=null and UNKNOWN audit', async () => {
  const broker = new ChainBroker({ exitCode:null, data:{timedOut:false} });
  await withChain(broker, async (client,audit) => {
    const {data} = await call(client,'shell_exec',{command:'synthetic incomplete'});
    assert.equal(data.taskStatus,'unknown');
    assert.equal(data.taskSuccess,null);
    assert.equal(data.diagnostic.certainty,'unknown');
    assert.deepEqual((await audit.query({operationId:data.operationId})).events.map(x=>x.status),
      ['unknown','started']);
  });
});

test('AC04 Agent PATH_DENIED preserves Agent attribution, scoped reauthorization and audit correlation', async () => {
  const broker = new ChainBroker(undefined,agentError('PATH_DENIED','Bearer '+SECRET+' path denied'));
  await withChain(broker,async(client,audit,root)=>{
    const {response,data}=await call(client,'file_read',{path:'synthetic-blocked'});
    assert.equal(response.isError,true);
    assert.equal(data.error.code,'PATH_DENIED');
    assert.equal(data.error.attribution.causeLayer,'native_agent');
    assert.equal(data.error.attribution.retrySafety,'after_reauthorization');
    assert.equal(data.error.attribution.operationId,data.operationId);
    assertCorrelation(broker,data.operationId,(await audit.query({operationId:data.operationId})).events);
    assert.ok(!JSON.stringify(response).includes(SECRET));
    assert.ok(!(await fs.readFile(path.join(root,'audit.jsonl'),'utf8')).includes(SECRET));
  });
});

test('AC05 UAC denial is a simulated Agent-reported Windows failure; do not bypass elevation',async()=>{
  const broker=new ChainBroker(undefined,agentError('WINDOWS_UAC_DENIED','password='+SECRET));
  await withChain(broker,async(client,audit)=>{
    const {data}=await call(client,'file_read',{path:'synthetic-uac'});
    assert.equal(data.error.code,'WINDOWS_UAC_DENIED');
    assert.equal(data.error.attribution.causeLayer,'windows_wsl');
    assert.equal(data.error.attribution.retrySafety,'after_reauthorization');
    assert.ok(!JSON.stringify(data).includes(SECRET));
    assertCorrelation(broker,data.operationId,(await audit.query({operationId:data.operationId})).events);
  });
});

test('AC06 UNAVAILABLE on read-only path is source-undetermined, no fake provider root cause',async()=>{
  const broker=new ChainBroker(undefined,agentError('UNAVAILABLE','synthetic unavailable'));
  await withChain(broker,async(client,audit)=>{
    const {data}=await call(client,'file_read',{path:'synthetic-unavailable'});
    assert.equal(data.error.code,'UNAVAILABLE');
    assert.equal(data.error.attribution.causeLayer,'undetermined');
    assert.equal(data.error.attribution.certainty,'unknown');
    assert.equal(data.error.attribution.retrySafety,'read_only_retry');
    assertCorrelation(broker,data.operationId,(await audit.query({operationId:data.operationId})).events);
  });
});

test('AC07 UNAVAILABLE after dispatched mutation persists UNKNOWN and does not replay',async()=>{
  const broker=new ChainBroker(undefined,agentError('UNAVAILABLE','undetermined transport outcome'));
  await withChain(broker,async(client,audit)=>{
    const args={path:'synthetic-no-file-created',content:'synthetic',mode:'overwrite',
      idempotency_key:'chain-unavailable-no-replay'};
    const {data}=await call(client,'file_write',args);
    assert.equal(data.error.code,'UNAVAILABLE');
    assert.equal(data.error.attribution.causeLayer,'undetermined');
    assert.equal(data.error.attribution.retrySafety,'reconcile_first');
    assert.equal(data.idempotency.persistedStatus,'unknown');
    assert.deepEqual((await audit.query({operationId:data.operationId})).events.map(x=>x.status),
      ['unknown','started']);
    await call(client,'file_write',args);
    assert.equal(broker.calls,1);
  });
});

test('AC08 ambiguous dropped mutation returns MUTATION_STATE_UNKNOWN with no replay',async()=>{
  const broker=new ChainBroker(undefined,agentError('AGENT_DISCONNECTED','Synthetic drop after dispatch'));
  await withChain(broker,async(client,audit)=>{
    const args={path:'synthetic-no-file-created',content:'synthetic',mode:'overwrite',
      idempotency_key:'chain-transport-disconnect'};
    const {data}=await call(client,'file_write',args);
    assert.equal(data.error.code,'MUTATION_STATE_UNKNOWN');
    assert.equal(data.error.attribution.causeLayer,'undetermined');
    assert.equal(data.error.attribution.dispatchState,'unknown');
    assert.equal(data.error.attribution.retrySafety,'reconcile_first');
    assertCorrelation(broker,data.operationId,(await audit.query({operationId:data.operationId})).events);
    assert.deepEqual((await audit.query({operationId:data.operationId})).events.map(x=>x.status),
      ['unknown','started']);
    await call(client,'file_write',args);
    assert.equal(broker.calls,1);
  });
});

test('AC09 invalid device is denied before Agent dispatch with Hub-only attribution',async()=>{
  const broker=new ChainBroker({data:{ok:true}});
  await withChain(broker,async(client,audit)=>{
    const {data}=await call(client,'file_read',{device_id:'not-authorized-device',path:'synthetic'});
    assert.equal(data.error.code,'MCP_TARGET_NOT_AUTHORIZED');
    assert.equal(data.error.attribution.causeLayer,'mcp_hub');
    assert.equal(data.error.attribution.dispatchState,'not_dispatched');
    assert.equal(broker.calls,0);
    assert.deepEqual((await audit.query({operationId:data.operationId})).events.map(x=>x.status),
      ['failed']);
  });
});

test('AC10 upstream not-delivered refusal requires explicit external evidence, not Hub inference',()=>{
  const externallyObserved=classifyUndeliveredUpstreamRefusal('synthetic-upstream-nondispatch');
  assert.equal(externallyObserved.causeLayer,'upstream_client');
  assert.equal(externallyObserved.dispatchState,'not_dispatched');
  assert.equal(externallyObserved.observedAt,'upstream_client');
  assert.ok(!externallyObserved.nextAction.toLowerCase().includes('hidden reason'));
  const unsolicited=classifyFailure({code:'UPSTREAM_REFUSAL_NOT_DELIVERED',
    observedAt:'mcp_hub',dispatched:'unknown'});
  assert.equal(unsolicited.causeLayer,'undetermined');
  assert.equal(unsolicited.certainty,'unknown');
});

test('AC11 separate task-verification evidence cannot be inferred from transport',()=>{
  const verified=classifyFailure({code:'TASK_VERIFICATION_FAILED',
    observedAt:'task_verification',dispatched:true});
  const unverified=classifyFailure({code:'TASK_VERIFICATION_FAILED',
    observedAt:'mcp_hub',dispatched:true});
  assert.equal(verified.causeLayer,'task_verification');
  assert.equal(unverified.causeLayer,'undetermined');
});

test('AC13 zero-exit shell has confirmed taskSuccess and succeeded audit',async()=>{
  const broker=new ChainBroker({exitCode:0,data:{timedOut:false}});
  await withChain(broker,async(client,audit)=>{
    const {data}=await call(client,'shell_exec',{command:'synthetic zero exit'});
    assert.equal(data.taskStatus,'succeeded');
    assert.equal(data.taskSuccess,true);
    assert.deepEqual((await audit.query({operationId:data.operationId})).events.map(x=>x.status),
      ['succeeded','started']);
  });
});

test('AC14 malformed provider success without task proof has UNKNOWN audit outcome',async()=>{
  const broker=new ChainBroker();
  const fake:Provider={
    id:'synthetic-malformed-provider',priority:200,
    async health(){return {ok:true}},
    async listTargets(){return [{id:DEVICE,name:'Unverified Task Provider',providerId:this.id,
      online:true,capabilities:['shell.exec']}]},
    async execute(request){return {ok:true,meta:{providerId:this.id,targetId:DEVICE,
      capability:request.capability,durationMs:0,requestId:request.requestId}}},
  };
  await withChain(broker,async(client,audit)=>{
    const {data}=await call(client,'shell_exec',{command:'synthetic unverified provider'});
    assert.equal(data.ok,true);
    assert.equal(data.taskStatus,undefined);
    assert.equal(data.taskSuccess,undefined);
    assert.deepEqual((await audit.query({operationId:data.operationId})).events.map(x=>x.status),
      ['unknown','started']);
    assert.equal(broker.calls,0);
  },fake);
});

test('AC12 audit persistence sanitizes direct error metadata at its own write boundary',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nw-error-audit-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const filename=path.join(root,'audit.jsonl');
  const audit=new AuditLog(filename);
  await audit.write({operationId:'synthetic-op',status:'failed',capability:'files.read',
    targetId:'Bearer '+SECRET,providerId:'api_key='+SECRET,
    errorCode:'token='+SECRET,message:'password="'+SECRET+'"'});
  const raw=await fs.readFile(filename,'utf8');
  assert.ok(!raw.includes(SECRET));
  assert.ok(!JSON.stringify(audit.list()).includes(SECRET));
  assert.ok(!JSON.stringify((await audit.query()).events).includes(SECRET));
});
