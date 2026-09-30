import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentBroker } from '../src/core/agent-broker.js';
import { NexowireError } from '../src/core/errors.js';
import { ProviderRegistry } from '../src/core/provider-registry.js';
import { AgentProvider } from '../src/providers/agent-provider.js';

class ContinuityFailureBroker extends AgentBroker {
  constructor(private readonly code: string) {
    super();
  }

  override list() {
    return [
      {
        id: 'device-1',
        name: 'Device 1',
        platform: process.platform,
        arch: process.arch,
        agentVersion: 'test',
        capabilities: ['files.read', 'files.write'],
        instanceId: '11111111-1111-4111-8111-111111111111',
        connectedAt: new Date().toISOString(),
      },
    ];
  }

  override async request(): Promise<unknown> {
    throw new NexowireError(this.code, 'continuity failure');
  }
}

test('native provider marks reconnect continuity loss as retryable transport ambiguity', async () => {
  for (const code of [
    'AGENT_RECONNECT_TIMEOUT',
    'AGENT_INSTANCE_CHANGED',
    'AGENT_CAPABILITY_CHANGED',
  ]) {
    const provider = new AgentProvider(
      new ContinuityFailureBroker(code),
    );
    const result = await provider.execute({
      targetId: 'device-1',
      capability: 'files.write',
      input: { path: 'x', content: 'y' },
      requestId: '11111111-1111-4111-8111-111111111111',
    });

    assert.equal(result.ok, false, code);
    assert.equal(result.error?.code, code);
    assert.equal(result.error?.retryable, true, code);
  }
});

test('provider registry converts native process-instance change into unknown mutation state', async () => {
  const registry = new ProviderRegistry();
  registry.register(
    new AgentProvider(
      new ContinuityFailureBroker('AGENT_INSTANCE_CHANGED'),
    ),
  );

  await assert.rejects(
    () =>
      registry.execute({
        targetId: 'device-1',
        capability: 'files.write',
        input: { path: 'x', content: 'y' },
        requestId: '22222222-2222-4222-8222-222222222222',
      }),
    (error: unknown) =>
      error instanceof NexowireError &&
      error.code === 'MUTATION_STATE_UNKNOWN',
  );
});
