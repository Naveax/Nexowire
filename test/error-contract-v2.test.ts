import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {AgentBroker} from '../src/core/agent-broker.js';
import {ProviderRegistry} from '../src/core/provider-registry.js';
import {AgentProvider} from '../src/providers/agent-provider.js';
import {createNexowireMcpServer} from '../src/mcp/create-server.js';
import {WorkspaceStore} from '../src/workspace/store.js';
import {SkillRegistry} from '../src/skills/registry.js';
import {
  classifyFailure, classifyUndeliveredUpstreamRefusal,
  redactDiagnosticText, redactDiagnosticValue,
} from '../src/protocol/error-contract-v2.js';

for (const tc of [
  {code:'MUTATION_STATE_UNKNOWN',observedAt:'mcp_hub',causeLayer:'undetermined',retrySafety:'reconcile_first'},
  {code:'UNAVAILABLE',observedAt:'mcp_hub',causeLayer:'undetermined',retrySafety:'reconcile_first'},
  {code:'PATH_DENIED',observedAt:'native_agent',causeLayer:'native_agent',retrySafety:'reconcile_first'},
  {code:'AuthRequiredError',observedAt:'native_agent',causeLayer:'identity',retrySafety:'reconcile_first'},
  {code:'WINDOWS_UAC_DENIED',observedAt:'windows_wsl',causeLayer:'windows_wsl',retrySafety:'reconcile_first'},
  {code:'TIMEOUT',observedAt:'mcp_hub',causeLayer:'undetermined',retrySafety:'reconcile_first'},
  {code:'SHELL_EXIT_NONZERO',observedAt:'native_agent',causeLayer:'operation',retrySafety:'reconcile_first'},
  {code:'TASK_VERIFICATION_FAILED',observedAt:'task_verification',causeLayer:'task_verification',retrySafety:'reconcile_first'},
] as const) {
  test('contract v2 classifies '+tc.code+' without guessing',()=>{
    const a=classifyFailure({code:tc.code,observedAt:tc.observedAt,dispatched:'unknown'});
    assert.equal(a.contractVersion,2);
    assert.equal(a.causeLayer,tc.causeLayer);
    assert.equal(a.retrySafety,tc.retrySafety);
    assert.equal(a.dispatchState,'unknown');
    assert.equal(a.certainty,tc.causeLayer==='undetermined'?'unknown':'confirmed');
  });
}

test('unverified code origin cannot assert an Agent, UAC, task or device root cause',()=>{
  for(const code of ['PATH_DENIED','WINDOWS_UAC_DENIED','SHELL_EXIT_NONZERO',
    'TASK_VERIFICATION_FAILED','AGENT_DISCONNECTED']) {
    const result=classifyFailure({code,observedAt:'mcp_hub',dispatched:'unknown'});
    assert.equal(result.causeLayer,'undetermined',code);
    assert.equal(result.certainty,'unknown',code);
    assert.equal(result.retrySafety,'reconcile_first',code);
  }
  assert.equal(classifyFailure({code:'MCP_TARGET_NOT_AUTHORIZED',observedAt:'native_agent',
    dispatched:'unknown'}).causeLayer,'undetermined');
});

test('read-only transport errors can be retried, but unknown mutations cannot',()=>{
  const read=classifyFailure({code:'AGENT_DISCONNECTED',observedAt:'native_agent',
    dispatched:'unknown',readOnly:true});
  const write=classifyFailure({code:'AGENT_DISCONNECTED',observedAt:'native_agent',
    dispatched:'unknown',readOnly:false});
  assert.equal(read.retrySafety,'read_only_retry');
  assert.equal(write.retrySafety,'reconcile_first');
});

test('upstream refusals are attributed only with explicit NOT DELIVERED evidence',()=>{
  const evidence=classifyUndeliveredUpstreamRefusal('upstream-123');
  assert.equal(evidence.causeLayer,'upstream_client');
  assert.equal(evidence.dispatchState,'not_dispatched');
  assert.ok(!evidence.nextAction.toLowerCase().includes('safety reason'));
  const falseAttribution=classifyFailure({
    code:'UPSTREAM_REFUSAL_NOT_DELIVERED',observedAt:'mcp_hub',dispatched:'unknown'
  });
  assert.equal(falseAttribution.causeLayer,'undetermined');
});

test('untrusted error prose cannot fabricate an origin, and secret metadata is redacted',()=>{
  const sample='Bearer bearerSecret_12345 api_key=ABCDEFG12345 password="pwFake123" '+
    'sk-testToken1234567890\n-----BEGIN PRIVATE KEY-----\nFAKE_PRIVATE_KEY_MATERIAL\n-----END PRIVATE KEY-----';
  const masked=redactDiagnosticText(sample);
  for(const secret of ['bearerSecret_12345','ABCDEFG12345','pwFake123',
    'sk-testToken1234567890','FAKE_PRIVATE_KEY_MATERIAL']) {
    assert.ok(!masked.includes(secret),secret);
  }
  const nested=redactDiagnosticValue({access_token:'secret',tokensUsed:17,inner:{message:sample,ok:true}});
  assert.equal((nested as {access_token:string}).access_token,'[REDACTED]');
  assert.equal((nested as {tokensUsed:number}).tokensUsed,17);
  assert.ok(!redactDiagnosticText('{"password":"example-password"}').includes('example-password'));
  assert.equal((nested as {inner:{ok:boolean}}).inner.ok,true);
  assert.equal(classifyFailure({
    code:'UNAVAILABLE',observedAt:'mcp_hub',dispatched:false
  }).causeLayer,'undetermined');
});

class SyntheticBroker extends AgentBroker {
  calls=0;
  constructor(private readonly outcome:unknown, private readonly failure?:Error){super()}
  override list() {
    return [{
      id:'error-v2-test-device',name:'Synthetic Error Device',
      platform:process.platform,arch:process.arch,agentVersion:'test',
      capabilities:['shell.exec','files.read','files.write'],
      instanceId:'11111111-1111-4111-8111-111111111111',
      connectedAt:new Date().toISOString(),
    }];
  }
  override async request():Promise<unknown>{
    this.calls++;
    if(this.failure)throw this.failure;
    return this.outcome;
  }
}
function brokerError(code:string,message:string):Error {
  const error=new Error(message) as Error & {code:string};
  error.code=code;
  return error;
}
async function mcpRun(broker:SyntheticBroker,tool:string,args:Record<string,unknown>) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nw-error-v2-'));
  const registry=new ProviderRegistry();
  registry.register(new AgentProvider(broker));
  const server=createNexowireMcpServer({
    broker,providers:registry,
    workspaces:new WorkspaceStore(root),
    skills:new SkillRegistry(path.join(process.cwd(),'skills')),
  });
  const client=new Client({name:'error-contract-v2-test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  try{
    await Promise.all([server.connect(b),client.connect(a)]);
    return await client.callTool({name:tool,arguments:{device_id:'error-v2-test-device',...args}});
  } finally {
    await client.close();await server.close();
    await fs.rm(root,{recursive:true,force:true});
  }
}

test('redaction covers bare tokens, spaced secrets and truncated private key blocks',()=>{
  const input=[
    'token=bareSampleKey987',
    'password="two word ExampleSecret123"',
    'clientSecret=clientSampleABC123',
    '-----BEGIN PRIVATE KEY-----',
    'TRUNCATED_PRIVATE_PAYLOAD_987',
  ].join('\n');
  const masked=redactDiagnosticText(input);
  for(const secret of ['bareSampleKey987','two word ExampleSecret123',
    'clientSampleABC123','TRUNCATED_PRIVATE_PAYLOAD_987']) {
    assert.ok(!masked.includes(secret),secret);
  }
  assert.ok(masked.includes('[REDACTED PRIVATE KEY]'));
  assert.equal(redactDiagnosticText('tokensUsed=42'), 'tokensUsed=42');
});

test('read-only AgentProvider disconnect is safely retryable without losing original error',async()=>{
  const broker=new SyntheticBroker(undefined,brokerError('AGENT_DISCONNECTED','lost'));
  const result=await new AgentProvider(broker).execute({
    targetId:'error-v2-test-device',capability:'files.read',input:{path:'synthetic'},
  });
  assert.equal(result.error?.code,'AGENT_DISCONNECTED');
  assert.equal(result.error?.retryable,true);
  assert.equal(result.error?.attribution?.retrySafety,'read_only_retry');
});

test('unknown vendor code remains unchanged in v1 while v2 attribution fails closed',async()=>{
  const provider=new AgentProvider(new SyntheticBroker(undefined,
    brokerError('VENDOR/403','vendor rejected without confirmed stage')));
  const result=await provider.execute({
    targetId:'error-v2-test-device',capability:'files.read',input:{path:'synthetic'},
  });
  assert.equal(result.error?.code,'VENDOR/403');
  assert.equal(result.error?.attribution?.code,'UNCLASSIFIED_ERROR');
  assert.equal(result.error?.attribution?.causeLayer,'undetermined');
  assert.equal(result.error?.attribution?.retrySafety,'read_only_retry');
});

test('named AuthRequiredError adds identity evidence without altering legacy provider code',async()=>{
  const err=new Error('password=SensitiveFakePassword987');
  err.name='AuthRequiredError';
  const broker=new SyntheticBroker(undefined,err);
  const result=await new AgentProvider(broker).execute({
    targetId:'error-v2-test-device',capability:'files.read',
    input:{path:'synthetic'},requestId:'22222222-2222-4222-8222-222222222222',
  });
  assert.equal(result.ok,false);
  assert.equal(result.error?.code,'PROVIDER_ERROR');
  assert.equal(result.error?.attribution?.code,'AuthRequiredError');
  assert.equal(result.error?.attribution?.causeLayer,'identity');
  assert.equal(result.error?.attribution?.operationId,'22222222-2222-4222-8222-222222222222');
  assert.ok(!result.error?.message.includes('SensitiveFakePassword987'));
  assert.equal(broker.calls,1);
});

test('MCP shell exitCode=1 remains ok:true, task failed and not MCP isError',async()=>{
  const broker=new SyntheticBroker({
    stdout:'api_key=HiddenDevKey123',stderr:'password=HiddenPassword123',
    exitCode:1,data:{timedOut:false},
  });
  const response=await mcpRun(broker,'shell_exec',{command:'synthetic-only'});
  const data=response.structuredContent as Record<string,any>;
  assert.equal(response.isError,undefined);
  assert.equal(data.ok,true);
  assert.equal(data.exitCode,1);
  assert.equal(data.taskStatus,'failed');
  assert.equal(data.taskSuccess,false);
  assert.equal(data.diagnostic.code,'SHELL_EXIT_NONZERO');
  assert.equal(data.diagnostic.causeLayer,'operation');
  assert.equal(broker.calls,1);
  assert.ok(!JSON.stringify(response).includes('HiddenDevKey123'));
  assert.ok(!JSON.stringify(response).includes('HiddenPassword123'));
});

test('unconfirmed shell completion remains UNKNOWN instead of a fabricated task failure',async()=>{
  const response=await mcpRun(new SyntheticBroker({exitCode:null,data:{timedOut:false}}),
    'shell_exec',{command:'synthetic-not-executed'});
  const data=response.structuredContent as Record<string,any>;
  assert.equal(response.isError,undefined);
  assert.equal(data.ok,true);
  assert.equal(data.taskStatus,'unknown');
  assert.equal(data.taskSuccess,null);
  assert.equal(data.diagnostic.code,'SHELL_TASK_OUTCOME_UNKNOWN');
  assert.equal(data.diagnostic.causeLayer,'undetermined');
  assert.equal(data.diagnostic.certainty,'unknown');
  assert.equal(data.diagnostic.retrySafety,'reconcile_first');
});

test('PATH_DENIED from Agent preserves existing MCP isError and adds scoped remediation',async()=>{
  const broker=new SyntheticBroker(undefined,brokerError('PATH_DENIED','api_key=SecretKey987 forbidden'));
  const response=await mcpRun(broker,'file_read',{path:'C:\\blocked'});
  const data=response.structuredContent as Record<string,any>;
  assert.equal(response.isError,true);
  assert.equal(data.ok,false);
  assert.equal(data.error.code,'PATH_DENIED');
  assert.equal(data.error.attribution.causeLayer,'native_agent');
  assert.equal(data.error.attribution.retrySafety,'after_reauthorization');
  assert.ok(!JSON.stringify(response).includes('SecretKey987'));
  assert.equal(broker.calls,1);
});

test('MCP pre-dispatch denial preserves v1 error code and proves Agent not called',async()=>{
  const broker=new SyntheticBroker({data:{value:1}});
  const response=await mcpRun(broker,'file_read',{
    device_id:'another-device-not-authorized',path:'C:\\blocked',
  });
  const data=response.structuredContent as Record<string,any>;
  assert.equal(response.isError,true);
  assert.equal(data.error.code,'MCP_TARGET_NOT_AUTHORIZED'); // historical v1 code preserved
  assert.equal(data.error.attribution.code,'MCP_AUTHORIZATION_DENIED');
  assert.equal(data.error.attribution.causeLayer,'mcp_hub');
  assert.equal(data.error.attribution.dispatchState,'not_dispatched');
  assert.equal(data.error.attribution.operationId,data.operationId);
  assert.equal(broker.calls,0);
});

test('ambiguous mutation transport loss cannot be auto-replayed or marked failed',async()=>{
  const broker=new SyntheticBroker(undefined,brokerError('AGENT_DISCONNECTED','disconnected'));
  const response=await mcpRun(broker,'file_write',{path:'C:\\test.txt',content:'synthetic'});
  const data=response.structuredContent as Record<string,any>;
  assert.equal(response.isError,true);
  assert.equal(data.ok,false);
  assert.equal(data.error.code,'MUTATION_STATE_UNKNOWN');
  assert.equal(data.error.attribution.causeLayer,'undetermined');
  assert.equal(data.error.attribution.dispatchState,'unknown');
  assert.equal(data.error.attribution.retrySafety,'reconcile_first');
  assert.match(data.operationId,/^[a-f0-9-]{36}$/i);
  assert.equal(data.error.attribution.operationId,data.operationId);
  assert.equal(broker.calls,1);
});
