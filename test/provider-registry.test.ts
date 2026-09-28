import test from 'node:test';
import assert from 'node:assert/strict';
import type { Provider, ProviderExecutionRequest, ProviderTarget } from '../src/protocol/provider.js';
import type { ExecutionResult } from '../src/protocol/result.js';
import { ProviderRegistry } from '../src/core/provider-registry.js';

class FakeProvider implements Provider {
  constructor(readonly id: string, readonly priority: number, private readonly target: ProviderTarget, private readonly behavior: 'ok' | 'throw' = 'ok') {}
  async health() { return { ok: true }; }
  async listTargets() { return [this.target]; }
  async execute(request: ProviderExecutionRequest): Promise<ExecutionResult> {
    if (this.behavior === 'throw') throw new Error('provider failed');
    return { ok: true, data: { provider: this.id }, meta: { providerId: this.id, targetId: request.targetId, capability: request.capability, durationMs: 1 } };
  }
}

const target = (providerId: string): ProviderTarget => ({ id: 'device-1', name: 'Device 1', providerId, online: true, capabilities: ['shell.exec'] });

test('registry picks the highest-priority capable provider', async () => {
  const registry = new ProviderRegistry();
  registry.register(new FakeProvider('slow', 10, target('slow')));
  registry.register(new FakeProvider('fast', 100, target('fast')));
  const result = await registry.execute({ targetId: 'device-1', capability: 'shell.exec', input: {} });
  assert.equal(result.meta.providerId, 'fast');
});

test('registry fails over after provider exception', async () => {
  const registry = new ProviderRegistry();
  registry.register(new FakeProvider('primary', 100, target('primary'), 'throw'));
  registry.register(new FakeProvider('secondary', 10, target('secondary')));
  const result = await registry.execute({ targetId: 'device-1', capability: 'shell.exec', input: {} });
  assert.equal(result.meta.providerId, 'secondary');
});
