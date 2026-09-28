import type {
  Provider,
  ProviderExecutionRequest,
  ProviderTarget,
} from '../protocol/provider.js';
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

    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        const health = await candidate.provider.health();
        if (!health.ok) continue;
        return await candidate.provider.execute(request);
      } catch (error) {
        lastError = error;
      }
    }

    throw new NexowireError(
      'PROVIDER_EXECUTION_FAILED',
      `All providers failed for target "${request.targetId}".`,
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
