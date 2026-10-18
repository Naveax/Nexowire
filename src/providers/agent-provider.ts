import { performance } from 'node:perf_hooks';
import { classifyFailure, redactDiagnosticText } from '../protocol/error-contract-v2.js';
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
        request.accessMode ?? 'safe',
      )) as AgentOperationResult | undefined;

      const result = raw ?? {};
      const isShell = request.capability === 'shell.exec' ||
        request.capability === 'wsl.exec';
      const timedOut = typeof result.data === 'object' &&
        result.data !== null && !Array.isArray(result.data) &&
        (result.data as {timedOut?:unknown}).timedOut === true;
      const taskStatus = timedOut ? 'timed_out' :
        typeof result.exitCode === 'number' && Number.isInteger(result.exitCode)
          ? result.exitCode === 0 ? 'succeeded' : 'failed'
          : 'unknown';
      return {
        ok: true,
        ...(isShell && taskStatus !== 'succeeded' ? {
          diagnostic: classifyFailure({
            code: taskStatus === 'failed' ? 'SHELL_EXIT_NONZERO' :
              taskStatus === 'timed_out' ? 'SHELL_TASK_TIMED_OUT' : 'SHELL_TASK_OUTCOME_UNKNOWN',
            observedAt: 'native_agent', dispatched: true,
            ...(request.requestId ? {operationId: request.requestId, correlationId: request.requestId} : {}),
          }),
        } : {}),
        ...(isShell ? {
          taskStatus,
          taskSuccess: taskStatus === 'succeeded' ? true :
            taskStatus === 'unknown' ? null : false,
        } : {}),
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
      const rawCode = typeof error === 'object' && error !== null &&
        'code' in error && typeof error.code === 'string'
          ? error.code : 'PROVIDER_ERROR';
      const diagnosticCode = rawCode === 'PROVIDER_ERROR' &&
        error instanceof Error && error.name === 'AuthRequiredError'
          ? 'AuthRequiredError' : rawCode;
      const attribution = classifyFailure({
        code: diagnosticCode, observedAt: 'native_agent', dispatched: 'unknown',
        ...(request.requestId ? {operationId: request.requestId, correlationId: request.requestId} : {}),
      });
      return {
        ok: false,
        error: {
          attribution,
          code: rawCode === 'PROVIDER_ERROR' ? 'PROVIDER_ERROR' : attribution.code,
          message: redactDiagnosticText(error instanceof Error ? error.message : String(error)),
          retryable:
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            typeof error.code === 'string' &&
            [
              'AGENT_OFFLINE',
              'AGENT_TIMEOUT',
              'AGENT_DISCONNECTED',
              'AGENT_RECONNECT_TIMEOUT',
              'AGENT_INSTANCE_CHANGED',
              'AGENT_CAPABILITY_CHANGED',
            ].includes(error.code),
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
