import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_PROTOCOL_VERSION, AgentEventSchema, AgentHelloSchema, HubRequestSchema } from '../src/protocol/agent.js';
import { capabilitiesForPlatform } from '../src/protocol/capabilities.js';

test('agent hello validates protocol and capabilities', () => {
  const parsed = AgentHelloSchema.parse({ type: 'hello', protocolVersion: AGENT_PROTOCOL_VERSION, instanceId: '11111111-1111-4111-8111-111111111111', device: { id: 'abc', name: 'workstation', platform: 'win32', arch: 'x64', agentVersion: '0.1.0', capabilities: ['shell.exec'] } });
  assert.equal(parsed.device.id, 'abc');
  assert.equal(parsed.instanceId, '11111111-1111-4111-8111-111111111111');
});

test('hub request requires UUID request id', () => {
  assert.equal(HubRequestSchema.safeParse({ type: 'request', requestId: 'not-a-uuid', capability: 'shell.exec', input: {} }).success, false);
});


test('platform capability advertisement hides Windows-only tools off Windows', () => {
  const linux = capabilitiesForPlatform('linux');
  assert.equal(linux.includes('wsl.exec'), false);
  assert.equal(linux.some((capability) => capability.startsWith('windows.')), false);

  const windows = capabilitiesForPlatform('win32');
  assert.equal(windows.includes('wsl.exec'), true);
  assert.equal(windows.includes('windows.processes'), true);
  assert.equal(windows.includes('windows.service.control'), true);
});


test('agent event validates topic, timestamp, and UUID', () => {
  const parsed = AgentEventSchema.parse({
    type: 'event',
    eventId: '33333333-3333-4333-8333-333333333333',
    at: new Date().toISOString(),
    topic: 'process.output',
    data: { sessionId: 'demo', text: 'hello' },
  });
  assert.equal(parsed.topic, 'process.output');
  assert.equal(
    AgentEventSchema.safeParse({
      type: 'event',
      eventId: 'not-a-uuid',
      at: 'not-a-date',
      topic: '',
      data: null,
    }).success,
    false,
  );
});
