import { bearerFromHeader } from '../security/tokens.js';
import type { CredentialRole } from '../security/credential-store.js';

export interface RemoteMcpAuthorization {
  accountId: string;
  role: CredentialRole;
  allowedDeviceIds: string[];
  deviceAccessModes: Record<string, 'safe' | 'full'>;
  autoSelectDevices: boolean;
  ownerDevices: Array<{id: string; name: string; folderId: string | null}>;
  ownerFolders: Array<{id: string; name: string}>;
}

export interface RemoteMcpUsageDecision {
  status: 'charged' | 'duplicate' | 'denied';
  chargedCredits: number;
  remainingCredits: number | null;
  reason:
    | 'feature-not-in-plan'
    | 'quota-exhausted'
    | null;
}

export interface ControlPlaneMcpClientOptions {
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

function boundedTimeout(value: number | undefined): number {
  const timeoutMs = value ?? 3_000;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 250 ||
    timeoutMs > 10_000
  ) {
    throw new Error(
      'Control-plane MCP timeout must be between 250 and 10000 ms.',
    );
  }
  return timeoutMs;
}

export class ControlPlaneMcpClient {
  private readonly base: string;
  private readonly serviceToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ControlPlaneMcpClientOptions) {
    this.base = normalizeControlPlaneBase(
      options.controlPlaneUrl,
    );
    this.serviceToken = validateServiceToken(
      options.serviceToken,
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = boundedTimeout(options.timeoutMs);
  }

  async authenticate(
    authorizationHeader: string | undefined,
  ): Promise<RemoteMcpAuthorization | undefined> {
    const token = bearerFromHeader(
      authorizationHeader,
    );
    if (
      !token ||
      !token.startsWith('nwx_mcp_') ||
      token.length > 512
    ) {
      return undefined;
    }

    const body = await this.post(
      '/api/v1/internal/mcp/authenticate',
      { accessToken: token },
    );
    if (
      body.authenticated !== true ||
      typeof body.accountId !== 'string' ||
      !body.accountId.trim() ||
      !['user', 'operator', 'admin'].includes(
        String(body.role),
      ) ||
      !Array.isArray(body.allowedDeviceIds) ||
      body.allowedDeviceIds.some(
        (value) =>
          typeof value !== 'string' ||
          !value.trim() ||
          value.length > 128,
      )
    ) {
      return undefined;
    }

    const allowedDeviceIds = [
      ...new Set(
        (body.allowedDeviceIds as string[]).map(
          (value) => value.trim(),
        ),
      ),
    ];
    const rawModes =
      typeof body.deviceAccessModes === 'object' &&
      body.deviceAccessModes !== null &&
      !Array.isArray(body.deviceAccessModes)
        ? body.deviceAccessModes as Record<string, unknown>
        : {};
    const deviceAccessModes: Record<string, 'safe' | 'full'> = {};
    for (const deviceId of allowedDeviceIds) {
      deviceAccessModes[deviceId] =
        rawModes[deviceId] === 'full' ? 'full' : 'safe';
    }

    const allowed = new Set(allowedDeviceIds);
    const validText = (value: unknown): value is string =>
      typeof value === 'string' && value.trim().length > 0 &&
      value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
    const rawDevices = Array.isArray(body.ownerDevices) ? body.ownerDevices : [];
    const ownerDevices: Array<{id:string;name:string;folderId:string|null}> = [];
    const seenDeviceIds = new Set<string>();
    for (const value of rawDevices) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const item = value as Record<string, unknown>;
      if (!validText(item.id) || !allowed.has(item.id) ||
          !validText(item.name) || seenDeviceIds.has(item.id) ||
          !(item.folderId === null || validText(item.folderId))) continue;
      seenDeviceIds.add(item.id);
      ownerDevices.push({id:item.id,name:item.name,folderId:item.folderId as string|null});
    }
    const rawFolders = Array.isArray(body.ownerFolders) ? body.ownerFolders : [];
    const ownerFolders: Array<{id:string;name:string}> = [];
    const seenFolderIds = new Set<string>();
    for (const value of rawFolders) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const item = value as Record<string, unknown>;
      if (!validText(item.id) || !validText(item.name) || seenFolderIds.has(item.id)) continue;
      seenFolderIds.add(item.id);
      ownerFolders.push({id:item.id,name:item.name});
    }
    return {
      accountId: body.accountId.trim(),
      role: body.role as CredentialRole,
      allowedDeviceIds,
      deviceAccessModes,
      autoSelectDevices: body.autoSelectDevices === true,
      ownerDevices,
      ownerFolders,
    };
  }

  async chargeTool(input: {
    accountId: string;
    eventId: string;
    toolName: string;
    specialSkill?: boolean;
  }): Promise<RemoteMcpUsageDecision | undefined> {
    const body = await this.post(
      '/api/v1/internal/usage/charge',
      {
        accountId: input.accountId,
        eventId: input.eventId,
        toolName: input.toolName,
        ...(input.specialSkill === true ? { specialSkill: true } : {}),
      },
    );

    if (
      !['charged', 'duplicate', 'denied'].includes(
        String(body.status),
      )
    ) {
      return undefined;
    }

    const reason =
      body.reason === null ||
      body.reason === 'feature-not-in-plan' ||
      body.reason === 'quota-exhausted'
        ? body.reason
        : null;

    return {
      status:
        body.status as RemoteMcpUsageDecision['status'],
      chargedCredits:
        typeof body.chargedCredits === 'number'
          ? body.chargedCredits
          : 0,
      remainingCredits:
        typeof body.remainingCredits === 'number'
          ? body.remainingCredits
          : null,
      reason,
    };
  }

  private async post(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.timeoutMs,
    );
    timer.unref?.();

    try {
      const response = await this.fetchImpl(
        this.base + path,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization:
              'Bearer ' + this.serviceToken,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
      );
      if (!response.ok) return {};
      const value = await response.json();
      return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value)
      )
        ? value as Record<string, unknown>
        : {};
    } catch {
      return {};
    } finally {
      clearTimeout(timer);
    }
  }
}
