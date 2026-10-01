import { X509Certificate } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile } from 'node:fs/promises';
import {
  agentAuthTokens,
  hasDirectTls,
  isLoopbackHost,
  mcpAuthTokens,
  type NexowireConfig,
} from '../config.js';
import type { CredentialStore } from './credential-store.js';

export type ReadinessStatus = 'pass' | 'warn' | 'fail';

export interface DeploymentReadinessCheck {
  id: string;
  status: ReadinessStatus;
  summary: string;
  remediation?: string;
  details?: Record<string, unknown>;
}

export interface DeploymentReadinessReport {
  generatedAt: string;
  mode: 'local' | 'remote';
  ready: boolean;
  remoteReady: boolean;
  summary: {
    pass: number;
    warn: number;
    fail: number;
  };
  checks: DeploymentReadinessCheck[];
}

function secretSourceKinds(env: NodeJS.ProcessEnv): string[] {
  const sources = new Set<string>();
  const entries = Object.entries(env);

  for (const [name, value] of entries) {
    if (!value?.trim()) continue;
    if (
      name === 'NEXOWIRE_MCP_BEARER_TOKEN' ||
      name === 'NEXOWIRE_MCP_BEARER_TOKENS' ||
      name === 'NEXOWIRE_AGENT_TOKEN' ||
      name === 'NEXOWIRE_AGENT_TOKENS'
    ) {
      sources.add('inline-env');
    } else if (
      /NEXOWIRE_(?:MCP|AGENT).*_DPAPI_FILE$/.test(name)
    ) {
      sources.add('windows-dpapi');
    } else if (
      /NEXOWIRE_(?:MCP|AGENT).*_PLATFORM_NAME$/.test(name)
    ) {
      sources.add('platform-store');
    } else if (
      /NEXOWIRE_(?:MCP|AGENT).*_FILE$/.test(name)
    ) {
      sources.add('mounted-file');
    }
  }

  return [...sources].sort();
}

async function stateDirectoryCheck(
  stateDir: string,
): Promise<DeploymentReadinessCheck> {
  try {
    await mkdir(stateDir, { recursive: true });
    await access(stateDir, fsConstants.R_OK | fsConstants.W_OK);
    return {
      id: 'state-directory',
      status: 'pass',
      summary: 'Nexowire state directory is readable and writable.',
      details: { path: stateDir },
    };
  } catch (error) {
    return {
      id: 'state-directory',
      status: 'fail',
      summary: 'Nexowire state directory is not usable.',
      remediation:
        'Configure NEXOWIRE_STATE_DIR to a private readable/writable directory for the Nexowire service identity.',
      details: {
        path: stateDir,
        error:
          error instanceof Error ? error.name : 'unknown',
      },
    };
  }
}

async function tlsCheck(
  config: NexowireConfig,
  nowMs: number,
): Promise<DeploymentReadinessCheck> {
  if (!hasDirectTls(config)) {
    if (isLoopbackHost(config.host)) {
      return {
        id: 'transport-tls',
        status: 'warn',
        summary:
          'Direct TLS is not configured; loopback-only binding is acceptable behind a trusted local deployment or TLS reverse proxy.',
        remediation:
          'For direct remote exposure, configure NEXOWIRE_TLS_CERT_FILE and NEXOWIRE_TLS_KEY_FILE.',
      };
    }

    if (config.allowInsecureRemote) {
      return {
        id: 'transport-tls',
        status: 'warn',
        summary:
          'Remote plaintext transport is explicitly enabled.',
        remediation:
          'Prefer direct TLS or loopback behind a trusted TLS reverse proxy; keep NEXOWIRE_ALLOW_INSECURE_REMOTE disabled for Internet-facing deployment.',
      };
    }

    return {
      id: 'transport-tls',
      status: 'fail',
      summary: 'Remote deployment has no TLS protection.',
      remediation:
        'Configure NEXOWIRE_TLS_CERT_FILE and NEXOWIRE_TLS_KEY_FILE or terminate TLS at a trusted reverse proxy while binding Nexowire to loopback.',
    };
  }

  try {
    const [certificatePem] = await Promise.all([
      readFile(config.tlsCertFile!, 'utf8'),
      access(config.tlsKeyFile!, fsConstants.R_OK),
    ]);
    const certificate = new X509Certificate(certificatePem);
    const validTo = Date.parse(certificate.validTo);
    const validFrom = Date.parse(certificate.validFrom);
    if (
      !Number.isFinite(validTo) ||
      !Number.isFinite(validFrom)
    ) {
      throw new Error('invalid-certificate-time');
    }
    if (nowMs < validFrom) {
      return {
        id: 'transport-tls',
        status: 'fail',
        summary: 'Configured TLS certificate is not valid yet.',
        remediation:
          'Install a currently valid certificate before remote exposure.',
        details: {
          validFrom: certificate.validFrom,
          validTo: certificate.validTo,
        },
      };
    }
    if (nowMs >= validTo) {
      return {
        id: 'transport-tls',
        status: 'fail',
        summary: 'Configured TLS certificate is expired.',
        remediation:
          'Renew the TLS certificate before starting remote deployment.',
        details: {
          validFrom: certificate.validFrom,
          validTo: certificate.validTo,
        },
      };
    }

    const daysRemaining = Math.floor(
      (validTo - nowMs) / 86_400_000,
    );
    return {
      id: 'transport-tls',
      status: daysRemaining < 14 ? 'warn' : 'pass',
      summary:
        daysRemaining < 14
          ? 'TLS certificate is valid but expires soon.'
          : 'TLS certificate and private-key path are readable and the certificate is currently valid.',
      ...(daysRemaining < 14
        ? {
            remediation:
              'Renew the TLS certificate before it reaches expiry.',
          }
        : {}),
      details: {
        validFrom: certificate.validFrom,
        validTo: certificate.validTo,
        daysRemaining,
      },
    };
  } catch (error) {
    return {
      id: 'transport-tls',
      status: 'fail',
      summary:
        'Configured TLS certificate/key could not be validated.',
      remediation:
        'Verify certificate/key paths, permissions, and PEM certificate format.',
      details: {
        error:
          error instanceof Error ? error.name : 'unknown',
      },
    };
  }
}

export async function evaluateDeploymentReadiness(
  config: NexowireConfig,
  options: {
    credentials?: CredentialStore;
    env?: NodeJS.ProcessEnv;
    now?: number;
    requireRemote?: boolean;
  } = {},
): Promise<DeploymentReadinessReport> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const mode = isLoopbackHost(config.host)
    ? 'local'
    : 'remote';
  const checks: DeploymentReadinessCheck[] = [];

  checks.push({
    id: 'bind-address',
    status:
      options.requireRemote === true && mode === 'local'
        ? 'fail'
        : mode === 'local'
          ? 'warn'
          : 'pass',
    summary:
      mode === 'local'
        ? 'Nexowire is bound to loopback only.'
        : 'Nexowire is configured for a non-loopback bind.',
    ...(mode === 'local'
      ? {
          remediation:
            options.requireRemote === true
              ? 'Configure an intentional remote bind or deploy a trusted reverse proxy/relay path.'
              : 'No action is required for local-only use. Remote ChatGPT access needs an intentional protected deployment path.',
        }
      : {}),
    details: {
      host: config.host,
      port: config.port,
    },
  });

  const storedMcp =
    options.credentials?.hasUsable('mcp') ?? false;
  const storedAgent =
    options.credentials?.hasUsable('agent') ?? false;
  const mcpStaticCount = mcpAuthTokens(config).length;
  const agentStaticCount = agentAuthTokens(config).length;
  const oidc = Boolean(config.oidc);

  checks.push({
    id: 'mcp-authentication',
    status:
      mcpStaticCount > 0 || storedMcp || oidc
        ? 'pass'
        : mode === 'remote' || options.requireRemote
          ? 'fail'
          : 'warn',
    summary:
      mcpStaticCount > 0 || storedMcp || oidc
        ? 'MCP client authentication is configured.'
        : 'No MCP client authentication is configured.',
    ...(mcpStaticCount === 0 && !storedMcp && !oidc
      ? {
          remediation:
            'Configure stored MCP credentials, protected bearer credentials, or external OIDC/JWT identity before remote exposure.',
        }
      : {}),
    details: {
      staticCredentialCount: mcpStaticCount,
      storedCredentialAvailable: storedMcp,
      externalOidcConfigured: oidc,
    },
  });

  checks.push({
    id: 'agent-authentication',
    status:
      agentStaticCount > 0 || storedAgent
        ? 'pass'
        : mode === 'remote' || options.requireRemote
          ? 'fail'
          : 'warn',
    summary:
      agentStaticCount > 0 || storedAgent
        ? 'Native-agent authentication is configured.'
        : 'No native-agent authentication is configured.',
    ...(agentStaticCount === 0 && !storedAgent
      ? {
          remediation:
            'Configure a stored or protected native-agent credential before remote exposure.',
        }
      : {}),
    details: {
      staticCredentialCount: agentStaticCount,
      storedCredentialAvailable: storedAgent,
    },
  });

  const sourceKinds = secretSourceKinds(env);
  checks.push({
    id: 'secret-sources',
    status: sourceKinds.includes('inline-env')
      ? 'warn'
      : sourceKinds.length > 0 || storedMcp || storedAgent || oidc
        ? 'pass'
        : 'warn',
    summary:
      sourceKinds.length > 0
        ? 'Bootstrap secret source mechanisms were detected.'
        : 'No file/platform bootstrap secret source is configured.',
    ...(sourceKinds.includes('inline-env')
      ? {
          remediation:
            'Prefer stored credentials, mounted secret files, Windows DPAPI, or platform secret stores over plaintext inline environment values.',
        }
      : {}),
    details: {
      mechanisms: sourceKinds,
    },
  });

  if (config.oidc) {
    let issuerProtocol = 'invalid';
    try {
      issuerProtocol = new URL(config.oidc.issuer).protocol;
    } catch {
      // loadConfig normally rejects malformed usage later in OIDC verification.
    }
    checks.push({
      id: 'external-identity',
      status:
        issuerProtocol === 'https:' ||
        config.oidc.allowInsecureHttp === true
          ? issuerProtocol === 'https:'
            ? 'pass'
            : 'warn'
          : 'fail',
      summary:
        issuerProtocol === 'https:'
          ? 'External OIDC/JWT identity is configured with an HTTPS issuer.'
          : config.oidc.allowInsecureHttp
            ? 'OIDC insecure-HTTP development override is enabled.'
            : 'OIDC issuer is not protected by HTTPS.',
      ...(issuerProtocol !== 'https:'
        ? {
            remediation:
              'Use an HTTPS OIDC issuer for production deployment and disable the insecure-HTTP development override.',
          }
        : {}),
      details: {
        issuerProtocol,
        audienceConfigured: Boolean(config.oidc.audience),
        customJwksUri: Boolean(config.oidc.jwksUri),
      },
    });
  }

  checks.push(await tlsCheck(config, now));
  checks.push(await stateDirectoryCheck(config.stateDir));

  const summary = {
    pass: checks.filter((check) => check.status === 'pass')
      .length,
    warn: checks.filter((check) => check.status === 'warn')
      .length,
    fail: checks.filter((check) => check.status === 'fail')
      .length,
  };

  const ready = summary.fail === 0;
  const remoteSpecificFailure =
    mode === 'local' ||
    checks.some(
      (check) =>
        [
          'transport-tls',
          'mcp-authentication',
          'agent-authentication',
          'external-identity',
        ].includes(check.id) &&
        check.status === 'fail',
    );

  return {
    generatedAt: new Date(now).toISOString(),
    mode,
    ready,
    remoteReady: !remoteSpecificFailure,
    summary,
    checks,
  };
}
