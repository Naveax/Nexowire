import dns from 'node:dns/promises';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import * as z from 'zod';

const MachineHealthInputSchema = z.object({
  sample_ms: z.number().int().min(100).max(2_000).default(250),
});

const DnsResolveInputSchema = z.object({
  host: z.string().min(1).max(253),
  family: z.enum(['any', 'ipv4', 'ipv6']).default('any'),
});

const TcpProbeInputSchema = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65_535),
  family: z.enum(['any', 'ipv4', 'ipv6']).default('any'),
  timeout_ms: z.number().int().min(100).max(30_000).default(5_000),
});

const HttpProbeInputSchema = z.object({
  url: z.string().url().max(8_192),
  method: z.enum(['HEAD', 'GET']).default('HEAD'),
  timeout_ms: z.number().int().min(100).max(30_000).default(10_000),
  follow_redirects: z.boolean().default(false),
  max_body_bytes: z.number().int().min(0).max(1_048_576).default(65_536),
});

interface CpuSample {
  idle: number;
  total: number;
}

function sampleCpu(): CpuSample {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total +=
      cpu.times.user +
      cpu.times.nice +
      cpu.times.sys +
      cpu.times.idle +
      cpu.times.irq;
  }
  return { idle, total };
}

function percentage(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((value / total) * 10_000) / 100;
}

function sanitizedUrl(value: string): string {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  return url.toString();
}

async function machineHealth(input: unknown) {
  const parsed = MachineHealthInputSchema.parse(input);
  const before = sampleCpu();
  await new Promise((resolve) => setTimeout(resolve, parsed.sample_ms));
  const after = sampleCpu();
  const totalDelta = Math.max(0, after.total - before.total);
  const idleDelta = Math.max(0, after.idle - before.idle);
  const busyDelta = Math.max(0, totalDelta - idleDelta);

  const totalMemoryBytes = os.totalmem();
  const freeMemoryBytes = os.freemem();
  const usedMemoryBytes = Math.max(0, totalMemoryBytes - freeMemoryBytes);

  let disk:
    | {
        path: string;
        totalBytes: number;
        freeBytes: number;
        usedBytes: number;
        usedPercent: number;
      }
    | {
        path: string;
        error: string;
      };
  try {
    const stat = await fs.statfs(os.homedir());
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    disk = {
      path: os.homedir(),
      totalBytes,
      freeBytes,
      usedBytes,
      usedPercent: percentage(usedBytes, totalBytes),
    };
  } catch (error) {
    disk = {
      path: os.homedir(),
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    data: {
      at: new Date().toISOString(),
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      uptimeSeconds: Math.round(os.uptime()),
      cpu: {
        logicalCount: os.cpus().length,
        sampleMs: parsed.sample_ms,
        usagePercent: percentage(busyDelta, totalDelta),
        loadAverage: os.loadavg(),
      },
      memory: {
        totalBytes: totalMemoryBytes,
        freeBytes: freeMemoryBytes,
        usedBytes: usedMemoryBytes,
        usedPercent: percentage(usedMemoryBytes, totalMemoryBytes),
      },
      disk,
    },
  };
}

async function dnsResolve(input: unknown) {
  const parsed = DnsResolveInputSchema.parse(input);
  const started = performance.now();
  try {
    const family: 4 | 6 | undefined =
      parsed.family === 'ipv4'
        ? 4
        : parsed.family === 'ipv6'
          ? 6
          : undefined;
    const addresses = await dns.lookup(parsed.host, {
      all: true,
      verbatim: true,
      ...(family ? { family } : {}),
    });
    return {
      data: {
        host: parsed.host,
        family: parsed.family,
        resolved: true,
        durationMs: Math.round(performance.now() - started),
        addresses,
      },
    };
  } catch (error) {
    return {
      data: {
        host: parsed.host,
        family: parsed.family,
        resolved: false,
        durationMs: Math.round(performance.now() - started),
        addresses: [],
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function tcpProbe(input: unknown) {
  const parsed = TcpProbeInputSchema.parse(input);
  const started = performance.now();

  return await new Promise<unknown>((resolve) => {
    let settled = false;
    const finish = (data: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      resolve({
        data: {
          host: parsed.host,
          port: parsed.port,
          family: parsed.family,
          durationMs: Math.round(performance.now() - started),
          ...data,
        },
      });
    };

    const socket = net.createConnection({
      host: parsed.host,
      port: parsed.port,
      ...(parsed.family === 'ipv4'
        ? { family: 4 }
        : parsed.family === 'ipv6'
          ? { family: 6 }
          : {}),
    });

    socket.setTimeout(parsed.timeout_ms);

    socket.once('connect', () => {
      const remoteAddress = socket.remoteAddress;
      const remoteFamily = socket.remoteFamily;
      const localAddress = socket.localAddress;
      const localPort = socket.localPort;
      socket.end();
      finish({
        reachable: true,
        remoteAddress,
        remoteFamily,
        localAddress,
        localPort,
      });
    });

    socket.once('timeout', () => {
      socket.destroy();
      finish({
        reachable: false,
        timedOut: true,
        error: `TCP probe timed out after ${parsed.timeout_ms}ms.`,
      });
    });

    socket.once('error', (error) => {
      finish({
        reachable: false,
        timedOut: false,
        error: error.message,
        ...(typeof (error as NodeJS.ErrnoException).code === 'string'
          ? { errorCode: (error as NodeJS.ErrnoException).code }
          : {}),
      });
    });
  });
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<{ body?: string; bytesRead: number; truncated: boolean }> {
  if (maxBytes <= 0 || !response.body) {
    return { bytesRead: 0, truncated: false };
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  let truncated = false;

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      const remaining = maxBytes - bytesRead;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel();
        break;
      }
      if (chunk.byteLength > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        bytesRead += remaining;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(chunk);
      bytesRead += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  return {
    body: Buffer.concat(chunks).toString('utf8'),
    bytesRead,
    truncated,
  };
}

async function httpProbe(input: unknown) {
  const parsed = HttpProbeInputSchema.parse(input);
  const url = new URL(parsed.url);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('HTTP probe supports only http:// and https:// URLs.');
  }
  if (url.username || url.password) {
    throw new Error('HTTP probe URLs must not embed credentials.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), parsed.timeout_ms);
  const started = performance.now();

  try {
    const response = await fetch(url, {
      method: parsed.method,
      redirect: parsed.follow_redirects ? 'follow' : 'manual',
      signal: controller.signal,
      headers: {
        'user-agent': 'Nexowire/0.1',
        accept: '*/*',
      },
    });
    const headersMs = Math.round(performance.now() - started);
    const body =
      parsed.method === 'GET'
        ? await readBoundedBody(response, parsed.max_body_bytes)
        : { bytesRead: 0, truncated: false };

    return {
      data: {
        url: sanitizedUrl(parsed.url),
        finalUrl: sanitizedUrl(response.url || parsed.url),
        method: parsed.method,
        reachable: true,
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        redirected: response.redirected,
        headersMs,
        durationMs: Math.round(performance.now() - started),
        contentType: response.headers.get('content-type'),
        contentLength: response.headers.get('content-length'),
        location: response.headers.get('location'),
        ...body,
      },
    };
  } catch (error) {
    return {
      data: {
        url: sanitizedUrl(parsed.url),
        method: parsed.method,
        reachable: false,
        durationMs: Math.round(performance.now() - started),
        timedOut:
          error instanceof Error &&
          (error.name === 'AbortError' || controller.signal.aborted),
        error: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function executeSystemCapability(
  capability: string,
  input: unknown,
): Promise<unknown> {
  switch (capability) {
    case 'machine.health':
      return await machineHealth(input);
    case 'network.dns.resolve':
      return await dnsResolve(input);
    case 'network.tcp.probe':
      return await tcpProbe(input);
    case 'network.http.probe':
      return await httpProbe(input);
    default:
      throw new Error(`Unsupported system capability: ${capability}`);
  }
}
