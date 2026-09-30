import os from 'node:os';
import path from 'node:path';
import { parseTokenList } from './security/tokens.js';

export interface NexowireConfig {
  host: string;
  port: number;
  mcpBearerToken?: string;
  mcpBearerTokens?: string[];
  agentToken?: string;
  agentTokens?: string[];
  tlsCertFile?: string;
  tlsKeyFile?: string;
  allowInsecureRemote?: boolean;
  relayUrl?: string;
  relayToken?: string;
  stateDir: string;
  skillsDir: string;
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

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}

export function mcpAuthTokens(config: NexowireConfig): string[] {
  return parseTokenList(
    config.mcpBearerToken,
    config.mcpBearerTokens?.join(','),
  );
}

export function agentAuthTokens(config: NexowireConfig): string[] {
  return parseTokenList(
    config.agentToken,
    config.agentTokens?.join(','),
  );
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): NexowireConfig {
  const rawPort = env.NEXOWIRE_HTTP_PORT ?? '43110';
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid NEXOWIRE_HTTP_PORT: ${rawPort}`);
  }

  const stateDir =
    optional(env.NEXOWIRE_STATE_DIR) ??
    path.join(os.homedir(), '.nexowire', 'hub');

  const legacyMcpToken = optional(env.NEXOWIRE_MCP_BEARER_TOKEN);
  const legacyAgentToken = optional(env.NEXOWIRE_AGENT_TOKEN);
  const mcpBearerTokens = parseTokenList(
    legacyMcpToken,
    env.NEXOWIRE_MCP_BEARER_TOKENS,
  );
  const agentTokens = parseTokenList(
    legacyAgentToken,
    env.NEXOWIRE_AGENT_TOKENS,
  );

  const tlsCertFile = optional(env.NEXOWIRE_TLS_CERT_FILE);
  const tlsKeyFile = optional(env.NEXOWIRE_TLS_KEY_FILE);
  if (Boolean(tlsCertFile) !== Boolean(tlsKeyFile)) {
    throw new Error(
      'NEXOWIRE_TLS_CERT_FILE and NEXOWIRE_TLS_KEY_FILE must be configured together.',
    );
  }

  const relayUrl = optional(env.NEXOWIRE_RELAY_URL);
  const relayToken = optional(env.NEXOWIRE_RELAY_TOKEN);
  if (Boolean(relayUrl) !== Boolean(relayToken)) {
    throw new Error(
      'NEXOWIRE_RELAY_URL and NEXOWIRE_RELAY_TOKEN must be configured together.',
    );
  }

  return {
    host: optional(env.NEXOWIRE_HTTP_HOST) ?? '127.0.0.1',
    port,
    ...(legacyMcpToken
      ? { mcpBearerToken: legacyMcpToken }
      : {}),
    ...(mcpBearerTokens.length > 0
      ? { mcpBearerTokens }
      : {}),
    ...(legacyAgentToken
      ? { agentToken: legacyAgentToken }
      : {}),
    ...(agentTokens.length > 0
      ? { agentTokens }
      : {}),
    ...(tlsCertFile ? { tlsCertFile } : {}),
    ...(tlsKeyFile ? { tlsKeyFile } : {}),
    ...(envFlag(env.NEXOWIRE_ALLOW_INSECURE_REMOTE)
      ? { allowInsecureRemote: true }
      : {}),
    ...(relayUrl ? { relayUrl } : {}),
    ...(relayToken ? { relayToken } : {}),
    stateDir,
    skillsDir: path.join(cwd, 'skills'),
  };
}

export function hasDirectTls(config: NexowireConfig): boolean {
  return Boolean(config.tlsCertFile && config.tlsKeyFile);
}

export function assertSafeRemoteBinding(config: NexowireConfig): void {
  if (isLoopbackHost(config.host)) return;

  if (
    mcpAuthTokens(config).length === 0 ||
    agentAuthTokens(config).length === 0
  ) {
    throw new Error(
      'Refusing non-loopback bind without configured MCP and native-agent bearer credentials.',
    );
  }

  if (!hasDirectTls(config) && !config.allowInsecureRemote) {
    throw new Error(
      'Refusing non-loopback plaintext transport. Configure NEXOWIRE_TLS_CERT_FILE and NEXOWIRE_TLS_KEY_FILE, bind loopback behind a TLS reverse proxy, or explicitly set NEXOWIRE_ALLOW_INSECURE_REMOTE=1 for a trusted private network.',
    );
  }
}
