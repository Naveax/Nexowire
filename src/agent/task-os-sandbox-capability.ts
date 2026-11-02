/**
 * #07 owner-only fail-closed adapter for future #03 dispatch integration.
 *
 * NOT integrated into the current Agent dispatcher. The existing runProcess
 * path still uses raw spawn. The adapter is a denied execution entry point,
 * not an OS sandbox, a native attestation verifier, or a permit.
 * Neither raw command input nor callbacks are inspected or retained.
 */
import {
  OsTaskSandboxBlockedError,
  prepareTaskSandboxWorker,
  type SandboxWorkerLaunchBlueprint,
} from './task-os-sandbox-worker.js';

export const SANDBOX_REQUIRED_EFFECT_CAPABILITIES = Object.freeze([
  'shell.exec',
  'wsl.exec',
  'process.start',
  'task.graph.run',
  'runbook.run',
  'workspace.checks',
  'workspace.snapshot',
] as const);

export type SandboxRequiredEffectCapability =
  typeof SANDBOX_REQUIRED_EFFECT_CAPABILITIES[number];

const KNOWN_EFFECTS: ReadonlySet<string> =
  new Set<string>(SANDBOX_REQUIRED_EFFECT_CAPABILITIES);

export interface SandboxCapabilityRouteDecision {
  readonly schema: 1;
  readonly capability: SandboxRequiredEffectCapability | 'unknown-effect';
  readonly state: 'BLOCKED' | 'RECONCILE_REQUIRED';
  readonly trustedNativeProviderInstalled: false;
  readonly runtimeIntegratedIntoAgentDispatch: false;
  readonly launchAllowed: false;
  readonly mayFallbackToLegacySpawn: false;
  readonly canRetryAfterUnknown: false;
  readonly workerProof: SandboxWorkerLaunchBlueprint;
}

/** Never touch command input, which may contain secrets and hostile getters. */
export function prepareSandboxRequiredCapability(
  capability: unknown,
  _commandInput: unknown,
  sourceOnlyTaskIntent: unknown,
  untrustedReadback?: unknown,
): SandboxCapabilityRouteDecision {
  const known = typeof capability === 'string' && KNOWN_EFFECTS.has(capability);
  const workerProof = prepareTaskSandboxWorker(sourceOnlyTaskIntent, untrustedReadback);
  return Object.freeze({
    schema: 1 as const,
    capability: (known ? capability : 'unknown-effect') as
      SandboxRequiredEffectCapability | 'unknown-effect',
    state: workerProof.status,
    trustedNativeProviderInstalled: false as const,
    runtimeIntegratedIntoAgentDispatch: false as const,
    launchAllowed: false as const,
    mayFallbackToLegacySpawn: false as const,
    canRetryAfterUnknown: false as const,
    workerProof,
  });
}

/**
 * Call signature for a future #03 guarded dispatcher. Denies every request
 * before command evaluation. No injected provider or fallback can run.
 */
export async function executeSandboxRequiredCapability(
  capability: unknown,
  commandInput: unknown,
  sourceOnlyTaskIntent: unknown,
  untrustedReadback?: unknown,
): Promise<never> {
  const decision = prepareSandboxRequiredCapability(
    capability, commandInput, sourceOnlyTaskIntent, untrustedReadback,
  );
  throw new OsTaskSandboxBlockedError(decision.workerProof);
}
