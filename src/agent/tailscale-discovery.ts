import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TailscaleDiscovery {
  installed: boolean;
  running: boolean;
  dnsName: string | null;
  ipv4: string | null;
  ipv6: string | null;
  magicDnsSuffix: string | null;
  serveConfigured: boolean;
  funnelConfigured: boolean;
  error: string | null;
}

interface TailscaleStatusJson {
  BackendState?: unknown;
  TailscaleIPs?: unknown;
  MagicDNSSuffix?: unknown;
  Self?: {
    DNSName?: unknown;
  };
}

function nonEmptyObject(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as unknown;
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0
    );
  } catch {
    return false;
  }
}

export function parseTailscaleStatusJson(raw: string): Pick<
  TailscaleDiscovery,
  'running' | 'dnsName' | 'ipv4' | 'ipv6' | 'magicDnsSuffix'
> {
  const parsed = JSON.parse(raw) as TailscaleStatusJson;
  const ips = Array.isArray(parsed.TailscaleIPs)
    ? parsed.TailscaleIPs.filter(
        (entry): entry is string => typeof entry === 'string',
      )
    : [];
  const rawDnsName =
    typeof parsed.Self?.DNSName === 'string'
      ? parsed.Self.DNSName.trim()
      : '';
  return {
    running: parsed.BackendState === 'Running',
    dnsName: rawDnsName ? rawDnsName.replace(/\.$/, '') : null,
    ipv4: ips.find((entry) => !entry.includes(':')) ?? null,
    ipv6: ips.find((entry) => entry.includes(':')) ?? null,
    magicDnsSuffix:
      typeof parsed.MagicDNSSuffix === 'string' &&
      parsed.MagicDNSSuffix.trim()
        ? parsed.MagicDNSSuffix.trim()
        : null,
  };
}

export async function discoverTailscale(): Promise<TailscaleDiscovery> {
  try {
    const status = await execFileAsync(
      'tailscale',
      ['status', '--json'],
      {
        timeout: 5_000,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    const parsed = parseTailscaleStatusJson(status.stdout);

    let serveConfigured = false;
    let funnelConfigured = false;
    try {
      const serve = await execFileAsync(
        'tailscale',
        ['serve', 'status', '--json'],
        {
          timeout: 3_000,
          windowsHide: true,
          maxBuffer: 512 * 1024,
        },
      );
      serveConfigured = nonEmptyObject(serve.stdout);
    } catch {
      // Optional capability.
    }
    try {
      const funnel = await execFileAsync(
        'tailscale',
        ['funnel', 'status', '--json'],
        {
          timeout: 3_000,
          windowsHide: true,
          maxBuffer: 512 * 1024,
        },
      );
      funnelConfigured = nonEmptyObject(funnel.stdout);
    } catch {
      // Optional capability.
    }

    return {
      installed: true,
      ...parsed,
      serveConfigured,
      funnelConfigured,
      error: null,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    const missing =
      /ENOENT|not recognized|not found/i.test(message);
    return {
      installed: !missing,
      running: false,
      dnsName: null,
      ipv4: null,
      ipv6: null,
      magicDnsSuffix: null,
      serveConfigured: false,
      funnelConfigured: false,
      error: message.slice(0, 500),
    };
  }
}
