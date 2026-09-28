export class NexowireError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'NexowireError';
  }
}

export class TargetNotFoundError extends NexowireError {
  constructor(targetId: string) {
    super('TARGET_NOT_FOUND', `No online provider target matched "${targetId}".`);
  }
}

export class CapabilityUnavailableError extends NexowireError {
  constructor(targetId: string, capability: string) {
    super(
      'CAPABILITY_UNAVAILABLE',
      `Target "${targetId}" does not expose capability "${capability}".`,
    );
  }
}
