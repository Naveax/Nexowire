import type { Capability } from './capabilities.js';
import type { ExecutionResult } from './result.js';

export interface ProviderTarget {
  id: string;
  name: string;
  providerId: string;
  platform?: string;
  online: boolean;
  capabilities: string[];
  metadata?: Record<string, unknown>;
}

export interface ProviderHealth {
  ok: boolean;
  latencyMs?: number;
  message?: string;
}

export interface ProviderExecutionRequest {
  targetId: string;
  capability: Capability;
  input: unknown;
  timeoutMs?: number;
  requestId?: string;
}

export interface Provider {
  readonly id: string;
  readonly priority: number;
  health(): Promise<ProviderHealth>;
  listTargets(): Promise<ProviderTarget[]>;
  execute(request: ProviderExecutionRequest): Promise<ExecutionResult>;
}
