import os from 'node:os';
import path from 'node:path';
import { isLoopbackHost } from '../config.js';
import { parseTokenList } from '../security/tokens.js';
import {
  optionalSecretFile,
  optionalSecretListFile,
} from '../security/secret-files.js';
import {
  optionalProtectedSecretFile,
  optionalProtectedSecretListFile,
  resolveProtectedSingleSecret,
} from '../security/protected-secret-files.js';
import {
  optionalPlatformSecretListSync,
  optionalPlatformSecretSync,
} from '../security/platform-secret-store.js';

export interface NexowireRelayConfig {
  host: string;
  port: number;
  upstreamWsUrl: string;
  inboundAgentTokens: string[];
  upstreamAgentToken?: string;
  tlsCertFile?: string;
  tlsKeyFile?: string;
  allowInsecureRemote?: boolean;
  allowInsecureUpstream?: boolean;
  heartbeatMs: number;
  maxPayloadBytes: number;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function envFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === '1' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'on'
  );
}

function parsePort(raw: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid NEXOWIRE_RELAY_PORT: ${raw}`);
  }
  return value;
}

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (!raw?.trim()) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

export interface RelaySecretResolvers {
  platformSingle?: (
    name: string | undefined,
    purpose: string,
  ) => string | undefined;
  platformList?: (
    name: string | undefined,
    purpose: string,
  ) => string | undefined;
}

export function loadRelayConfig(
  env: NodeJS.ProcessEnv = process.env,
  secretResolvers: RelaySecretResolvers = {},
): NexowireRelayConfig {
  const platformSingle =
    secretResolvers.platformSingle ??
    ((name: string | undefined, purpose: string) =>
      optionalPlatformSecretSync(name, purpose));
  const platformList =
    secretResolvers.platformList ??
    ((name: string | undefined, purpose: string) =>
      optionalPlatformSecretListSync(name, purpose));
  const tlsCertFile = optional(env.NEXOWIRE_RELAY_TLS_CERT_FILE);
  const tlsKeyFile = optional(env.NEXOWIRE_RELAY_TLS_KEY_FILE);
  if (Boolean(tlsCertFile) !== Boolean(tlsKeyFile)) {
    throw new Error(
      'NEXOWIRE_RELAY_TLS_CERT_FILE and NEXOWIRE_RELAY_TLS_KEY_FILE must be configured together.',
    );
  }

  const upstreamWsUrl =
    optional(env.NEXOWIRE_RELAY_UPSTREAM_WS_URL) ??
    'ws://127.0.0.1:43110/agent';

  let parsed: URL;
  try {
    parsed = new URL(upstreamWsUrl);
  } catch {
    throw new Error(
      `Invalid NEXOWIRE_RELAY_UPSTREAM_WS_URL: ${upstreamWsUrl}`,
    );
  }
  if (!['ws:', 'wss:'].includes(parsed.protocol)) {
    throw new Error(
      'NEXOWIRE_RELAY_UPSTREAM_WS_URL must use ws:// or wss://.',
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      'NEXOWIRE_RELAY_UPSTREAM_WS_URL must not embed credentials.',
    );
  }
  if (parsed.hash) {
    throw new Error(
      'NEXOWIRE_RELAY_UPSTREAM_WS_URL must not contain a fragment.',
    );
  }

  const upstreamPlatformToken = platformSingle(
    env.NEXOWIRE_RELAY_UPSTREAM_AGENT_TOKEN_PLATFORM_NAME,
    'relay-upstream-agent-token',
  );
  const upstreamAgentToken = resolveProtectedSingleSecret(
    env.NEXOWIRE_RELAY_UPSTREAM_AGENT_TOKEN,
    env.NEXOWIRE_RELAY_UPSTREAM_AGENT_TOKEN_FILE,
    env.NEXOWIRE_RELAY_UPSTREAM_AGENT_TOKEN_DPAPI_FILE,
    'relay-upstream-agent-token',
    'relay upstream agent token',
    upstreamPlatformToken,
  );

  return {
    host: optional(env.NEXOWIRE_RELAY_HOST) ?? '127.0.0.1',
    port: parsePort(env.NEXOWIRE_RELAY_PORT ?? '43111'),
    upstreamWsUrl: parsed.toString(),
    inboundAgentTokens: parseTokenList(
      env.NEXOWIRE_RELAY_AGENT_TOKEN,
      optionalSecretFile(
        env.NEXOWIRE_RELAY_AGENT_TOKEN_FILE,
        'relay inbound agent token',
      ),
      optionalProtectedSecretFile(
        env.NEXOWIRE_RELAY_AGENT_TOKEN_DPAPI_FILE,
        'relay-inbound-agent-token',
        'relay inbound agent token',
      ),
      platformSingle(
        env.NEXOWIRE_RELAY_AGENT_TOKEN_PLATFORM_NAME,
        'relay-inbound-agent-token',
      ),
      env.NEXOWIRE_RELAY_AGENT_TOKENS,
      optionalSecretListFile(
        env.NEXOWIRE_RELAY_AGENT_TOKENS_FILE,
        'relay inbound agent token list',
      ),
      optionalProtectedSecretListFile(
        env.NEXOWIRE_RELAY_AGENT_TOKENS_DPAPI_FILE,
        'relay-inbound-agent-token-list',
        'relay inbound agent token list',
      ),
      platformList(
        env.NEXOWIRE_RELAY_AGENT_TOKENS_PLATFORM_NAME,
        'relay-inbound-agent-token-list',
      ),
    ),
    ...(upstreamAgentToken ? { upstreamAgentToken } : {}),
    ...(tlsCertFile ? { tlsCertFile } : {}),
    ...(tlsKeyFile ? { tlsKeyFile } : {}),
    ...(envFlag(env.NEXOWIRE_RELAY_ALLOW_INSECURE_REMOTE)
      ? { allowInsecureRemote: true }
      : {}),
    ...(envFlag(env.NEXOWIRE_RELAY_ALLOW_INSECURE_UPSTREAM)
      ? { allowInsecureUpstream: true }
      : {}),
    heartbeatMs: parseBoundedInt(
      env.NEXOWIRE_RELAY_HEARTBEAT_MS,
      30_000,
      1_000,
      120_000,
      'NEXOWIRE_RELAY_HEARTBEAT_MS',
    ),
    maxPayloadBytes: parseBoundedInt(
      env.NEXOWIRE_RELAY_MAX_PAYLOAD_BYTES,
      16 * 1024 * 1024,
      64 * 1024,
      64 * 1024 * 1024,
      'NEXOWIRE_RELAY_MAX_PAYLOAD_BYTES',
    ),
  };
}

export function relayHasTls(config: NexowireRelayConfig): boolean {
  return Boolean(config.tlsCertFile && config.tlsKeyFile);
}

function isLoopbackUrl(url: URL): boolean {
  return isLoopbackHost(url.hostname);
}

export function assertSafeRelayConfig(
  config: NexowireRelayConfig,
): void {
  if (!isLoopbackHost(config.host)) {
    if (config.inboundAgentTokens.length === 0) {
      throw new Error(
        'Refusing non-loopback relay bind without inbound agent bearer credentials.',
      );
    }
    if (!relayHasTls(config) && !config.allowInsecureRemote) {
      throw new Error(
        'Refusing non-loopback plaintext relay transport. Configure relay TLS or explicitly allow an insecure trusted-network bind.',
      );
    }
  }

  const upstream = new URL(config.upstreamWsUrl);
  if (
    upstream.protocol === 'ws:' &&
    !isLoopbackUrl(upstream) &&
    !config.allowInsecureUpstream
  ) {
    throw new Error(
      'Refusing plaintext non-loopback relay upstream. Use wss:// or explicitly allow an insecure trusted-network upstream.',
    );
  }

  if (
    !isLoopbackUrl(upstream) &&
    !config.upstreamAgentToken
  ) {
    throw new Error(
      'A non-loopback relay upstream requires NEXOWIRE_RELAY_UPSTREAM_AGENT_TOKEN.',
    );
  }
}
