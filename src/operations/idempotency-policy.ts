export interface IdempotencyEligibility {
  eligible: boolean;
  reason?: string;
}

export function idempotencyEligibility(
  capability: string,
  input: unknown,
): IdempotencyEligibility {
  if (
    capability === 'files.mkdir' ||
    capability === 'files.patch' ||
    capability === 'windows.registry.set' ||
    capability === 'windows.registry.delete' ||
    capability === 'windows.environment.set' ||
    capability === 'windows.environment.delete'
  ) {
    return { eligible: true };
  }

  if (capability === 'files.write') {
    const mode =
      input &&
      typeof input === 'object' &&
      'mode' in input &&
      typeof (input as { mode?: unknown }).mode === 'string'
        ? (input as { mode: string }).mode
        : 'overwrite';

    if (mode === 'append') {
      return {
        eligible: false,
        reason:
          'Append writes are not replay-safe because repeating them can duplicate content.',
      };
    }
    return { eligible: true };
  }

  return {
    eligible: false,
    reason:
      'This capability is not in the explicit replay-safe idempotency allowlist.',
  };
}
