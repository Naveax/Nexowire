import { performance } from 'node:perf_hooks';
import type { AgentBroker } from '../core/agent-broker.js';
import type {
  Provider,
  ProviderExecutionRequest,
  ProviderHealth,
  ProviderTarget,
} from '../protocol/provider.js';
import type { ExecutionResult } from '../protocol/result.js';

interface AgentOperationResult {
  data?: unknown;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  truncated?: boolean;
}

export class AgentProvider implements Provider {
  readonly id = 'native-agent';
  readonly priority = 100;

  constructor(private readonly broker: AgentBroker) {}

  async health(): Promise<ProviderHealth> {
    return { ok: true };
  }

  async listTargets(): Promise<ProviderTarget[]> {
    return this.broker.list().map((agent) => ({
      id: agent.id,
      name: agent.name,
      providerId: this.id,
      platform: agent.platform,
      online: true,
      capabilities: agent.capabilities,
      metadata: {
        arch: agent.arch,
        agentVersion: agent.agentVersion,
        connectedAt: agent.connectedAt,
      },
    }));
  }

  async execute(
    request: ProviderExecutionRequest,
  ): Promise<ExecutionResult> {
    const started = performance.now();
    try {
      const raw = (await this.broker.request(
        request.targetId,
        request.capability,
        request.input,
        request.timeoutMs ?? 60_000,
        request.requestId,
      )) as AgentOperationResult | undefined;

      const result = raw ?? {};
      return {
        ok: true,
        ...(result.data !== undefined ? { data: result.data } : {}),
        ...(result.stdout !== undefined ? { stdout: result.stdout } : {}),
        ...(result.stderr !== undefined ? { stderr: result.stderr } : {}),
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
        meta: {
          providerId: this.id,
          targetId: request.targetId,
          capability: request.capability,
          durationMs: Math.round(performance.now() - started),
          ...(request.requestId ? { requestId: request.requestId } : {}),
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code:
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            typeof error.code === 'string'
              ? error.code
              : 'PROVIDER_ERROR',
          message: error instanceof Error ? error.message : String(error),
          retryable:
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            typeof error.code === 'string' &&
            ['AGENT_OFFLINE', 'AGENT_TIMEOUT', 'AGENT_DISCONNECTED'].includes(
              error.code,
            ),
        },
        meta: {
          providerId: this.id,
          targetId: request.targetId,
          capability: request.capability,
          durationMs: Math.round(performance.now() - started),
          ...(request.requestId ? { requestId: request.requestId } : {}),
        },
      };
    }
  }
}
