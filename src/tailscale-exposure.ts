import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  agentAuthTokens,
  mcpAuthTokens,
  type NexowireConfig,
} from './config.js';
import { CredentialStore } from './security/credential-store.js';
import { discoverTailscale } from './agent/tailscale-discovery.js';

const execFileAsync = promisify(execFile);

export type TailscaleExposureMode = 'serve' | 'funnel';

export interface TailscaleExposureResult {
  mode: TailscaleExposureMode;
  dnsName: string;
  localTarget: string;
  mcpUrl: string;
  agentUrl: string;
  public: boolean;
  configured: boolean;
}

async function storedAuthAvailability(
  config: NexowireConfig,
): Promise<{ mcp: boolean; agent: boolean }> {
  const store = new CredentialStore(config.stateDir);
  await store.initialize();
  return {
    mcp: store.hasUsable('mcp'),
    agent: store.hasUsable('agent'),
  };
}

export async function assertFunnelAuthReady(
  config: NexowireConfig,
): Promise<void> {
  const stored = await storedAuthAvailability(config);
  const mcpReady =
    mcpAuthTokens(config).length > 0 ||
    stored.mcp ||
    Boolean(config.oidc);
  const agentReady =
    agentAuthTokens(config).length > 0 ||
    stored.agent;

  if (!mcpReady || !agentReady) {
    throw new Error(
      'Refusing public Tailscale Funnel exposure until both MCP and native-agent authentication are configured.',
    );
  }
}

export async function configureTailscaleExposure(
  config: NexowireConfig,
  mode: TailscaleExposureMode,
): Promise<TailscaleExposureResult> {
  const tailscale = await discoverTailscale();
  if (!tailscale.installed) {
    throw new Error('Tailscale is not installed.');
  }
  if (!tailscale.running || !tailscale.dnsName) {
    throw new Error(
      'Tailscale is installed but not connected with a usable MagicDNS name.',
    );
  }

  if (mode === 'funnel') {
    await assertFunnelAuthReady(config);
  }

  const target = `http://127.0.0.1:${config.port}`;
  await execFileAsync(
    'tailscale',
    [mode, '--bg', target],
    {
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );

  return {
    mode,
    dnsName: tailscale.dnsName,
    localTarget: target,
    mcpUrl: `https://${tailscale.dnsName}/mcp`,
    agentUrl: `wss://${tailscale.dnsName}/agent`,
    public: mode === 'funnel',
    configured: true,
  };
}

export async function resetTailscaleExposure(
  mode: TailscaleExposureMode,
): Promise<void> {
  await execFileAsync(
    'tailscale',
    [mode, 'reset'],
    {
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 512 * 1024,
    },
  );
}

export async function runTailscaleCommand(
  config: NexowireConfig,
  args: readonly string[],
): Promise<void> {
  const action = args[0] ?? 'status';

  if (action === 'status') {
    const status = await discoverTailscale();
    process.stdout.write(
      JSON.stringify(status, null, 2) + '\n',
    );
    return;
  }

  if (action === 'serve' || action === 'funnel') {
    const result = await configureTailscaleExposure(
      config,
      action,
    );
    process.stdout.write(
      JSON.stringify(result, null, 2) + '\n',
    );
    return;
  }

  if (action === 'reset') {
    const mode = args[1];
    if (mode !== 'serve' && mode !== 'funnel') {
      throw new Error(
        'Usage: nexowire tailscale reset <serve|funnel>',
      );
    }
    await resetTailscaleExposure(mode);
    process.stdout.write(
      JSON.stringify(
        { mode, configured: false },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  throw new Error(
    'Usage: nexowire tailscale [status|serve|funnel|reset <serve|funnel>]',
  );
}
