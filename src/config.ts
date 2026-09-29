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
  stateDir: string;
  skillsDir: string;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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
    stateDir,
    skillsDir: path.join(cwd, 'skills'),
  };
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
}
