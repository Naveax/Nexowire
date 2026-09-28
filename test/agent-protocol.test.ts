import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_PROTOCOL_VERSION, AgentHelloSchema, HubRequestSchema } from '../src/protocol/agent.js';

test('agent hello validates protocol and capabilities', () => {
  const parsed = AgentHelloSchema.parse({ type: 'hello', protocolVersion: AGENT_PROTOCOL_VERSION, device: { id: 'abc', name: 'workstation', platform: 'win32', arch: 'x64', agentVersion: '0.1.0', capabilities: ['shell.exec'] } });
  assert.equal(parsed.device.id, 'abc');
});

test('hub request requires UUID request id', () => {
  assert.equal(HubRequestSchema.safeParse({ type: 'request', requestId: 'not-a-uuid', capability: 'shell.exec', input: {} }).success, false);
});
