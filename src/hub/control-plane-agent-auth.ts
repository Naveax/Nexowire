import { bearerFromHeader } from '../security/tokens.js';

export interface RemoteAgentAuthorization {
  deviceId: string;
}

export interface ControlPlaneAgentVerifierOptions {
  controlPlaneUrl: string;
  serviceToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function normalizeControlPlaneBase(input: string): string {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Control-plane URL is invalid.');
  }

  const loopback =
    url.hostname === '127.0.0.1' ||
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1';

  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(loopback && url.protocol === 'http:'))
  ) {
    throw new Error(
      'Control-plane URL must use HTTPS except for loopback development.',
    );
  }

  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function validateServiceToken(input: string): string {
  const value = input.trim();
  if (
    value.length < 16 ||
    value.length > 4096 ||
    /[\r\n\0]/.test(value)
  ) {
    throw new Error('Control-plane service token is invalid.');
  }
  return value;
}

export function createControlPlaneAgentCredentialVerifier(
  options: ControlPlaneAgentVerifierOptions,
): (
  authorizationHeader: string | undefined,
) => Promise<RemoteAgentAuthorization | undefined> {
  const base = normalizeControlPlaneBase(
    options.controlPlaneUrl,
  );
  const serviceToken = validateServiceToken(
    options.serviceToken,
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3_000;

  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 250 ||
    timeoutMs > 10_000
  ) {
    throw new Error(
      'Control-plane agent verifier timeout must be between 250 and 10000 ms.',
    );
  }

  return async (
    authorizationHeader: string | undefined,
  ): Promise<RemoteAgentAuthorization | undefined> => {
    const credential = bearerFromHeader(
      authorizationHeader,
    );
    if (
      !credential ||
      !credential.startsWith('nwx_dev_') ||
      credential.length > 512
    ) {
      return undefined;
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      timeoutMs,
    );
    timer.unref?.();

    try {
      const response = await fetchImpl(
        base + '/api/v1/internal/device/authenticate',
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: 'Bearer ' + serviceToken,
          },
          body: JSON.stringify({ credential }),
          signal: controller.signal,
        },
      );

      if (!response.ok) return undefined;
      const body = await response.json() as {
        authenticated?: boolean;
        device?: {
          deviceId?: string;
        };
      };
      const deviceId = body.device?.deviceId;
      if (
        body.authenticated !== true ||
        typeof deviceId !== 'string' ||
        !deviceId.trim() ||
        deviceId.length > 128
      ) {
        return undefined;
      }

      return {
        deviceId: deviceId.trim(),
      };
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };
}
