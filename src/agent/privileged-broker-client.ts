import { privilegeRequirement } from '../security/privilege.js';

export class PrivilegedBrokerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PrivilegedBrokerError';
  }
}

export interface PrivilegedBrokerClientOptions {
  url: string;
  token: string;
  timeoutMs?: number;
}

export class PrivilegedBrokerClient {
  private readonly url: URL;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: PrivilegedBrokerClientOptions) {
    this.url = new URL(options.url);
    if (
      this.url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(
        this.url.hostname.toLowerCase(),
      )
    ) {
      throw new Error(
        'Privileged broker client requires a loopback http:// URL.',
      );
    }
    this.token = options.token.trim();
    if (!this.token) {
      throw new Error('Privileged broker token is required.');
    }
    this.timeoutMs = Math.min(
      120_000,
      Math.max(1_000, options.timeoutMs ?? 60_000),
    );
  }

  async probe(): Promise<{
    reachable: boolean;
    elevated: boolean;
  }> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(this.timeoutMs, 5_000),
    );
    try {
      const response = await fetch(
        new URL('/health', this.url),
        {
          method: 'GET',
          headers: {
            authorization: 'Bearer ' + this.token,
          },
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        return {
          reachable: false,
          elevated: false,
        };
      }
      const body = await response.json() as {
        ok?: boolean;
        elevated?: boolean;
      };
      return {
        reachable: body.ok === true,
        elevated:
          body.ok === true &&
          body.elevated === true,
      };
    } catch {
      return {
        reachable: false,
        elevated: false,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async execute(
    capability: string,
    input: unknown,
  ): Promise<unknown> {
    if (privilegeRequirement(capability, input) !== 'elevated') {
      throw new PrivilegedBrokerError(
        'PRIVILEGED_BROKER_NOT_REQUIRED',
        'The requested operation does not require the privileged broker.',
        { capability },
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.timeoutMs,
    );

    try {
      const response = await fetch(
        new URL('/execute', this.url),
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + this.token,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ capability, input }),
          signal: controller.signal,
        },
      );

      const body = (await response.json()) as {
        ok?: boolean;
        data?: unknown;
        error?: {
          code?: string;
          message?: string;
          details?: unknown;
        };
      };

      if (!response.ok || !body.ok) {
        throw new PrivilegedBrokerError(
          body.error?.code ?? 'PRIVILEGED_BROKER_FAILED',
          body.error?.message ??
            `Privileged broker returned HTTP ${response.status}.`,
          body.error?.details,
        );
      }

      return body.data;
    } catch (error) {
      if (error instanceof PrivilegedBrokerError) throw error;
      if (
        error instanceof Error &&
        (error.name === 'AbortError' ||
          controller.signal.aborted)
      ) {
        throw new PrivilegedBrokerError(
          'PRIVILEGED_BROKER_TIMEOUT',
          'Privileged broker request timed out.',
        );
      }
      throw new PrivilegedBrokerError(
        'PRIVILEGED_BROKER_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
