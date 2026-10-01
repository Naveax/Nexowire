import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { parseTokenList } from './security/tokens.js';
import {
  optionalSecretFile,
  optionalSecretListFile,
} from './security/secret-files.js';
import {
  optionalProtectedSecretFile,
  optionalProtectedSecretListFile,
} from './security/protected-secret-files.js';
import {
  optionalPlatformSecretListSync,
  optionalPlatformSecretSync,
} from './security/platform-secret-store.js';

export interface NexowireOidcConfig {
  issuer: string;
  audience: string;
  jwksUri?: string;
  roleClaim?: string;
  toolsClaim?: string;
  deviceIdsClaim?: string;
  routingPoliciesClaim?: string;
  clockSkewSeconds?: number;
  allowInsecureHttp?: boolean;
}

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
  oidc?: NexowireOidcConfig;
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

export function resolveSkillsDir(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  moduleUrl = import.meta.url,
): string {
  const explicit = optional(env.NEXOWIRE_SKILLS_DIR);
  if (explicit) {
    return path.resolve(cwd, explicit);
  }

  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    path.resolve(moduleDir, '..', 'skills'),
    path.resolve(moduleDir, '..', '..', 'skills'),
    path.join(cwd, 'skills'),
  ];

  return (
    candidates.find((candidate) => existsSync(candidate)) ??
    path.join(cwd, 'skills')
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

export interface ConfigSecretResolvers {
  platformSingle?: (
    name: string | undefined,
    purpose: string,
  ) => string | undefined;
  platformList?: (
    name: string | undefined,
    purpose: string,
  ) => string | undefined;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  secretResolvers: ConfigSecretResolvers = {},
): NexowireConfig {
  const platformSingle =
    secretResolvers.platformSingle ??
    ((name: string | undefined, purpose: string) =>
      optionalPlatformSecretSync(name, purpose));
  const platformList =
    secretResolvers.platformList ??
    ((name: string | undefined, purpose: string) =>
      optionalPlatformSecretListSync(name, purpose));
  const rawPort = env.NEXOWIRE_HTTP_PORT ?? '43110';
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid NEXOWIRE_HTTP_PORT: ${rawPort}`);
  }

  const stateDir =
    optional(env.NEXOWIRE_STATE_DIR) ??
    path.join(os.homedir(), '.nexowire', 'hub');

  const inlineMcpToken = optional(env.NEXOWIRE_MCP_BEARER_TOKEN);
  const fileMcpToken = optionalSecretFile(
    env.NEXOWIRE_MCP_BEARER_TOKEN_FILE,
    'MCP bearer token',
  );
  const protectedMcpToken = optionalProtectedSecretFile(
    env.NEXOWIRE_MCP_BEARER_TOKEN_DPAPI_FILE,
    'mcp-bearer-token',
    'MCP bearer token',
  );
  const platformMcpToken = platformSingle(
    env.NEXOWIRE_MCP_BEARER_TOKEN_PLATFORM_NAME,
    'mcp-bearer-token',
  );
  const inlineAgentToken = optional(env.NEXOWIRE_AGENT_TOKEN);
  const fileAgentToken = optionalSecretFile(
    env.NEXOWIRE_AGENT_TOKEN_FILE,
    'native-agent bearer token',
  );
  const protectedAgentToken = optionalProtectedSecretFile(
    env.NEXOWIRE_AGENT_TOKEN_DPAPI_FILE,
    'agent-bearer-token',
    'native-agent bearer token',
  );
  const platformAgentToken = platformSingle(
    env.NEXOWIRE_AGENT_TOKEN_PLATFORM_NAME,
    'agent-bearer-token',
  );
  const mcpBearerTokens = parseTokenList(
    inlineMcpToken,
    fileMcpToken,
    protectedMcpToken,
    platformMcpToken,
    env.NEXOWIRE_MCP_BEARER_TOKENS,
    optionalSecretListFile(
      env.NEXOWIRE_MCP_BEARER_TOKENS_FILE,
      'MCP bearer token list',
    ),
    optionalProtectedSecretListFile(
      env.NEXOWIRE_MCP_BEARER_TOKENS_DPAPI_FILE,
      'mcp-bearer-token-list',
      'MCP bearer token list',
    ),
    platformList(
      env.NEXOWIRE_MCP_BEARER_TOKENS_PLATFORM_NAME,
      'mcp-bearer-token-list',
    ),
  );
  const agentTokens = parseTokenList(
    inlineAgentToken,
    fileAgentToken,
    protectedAgentToken,
    platformAgentToken,
    env.NEXOWIRE_AGENT_TOKENS,
    optionalSecretListFile(
      env.NEXOWIRE_AGENT_TOKENS_FILE,
      'native-agent bearer token list',
    ),
    optionalProtectedSecretListFile(
      env.NEXOWIRE_AGENT_TOKENS_DPAPI_FILE,
      'agent-bearer-token-list',
      'native-agent bearer token list',
    ),
    platformList(
      env.NEXOWIRE_AGENT_TOKENS_PLATFORM_NAME,
      'agent-bearer-token-list',
    ),
  );
  const legacyMcpToken =
    inlineMcpToken ??
    fileMcpToken ??
    protectedMcpToken ??
    platformMcpToken;
  const legacyAgentToken =
    inlineAgentToken ??
    fileAgentToken ??
    protectedAgentToken ??
    platformAgentToken;

  const tlsCertFile = optional(env.NEXOWIRE_TLS_CERT_FILE);
  const tlsKeyFile = optional(env.NEXOWIRE_TLS_KEY_FILE);
  if (Boolean(tlsCertFile) !== Boolean(tlsKeyFile)) {
    throw new Error(
      'NEXOWIRE_TLS_CERT_FILE and NEXOWIRE_TLS_KEY_FILE must be configured together.',
    );
  }

  const oidcIssuer = optional(env.NEXOWIRE_OIDC_ISSUER);
  const oidcAudience = optional(env.NEXOWIRE_OIDC_AUDIENCE);
  if (Boolean(oidcIssuer) !== Boolean(oidcAudience)) {
    throw new Error(
      'NEXOWIRE_OIDC_ISSUER and NEXOWIRE_OIDC_AUDIENCE must be configured together.',
    );
  }
  const rawOidcSkew = optional(env.NEXOWIRE_OIDC_CLOCK_SKEW_SECONDS);
  let oidcClockSkewSeconds: number | undefined;
  if (rawOidcSkew !== undefined) {
    const parsed = Number(rawOidcSkew);
    if (
      !Number.isInteger(parsed) ||
      parsed < 0 ||
      parsed > 300
    ) {
      throw new Error(
        'NEXOWIRE_OIDC_CLOCK_SKEW_SECONDS must be an integer between 0 and 300.',
      );
    }
    oidcClockSkewSeconds = parsed;
  }
  const oidc: NexowireOidcConfig | undefined =
    oidcIssuer && oidcAudience
      ? {
          issuer: oidcIssuer,
          audience: oidcAudience,
          ...(optional(env.NEXOWIRE_OIDC_JWKS_URI)
            ? { jwksUri: optional(env.NEXOWIRE_OIDC_JWKS_URI)! }
            : {}),
          ...(optional(env.NEXOWIRE_OIDC_ROLE_CLAIM)
            ? { roleClaim: optional(env.NEXOWIRE_OIDC_ROLE_CLAIM)! }
            : {}),
          ...(optional(env.NEXOWIRE_OIDC_TOOLS_CLAIM)
            ? { toolsClaim: optional(env.NEXOWIRE_OIDC_TOOLS_CLAIM)! }
            : {}),
          ...(optional(env.NEXOWIRE_OIDC_DEVICE_IDS_CLAIM)
            ? {
                deviceIdsClaim:
                  optional(env.NEXOWIRE_OIDC_DEVICE_IDS_CLAIM)!,
              }
            : {}),
          ...(optional(env.NEXOWIRE_OIDC_ROUTING_POLICIES_CLAIM)
            ? {
                routingPoliciesClaim:
                  optional(env.NEXOWIRE_OIDC_ROUTING_POLICIES_CLAIM)!,
              }
            : {}),
          ...(oidcClockSkewSeconds !== undefined
            ? { clockSkewSeconds: oidcClockSkewSeconds }
            : {}),
          ...(envFlag(env.NEXOWIRE_OIDC_ALLOW_INSECURE_HTTP)
            ? { allowInsecureHttp: true }
            : {}),
        }
      : undefined;

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
    ...(oidc ? { oidc } : {}),
    stateDir,
    skillsDir: resolveSkillsDir(env, cwd),
  };
}

export function hasDirectTls(config: NexowireConfig): boolean {
  return Boolean(config.tlsCertFile && config.tlsKeyFile);
}

export interface RuntimeAuthAvailability {
  mcp?: boolean;
  agent?: boolean;
}

export function assertSafeRemoteBinding(
  config: NexowireConfig,
  availability: RuntimeAuthAvailability = {},
): void {
  if (isLoopbackHost(config.host)) return;

  if (
    (mcpAuthTokens(config).length === 0 && !availability.mcp) ||
    (agentAuthTokens(config).length === 0 && !availability.agent)
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
