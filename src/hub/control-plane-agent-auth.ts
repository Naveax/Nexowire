import { bearerFromHeader } from '../security/tokens.js';
import {normalizeControlPlaneBase,controlPlaneSecretPost} from './control-plane-network-policy.js';

export interface RemoteAgentAuthorization {
  deviceId: string;
  /** Authoritative fields required for strict public Agent admission. */
  ownerId?: string;
  authorizationEpoch?: number;
  leaseExpiresAtMs?: number;
}

export interface ControlPlaneAgentVerifierOptions {
  controlPlaneUrl: string;
  serviceToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
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
  signal?: AbortSignal,
) => Promise<RemoteAgentAuthorization | undefined> {
  const base = normalizeControlPlaneBase(
    options.controlPlaneUrl,
  );
  const serviceToken = validateServiceToken(
    options.serviceToken,
  );
  const fetchImpl = options.fetchImpl;
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
    signal?: AbortSignal,
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
      const response = await controlPlaneSecretPost(
        base + '/api/v1/internal/device/authenticate',
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: 'Bearer ' + serviceToken,
          },
          body: JSON.stringify({ credential }),
          signal: signal ? AbortSignal.any([signal,controller.signal]) : controller.signal,
          redirect: 'error',
        },
      fetchImpl,
      );

      if (!response.ok) return undefined;
      const body = await response.json() as {
        authenticated?: boolean;
        device?: {
          deviceId?: string;
          ownerId?: unknown;
          ownerAccountId?: unknown;
          authorizationEpoch?: unknown;
          leaseExpiresAtMs?: unknown;
        };
      };
      const deviceId = body.device?.deviceId;
      if (
        body.authenticated !== true ||
        typeof deviceId !== 'string' ||
        !deviceId.trim() ||
        deviceId!==deviceId.trim() ||
        /[\u0000-\u001f\u007f]/.test(deviceId) ||
        deviceId.length > 128
      ) {
        return undefined;
      }

      // Legacy control planes only attest deviceId (and perhaps owner).
      // That response remains device-only, and strict remote-only admission
      // must reject it. Never fabricate an epoch or a revocation lease.
      const suppliedOwnerId = body.device?.ownerId;
      const accountId = body.device?.ownerAccountId;
      if (suppliedOwnerId !== undefined && accountId !== undefined &&
          suppliedOwnerId !== accountId) return undefined;
      const ownerId = suppliedOwnerId ?? accountId;
      const epoch = body.device?.authorizationEpoch;
      const lease = body.device?.leaseExpiresAtMs;
      if (epoch === undefined && lease === undefined)
        return { deviceId: deviceId.trim() };
      const now = Date.now();
      if (typeof ownerId !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._:@-]{1,127}$/.test(ownerId) ||
          !Number.isSafeInteger(epoch) || (epoch as number) < 0 ||
          !Number.isSafeInteger(lease) || (lease as number) <= now ||
          (lease as number) > now + 300_000) return undefined;
      return {
        deviceId: deviceId.trim(),
        ownerId,
        authorizationEpoch: epoch as number,
        leaseExpiresAtMs: lease as number,
      };
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface RemoteAgentPresence {
  deviceId: string;
  online: boolean;
  at: string;
  agentVersion?: string;
  privilegeMode?: 'direct' | 'broker';
  adminBridgeReady?: boolean;
}

export function createControlPlaneAgentPresenceReporter(
  options: ControlPlaneAgentVerifierOptions,
): (presence: RemoteAgentPresence) => Promise<boolean> {
  const base = normalizeControlPlaneBase(
    options.controlPlaneUrl,
  );
  const serviceToken = validateServiceToken(
    options.serviceToken,
  );
  const fetchImpl = options.fetchImpl;
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
    presence: RemoteAgentPresence,
  ): Promise<boolean> => {
    const deviceId = presence.deviceId.trim();
    const atMs = Date.parse(presence.at);
    if (
      !deviceId ||
      deviceId.length > 128 ||
      deviceId!==presence.deviceId ||
      /[\u0000-\u001f\u007f]/.test(deviceId) ||
      !Number.isFinite(atMs)
    ) {
      return false;
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      timeoutMs,
    );
    timer.unref?.();

    try {
      const response = await controlPlaneSecretPost(
        base + '/api/v1/internal/device/presence',
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: 'Bearer ' + serviceToken,
          },
          body: JSON.stringify({
            deviceId,
            online: presence.online,
            at: new Date(atMs).toISOString(),
            ...(presence.agentVersion !== undefined
              ? { agentVersion: presence.agentVersion }
              : {}),
            ...(presence.privilegeMode !== undefined
              ? { privilegeMode: presence.privilegeMode }
              : {}),
            ...(presence.adminBridgeReady !== undefined
              ? {
                  adminBridgeReady:
                    presence.adminBridgeReady,
                }
              : {}),
          }),
          signal: controller.signal,
          redirect: 'error',
        },
      fetchImpl,
      );
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}
