import type {
  Provider,
  ProviderExecutionRequest,
  ProviderTarget,
} from '../protocol/provider.js';
import { isReadOnlyCapability } from '../protocol/capabilities.js';
import type { ExecutionResult } from '../protocol/result.js';
import {
  CapabilityUnavailableError,
  NexowireError,
  TargetNotFoundError,
} from './errors.js';

interface Candidate {
  provider: Provider;
  target: ProviderTarget;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();

  register(provider: Provider): void {
    if (this.providers.has(provider.id)) {
      throw new NexowireError(
        'PROVIDER_EXISTS',
        `Provider "${provider.id}" is already registered.`,
      );
    }
    this.providers.set(provider.id, provider);
  }

  unregister(providerId: string): boolean {
    return this.providers.delete(providerId);
  }

  get(providerId: string): Provider | undefined {
    return this.providers.get(providerId);
  }

  listProviders(): Provider[] {
    return [...this.providers.values()].sort(
      (a, b) => b.priority - a.priority || a.id.localeCompare(b.id),
    );
  }

  async listTargets(): Promise<ProviderTarget[]> {
    const results = await Promise.allSettled(
      this.listProviders().map((provider) => provider.listTargets()),
    );

    return results.flatMap((result) =>
      result.status === 'fulfilled' ? result.value : [],
    );
  }

  async execute(
    request: ProviderExecutionRequest,
    preferredProviderId?: string,
  ): Promise<ExecutionResult> {
    const candidates = await this.findCandidates(
      request.targetId,
      request.capability,
      preferredProviderId,
    );

    if (candidates.length === 0) {
      const targets = await this.listTargets();
      const matchingTarget = targets.find(
        (target) => target.id === request.targetId && target.online,
      );

      if (!matchingTarget) {
        throw new TargetNotFoundError(request.targetId);
      }
      throw new CapabilityUnavailableError(
        request.targetId,
        request.capability,
      );
    }

    const healthResults = await Promise.allSettled(
      candidates.map(async (candidate) => ({
        candidate,
        health: await candidate.provider.health(),
      })),
    );
    const healthyCandidates = healthResults
      .flatMap((result) =>
        result.status === 'fulfilled' && result.value.health.ok
          ? [result.value]
          : [],
      )
      .sort(
        (a, b) =>
          b.candidate.provider.priority - a.candidate.provider.priority ||
          (a.health.latencyMs ?? Number.POSITIVE_INFINITY) -
            (b.health.latencyMs ?? Number.POSITIVE_INFINITY) ||
          a.candidate.provider.id.localeCompare(b.candidate.provider.id),
      );

    if (healthyCandidates.length === 0) {
      throw new NexowireError(
        'PROVIDER_UNHEALTHY',
        `No healthy provider is available for target "${request.targetId}".`,
      );
    }

    const readOnly = isReadOnlyCapability(request.capability);
    let lastError: unknown;

    for (const { candidate } of healthyCandidates) {
      try {
        const result = await candidate.provider.execute(request);
        if (result.ok) return result;

        if (result.error?.retryable) {
          if (!readOnly) {
            throw new NexowireError(
              'MUTATION_STATE_UNKNOWN',
              `Provider "${candidate.provider.id}" lost confirmation while executing mutation "${request.capability}". Nexowire will not replay it automatically.`,
              {
                providerId: candidate.provider.id,
                targetId: request.targetId,
                capability: request.capability,
                providerError: result.error,
              },
            );
          }
          lastError = result.error;
          continue;
        }

        return result;
      } catch (error) {
        if (!readOnly) {
          if (
            error instanceof NexowireError &&
            error.code === 'MUTATION_STATE_UNKNOWN'
          ) {
            throw error;
          }
          throw new NexowireError(
            'MUTATION_STATE_UNKNOWN',
            `Provider "${candidate.provider.id}" failed after mutation execution began. Nexowire will not replay "${request.capability}" automatically.`,
            {
              providerId: candidate.provider.id,
              targetId: request.targetId,
              capability: request.capability,
              cause: error,
            },
          );
        }
        lastError = error;
      }
    }

    throw new NexowireError(
      'PROVIDER_EXECUTION_FAILED',
      `All healthy providers failed for target "${request.targetId}".`,
      lastError,
    );
  }

  private async findCandidates(
    targetId: string,
    capability: string,
    preferredProviderId?: string,
  ): Promise<Candidate[]> {
    const providers = preferredProviderId
      ? [this.providers.get(preferredProviderId)].filter(
          (provider): provider is Provider => provider !== undefined,
        )
      : this.listProviders();

    const targetSets = await Promise.allSettled(
      providers.map(async (provider) => ({
        provider,
        targets: await provider.listTargets(),
      })),
    );

    return targetSets
      .flatMap((result) =>
        result.status === 'fulfilled'
          ? result.value.targets
              .filter(
                (target) =>
                  target.online &&
                  target.id === targetId &&
                  target.capabilities.includes(capability),
              )
              .map((target) => ({
                provider: result.value.provider,
                target,
              }))
          : [],
      )
      .sort(
        (a, b) =>
          b.provider.priority - a.provider.priority ||
          a.provider.id.localeCompare(b.provider.id),
      );
  }
}
