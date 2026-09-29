import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  Provider,
  ProviderExecutionRequest,
  ProviderTarget,
} from '../src/protocol/provider.js';
import type { ExecutionResult } from '../src/protocol/result.js';
import { NexowireError } from '../src/core/errors.js';
import { isReadOnlyCapability } from '../src/protocol/capabilities.js';
import { ProviderRegistry } from '../src/core/provider-registry.js';

type Behavior = 'ok' | 'throw' | 'retryable';

class FakeProvider implements Provider {
  calls = 0;

  constructor(
    readonly id: string,
    readonly priority: number,
    private readonly target: ProviderTarget,
    private readonly behavior: Behavior = 'ok',
    private readonly latencyMs = 10,
    private readonly healthy = true,
  ) {}

  async health() {
    return { ok: this.healthy, latencyMs: this.latencyMs };
  }

  async listTargets() {
    return [this.target];
  }

  async execute(request: ProviderExecutionRequest): Promise<ExecutionResult> {
    this.calls++;
    if (this.behavior === 'throw') throw new Error('provider failed');
    if (this.behavior === 'retryable') {
      return {
        ok: false,
        error: {
          code: 'AGENT_DISCONNECTED',
          message: 'connection lost',
          retryable: true,
        },
        meta: {
          providerId: this.id,
          targetId: request.targetId,
          capability: request.capability,
          durationMs: 1,
        },
      };
    }
    return {
      ok: true,
      data: { provider: this.id },
      meta: {
        providerId: this.id,
        targetId: request.targetId,
        capability: request.capability,
        durationMs: 1,
      },
    };
  }
}

const target = (
  providerId: string,
  capabilities: string[] = ['shell.exec', 'files.read', 'files.write'],
): ProviderTarget => ({
  id: 'device-1',
  name: 'Device 1',
  providerId,
  online: true,
  capabilities,
});

test('registry picks the highest-priority capable provider', async () => {
  const registry = new ProviderRegistry();
  registry.register(new FakeProvider('slow', 10, target('slow')));
  registry.register(new FakeProvider('fast', 100, target('fast')));
  const result = await registry.execute({
    targetId: 'device-1',
    capability: 'files.read',
    input: {},
  });
  assert.equal(result.meta.providerId, 'fast');
});

test('registry uses health latency as a tie-breaker', async () => {
  const registry = new ProviderRegistry();
  registry.register(new FakeProvider('higher-latency', 100, target('higher-latency'), 'ok', 80));
  registry.register(new FakeProvider('lower-latency', 100, target('lower-latency'), 'ok', 5));
  const result = await registry.execute({
    targetId: 'device-1',
    capability: 'files.read',
    input: {},
  });
  assert.equal(result.meta.providerId, 'lower-latency');
});

test('registry fails over read-only requests after provider exception', async () => {
  const registry = new ProviderRegistry();
  registry.register(new FakeProvider('primary', 100, target('primary'), 'throw'));
  registry.register(new FakeProvider('secondary', 10, target('secondary')));
  const result = await registry.execute({
    targetId: 'device-1',
    capability: 'files.read',
    input: {},
  });
  assert.equal(result.meta.providerId, 'secondary');
});

test('registry fails over read-only requests after retryable provider result', async () => {
  const registry = new ProviderRegistry();
  registry.register(new FakeProvider('primary', 100, target('primary'), 'retryable'));
  registry.register(new FakeProvider('secondary', 10, target('secondary')));
  const result = await registry.execute({
    targetId: 'device-1',
    capability: 'files.read',
    input: {},
  });
  assert.equal(result.meta.providerId, 'secondary');
});

test('registry never auto-replays mutation after an ambiguous exception', async () => {
  const registry = new ProviderRegistry();
  const primary = new FakeProvider('primary', 100, target('primary'), 'throw');
  const secondary = new FakeProvider('secondary', 10, target('secondary'));
  registry.register(primary);
  registry.register(secondary);

  await assert.rejects(
    () =>
      registry.execute({
        targetId: 'device-1',
        capability: 'shell.exec',
        input: { command: 'do something' },
      }),
    (error: unknown) =>
      error instanceof NexowireError && error.code === 'MUTATION_STATE_UNKNOWN',
  );
  assert.equal(primary.calls, 1);
  assert.equal(secondary.calls, 0);
});

test('registry skips unhealthy provider before mutation execution begins', async () => {
  const registry = new ProviderRegistry();
  const primary = new FakeProvider('primary', 100, target('primary'), 'ok', 1, false);
  const secondary = new FakeProvider('secondary', 10, target('secondary'));
  registry.register(primary);
  registry.register(secondary);

  const result = await registry.execute({
    targetId: 'device-1',
    capability: 'shell.exec',
    input: { command: 'safe because primary never receives it' },
  });
  assert.equal(result.meta.providerId, 'secondary');
  assert.equal(primary.calls, 0);
  assert.equal(secondary.calls, 1);
});


test('registry never auto-replays mutation after retryable transport failure', async () => {
  const registry = new ProviderRegistry();
  const primary = new FakeProvider('primary', 100, target('primary'), 'retryable');
  const secondary = new FakeProvider('secondary', 10, target('secondary'));
  registry.register(primary);
  registry.register(secondary);

  await assert.rejects(
    () =>
      registry.execute({
        targetId: 'device-1',
        capability: 'files.write',
        input: { path: 'x', content: 'y' },
      }),
    (error: unknown) =>
      error instanceof NexowireError && error.code === 'MUTATION_STATE_UNKNOWN',
  );
  assert.equal(primary.calls, 1);
  assert.equal(secondary.calls, 0);
});


test('mutation capabilities are never classified as read-only', () => {
  const mutations = [
    'shell.exec',
    'process.start',
    'process.write',
    'process.stop',
    'process.prune',
    'files.write',
    'files.mkdir',
    'files.copy',
    'files.move',
    'files.delete',
    'files.patch',
    'workspace.checks',
    'task.graph.run',
    'task.graph.prune',
    'windows.service.control',
    'windows.registry.set',
    'windows.registry.delete',
    'windows.task.control',
    'windows.firewall.control',
    'windows.environment.set',
    'windows.environment.delete',
    'windows.window.focus',
    'windows.clipboard.write',
    'windows.clipboard.clear',
    'windows.keyboard.type',
    'windows.keyboard.hotkey',
  ];

  for (const capability of mutations) {
    assert.equal(
      isReadOnlyCapability(capability),
      false,
      capability + ' must not be auto-replayed as a read-only operation',
    );
  }
});
