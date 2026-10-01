import type { NexowireConfig } from '../config.js';
import {
  CredentialRoleSchema,
  CredentialStore,
  type CredentialMetadata,
  type CredentialRole,
} from './credential-store.js';
import {
  evaluateDeploymentReadiness,
  type DeploymentReadinessReport,
} from './deployment-readiness.js';

const DEFAULT_TTL_DAYS = 30;

export interface DeploymentOnboardingOptions {
  remote?: boolean;
  force?: boolean;
  mcpRole?: CredentialRole;
  mcpTtlDays?: number;
  agentTtlDays?: number;
  allowedTools?: string[];
  allowedDeviceIds?: string[];
  allowedRoutingPolicies?: string[];
}

export interface DeploymentOnboardingIssue {
  scope: 'mcp' | 'agent';
  credential: CredentialMetadata;
  token: string;
}

export interface DeploymentOnboardingPlan {
  mode: 'plan' | 'bootstrap';
  readiness: DeploymentReadinessReport;
  issued: DeploymentOnboardingIssue[];
  existing: {
    mcpUsable: boolean;
    agentUsable: boolean;
  };
  secretHandling: {
    plaintextPersistedByNexowire: false;
    tokensShownOnce: boolean;
    recommendations: string[];
  };
  nextSteps: string[];
}

function ttlMs(days: number | undefined): number {
  const resolved = days ?? DEFAULT_TTL_DAYS;
  if (
    !Number.isInteger(resolved) ||
    resolved < 1 ||
    resolved > 365
  ) {
    throw new Error(
      'Onboarding credential TTL must be an integer between 1 and 365 days.',
    );
  }
  return resolved * 86_400_000;
}

function unique(values: readonly string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const normalized = [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ].sort();
  return normalized.length > 0 ? normalized : undefined;
}

function nextSteps(
  config: NexowireConfig,
  report: DeploymentReadinessReport,
  issued: DeploymentOnboardingIssue[],
  remote: boolean,
): string[] {
  const steps: string[] = [];

  if (issued.some((entry) => entry.scope === 'agent')) {
    steps.push(
      'Store the one-time native-agent token on the target machine using a protected secret source, then configure NEXOWIRE_AGENT_TOKEN_FILE, NEXOWIRE_AGENT_TOKEN_DPAPI_FILE, or NEXOWIRE_AGENT_TOKEN_PLATFORM_NAME.',
    );
  }
  if (issued.some((entry) => entry.scope === 'mcp')) {
    steps.push(
      'Store the one-time MCP token in the ChatGPT/client connector secret configuration; do not copy it into repository files or launcher arguments.',
    );
  }

  if (remote && report.mode === 'local') {
    steps.push(
      'Choose an intentional remote bind or keep Nexowire on loopback behind a trusted TLS reverse proxy/relay.',
    );
  }
  if (remote) {
    const tls = report.checks.find(
      (check) => check.id === 'transport-tls',
    );
    if (tls?.status !== 'pass') {
      steps.push(
        'Configure trusted TLS before Internet-facing use. Direct Nexowire TLS requires NEXOWIRE_TLS_CERT_FILE and NEXOWIRE_TLS_KEY_FILE.',
      );
    }
  }

  steps.push(
    'Run nexowire doctor' +
      (remote ? ' --remote' : '') +
      ' and require zero failing checks before treating deployment as ready.',
  );
  steps.push(
    'Install the first-party native agent lifecycle after its protected token source and hub endpoint are configured.',
  );

  if (!config.oidc && remote) {
    steps.push(
      'For multi-user or organization deployment, prefer external OIDC/JWT identity over long-lived shared MCP bearer credentials.',
    );
  }

  return steps;
}

function secretRecommendations(): string[] {
  return [
    'Windows: prefer DPAPI-protected secret files created by nexowire secrets seal.',
    'Linux: prefer Secret Service via nexowire secrets platform-store or a permission-restricted mounted secret file.',
    'macOS: Keychain reads/status are supported; keep writes fail-closed until the no-argv storage path is available.',
    'Never place bearer tokens in Git, shell history, process arguments, launchers, or lifecycle manifests.',
  ];
}

export async function planDeploymentOnboarding(
  config: NexowireConfig,
  store: CredentialStore,
  options: DeploymentOnboardingOptions = {},
): Promise<DeploymentOnboardingPlan> {
  const report = await evaluateDeploymentReadiness(config, {
    credentials: store,
    env: process.env,
    requireRemote: options.remote === true,
  });

  return {
    mode: 'plan',
    readiness: report,
    issued: [],
    existing: {
      mcpUsable: store.hasUsable('mcp'),
      agentUsable: store.hasUsable('agent'),
    },
    secretHandling: {
      plaintextPersistedByNexowire: false,
      tokensShownOnce: false,
      recommendations: secretRecommendations(),
    },
    nextSteps: nextSteps(
      config,
      report,
      [],
      options.remote === true,
    ),
  };
}

export async function bootstrapDeploymentOnboarding(
  config: NexowireConfig,
  store: CredentialStore,
  options: DeploymentOnboardingOptions = {},
): Promise<DeploymentOnboardingPlan> {
  const mcpRole = CredentialRoleSchema.parse(
    options.mcpRole ?? 'user',
  );
  const force = options.force === true;
  const existingBefore = {
    mcpUsable: store.hasUsable('mcp'),
    agentUsable: store.hasUsable('agent'),
  };
  const issued: DeploymentOnboardingIssue[] = [];

  if (force || !existingBefore.mcpUsable) {
    const result = await store.issue('mcp', {
      name: 'deployment-onboarding-mcp',
      ttlMs: ttlMs(options.mcpTtlDays),
      role: mcpRole,
      ...(unique(options.allowedTools)
        ? { allowedTools: unique(options.allowedTools) }
        : {}),
      ...(unique(options.allowedDeviceIds)
        ? { allowedDeviceIds: unique(options.allowedDeviceIds) }
        : {}),
      ...(unique(options.allowedRoutingPolicies)
        ? {
            allowedRoutingPolicies: unique(
              options.allowedRoutingPolicies,
            ),
          }
        : {}),
    });
    issued.push({
      scope: 'mcp',
      credential: result.credential,
      token: result.token,
    });
  }

  if (force || !existingBefore.agentUsable) {
    const result = await store.issue('agent', {
      name: 'deployment-onboarding-agent',
      ttlMs: ttlMs(options.agentTtlDays),
    });
    issued.push({
      scope: 'agent',
      credential: result.credential,
      token: result.token,
    });
  }

  const report = await evaluateDeploymentReadiness(config, {
    credentials: store,
    env: process.env,
    requireRemote: options.remote === true,
  });

  return {
    mode: 'bootstrap',
    readiness: report,
    issued,
    existing: existingBefore,
    secretHandling: {
      plaintextPersistedByNexowire: false,
      tokensShownOnce: issued.length > 0,
      recommendations: secretRecommendations(),
    },
    nextSteps: nextSteps(
      config,
      report,
      issued,
      options.remote === true,
    ),
  };
}

function usage(): never {
  throw new Error(
    'Usage: nexowire onboard [plan|bootstrap] [--remote] [--force] [--mcp-role user|operator|admin] [--mcp-ttl-days N] [--agent-ttl-days N] [--allow-tool pattern]... [--allow-device stable-id]... [--allow-route policy]...',
  );
}

function parseIntegerOption(
  name: string,
  raw: string | undefined,
): number {
  if (!raw) throw new Error(name + ' requires a value.');
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(name + ' requires an integer.');
  }
  return value;
}

export function parseDeploymentOnboardingArgs(
  args: readonly string[],
): {
  action: 'plan' | 'bootstrap';
  options: DeploymentOnboardingOptions;
} {
  let action: 'plan' | 'bootstrap' = 'plan';
  let index = 0;
  if (args[0] === 'plan' || args[0] === 'bootstrap') {
    action = args[0];
    index = 1;
  }

  const options: DeploymentOnboardingOptions = {};
  const tools: string[] = [];
  const devices: string[] = [];
  const routes: string[] = [];

  for (; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--remote') {
      options.remote = true;
      continue;
    }
    if (arg === '--force') {
      options.force = true;
      continue;
    }

    const readValue = (name: string): string => {
      const value = args[index + 1]?.trim();
      if (!value || value.startsWith('--')) {
        throw new Error(name + ' requires a value.');
      }
      index++;
      return value;
    };

    if (arg === '--mcp-role') {
      options.mcpRole = CredentialRoleSchema.parse(
        readValue(arg),
      );
      continue;
    }
    if (arg.startsWith('--mcp-role=')) {
      options.mcpRole = CredentialRoleSchema.parse(
        arg.slice('--mcp-role='.length),
      );
      continue;
    }
    if (arg === '--mcp-ttl-days') {
      options.mcpTtlDays = parseIntegerOption(
        arg,
        readValue(arg),
      );
      continue;
    }
    if (arg.startsWith('--mcp-ttl-days=')) {
      options.mcpTtlDays = parseIntegerOption(
        '--mcp-ttl-days',
        arg.slice('--mcp-ttl-days='.length),
      );
      continue;
    }
    if (arg === '--agent-ttl-days') {
      options.agentTtlDays = parseIntegerOption(
        arg,
        readValue(arg),
      );
      continue;
    }
    if (arg.startsWith('--agent-ttl-days=')) {
      options.agentTtlDays = parseIntegerOption(
        '--agent-ttl-days',
        arg.slice('--agent-ttl-days='.length),
      );
      continue;
    }
    if (arg === '--allow-tool') {
      tools.push(readValue(arg));
      continue;
    }
    if (arg.startsWith('--allow-tool=')) {
      tools.push(arg.slice('--allow-tool='.length));
      continue;
    }
    if (arg === '--allow-device') {
      devices.push(readValue(arg));
      continue;
    }
    if (arg.startsWith('--allow-device=')) {
      devices.push(arg.slice('--allow-device='.length));
      continue;
    }
    if (arg === '--allow-route') {
      routes.push(readValue(arg));
      continue;
    }
    if (arg.startsWith('--allow-route=')) {
      routes.push(arg.slice('--allow-route='.length));
      continue;
    }

    usage();
  }

  if (tools.length > 0) options.allowedTools = tools;
  if (devices.length > 0) options.allowedDeviceIds = devices;
  if (routes.length > 0) options.allowedRoutingPolicies = routes;

  return { action, options };
}

export async function runDeploymentOnboardingCommand(
  config: NexowireConfig,
  args: readonly string[],
): Promise<void> {
  const parsed = parseDeploymentOnboardingArgs(args);
  const store = new CredentialStore(config.stateDir);
  await store.initialize();

  const report =
    parsed.action === 'bootstrap'
      ? await bootstrapDeploymentOnboarding(
          config,
          store,
          parsed.options,
        )
      : await planDeploymentOnboarding(
          config,
          store,
          parsed.options,
        );

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');

  if (
    parsed.options.remote === true &&
    !report.readiness.remoteReady
  ) {
    process.exitCode = 2;
  }
}
