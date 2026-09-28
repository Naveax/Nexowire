import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_PROTOCOL_VERSION, AgentHelloSchema, HubRequestSchema } from '../src/protocol/agent.js';
import { capabilitiesForPlatform } from '../src/protocol/capabilities.js';

test('agent hello validates protocol and capabilities', () => {
  const parsed = AgentHelloSchema.parse({ type: 'hello', protocolVersion: AGENT_PROTOCOL_VERSION, device: { id: 'abc', name: 'workstation', platform: 'win32', arch: 'x64', agentVersion: '0.1.0', capabilities: ['shell.exec'] } });
  assert.equal(parsed.device.id, 'abc');
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
