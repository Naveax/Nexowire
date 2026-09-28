import os from 'node:os';
import path from 'node:path';

export interface NexowireConfig {
  host: string;
  port: number;
  mcpBearerToken?: string;
  agentToken?: string;
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

  return {
    host: optional(env.NEXOWIRE_HTTP_HOST) ?? '127.0.0.1',
    port,
    ...(optional(env.NEXOWIRE_MCP_BEARER_TOKEN)
      ? { mcpBearerToken: optional(env.NEXOWIRE_MCP_BEARER_TOKEN) }
      : {}),
    ...(optional(env.NEXOWIRE_AGENT_TOKEN)
      ? { agentToken: optional(env.NEXOWIRE_AGENT_TOKEN) }
      : {}),
    stateDir,
    skillsDir: path.join(cwd, 'skills'),
  };
}

export function assertSafeRemoteBinding(config: NexowireConfig): void {
  if (isLoopbackHost(config.host)) return;

  if (!config.mcpBearerToken || !config.agentToken) {
    throw new Error(
      'Refusing non-loopback bind without both NEXOWIRE_MCP_BEARER_TOKEN and NEXOWIRE_AGENT_TOKEN.',
    );
  }
}
