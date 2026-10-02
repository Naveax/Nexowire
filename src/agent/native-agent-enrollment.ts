import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {
  agentTokenFromEnv,
  parseHubEndpoints,
} from './native-agent.js';
import {
  installNativeAgentLifecycle,
  nativeAgentLifecycleStatus,
  type NativeAgentLifecycleStatus,
} from './native-agent-lifecycle.js';
import { parseAllowedRoots } from './path-policy.js';
import { discoverTailscale } from './tailscale-discovery.js';
import { writeProtectedSecretFile } from '../security/protected-secret-files.js';
import { NEXOWIRE_VERSION } from '../version.js';

export type AgentDoctorCheckStatus = 'PASS' | 'BLOCKED' | 'FAIL';

export interface AgentHubProbe {
  endpoint: string;
  reachable: boolean;
  authenticated: boolean;
  status:
    | 'authenticated'
    | 'unauthorized'
    | 'network-error'
    | 'timeout';
  httpStatus?: number;
  errorCategory?: 'dns' | 'tls' | 'tcp' | 'websocket' | 'timeout';
  error?: string;
  durationMs: number;
}

export interface AgentConnectionStatus {
  version: string;
  installed: boolean;
  serviceState: string;
  runtimeState: 'not-installed' | 'configured' | 'running';
  hubState:
    | 'not-configured'
    | 'invalid-configuration'
    | 'token-unavailable'
    | 'reachable-authenticated'
    | 'unauthorized'
    | 'unreachable'
    | 'not-probed';
  authenticated: boolean;
  activeConnectionVerified: false;
  deviceId: string | null;
  deviceName: string | null;
  launcher: string;
  hubEndpoints: string[];
  allowedRoots: string[];
  tokenSource: {
    configured: boolean;
    available: boolean;
    kind: 'dpapi-file' | 'file' | 'platform-store' | 'none';
    error: string | null;
  };
  probe: AgentHubProbe | null;
  tailscale: Awaited<ReturnType<typeof discoverTailscale>>;
  lastError: string | null;
}

export interface AgentDoctorCheck {
  id: string;
  status: AgentDoctorCheckStatus;
  summary: string;
  remediation?: string;
  details?: Record<string, unknown>;
}

export interface AgentDoctorReport {
  generatedAt: string;
  overall: AgentDoctorCheckStatus;
  status: AgentConnectionStatus;
  checks: AgentDoctorCheck[];
  externalVerification: {
    required: true;
    criteria: string[];
  };
}

export interface AgentEnrollOptions {
  hubUrl: string;
  deviceName?: string;
  allowedRoots?: string[];
  secretFile?: string;
  overwriteSecret?: boolean;
  skipConnectTest?: boolean;
  timeoutMs?: number;
}

const PLACEHOLDER_HOST_RE =
  /^(?:hub-adresi|hub-address|placeholder|example(?:\.com|\.org|\.net|\.test)?|your-hub(?:\..*)?)$/i;

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+[A-Za-z0-9._~+\/=:-]+/gi, 'Bearer <redacted>')
    .slice(0, 1000);
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function validateAgentHubUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Agent Hub WebSocket URL is required.');
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Agent Hub WebSocket URL is invalid.');
  }

  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('Agent Hub URL must use ws:// or wss://.');
  }
  if (url.username || url.password) {
    throw new Error('Agent Hub URL must not embed credentials.');
  }
  if (url.hash) {
    throw new Error('Agent Hub URL must not contain a fragment.');
  }
  if (
    PLACEHOLDER_HOST_RE.test(url.hostname) ||
    /hub-adresi/i.test(url.hostname)
  ) {
    throw new Error(
      'Agent Hub URL is a placeholder, not a deployable endpoint.',
    );
  }
  if (url.protocol === 'ws:' && !isLoopbackHost(url.hostname)) {
    throw new Error(
      'Remote Agent Hub endpoints must use wss://; ws:// is allowed only for loopback.',
    );
  }

  return url.toString();
}

export function parsePersistedLauncherEnvironment(
  content: string,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    let match = /^\$env:([A-Z0-9_]+)\s*=\s*'(.*)'$/i.exec(line);
    if (match) {
      env[match[1]!] = match[2]!.replaceAll("''", "'");
      continue;
    }

    match = /^export\s+([A-Z0-9_]+)\s*=\s*'(.*)'$/i.exec(line);
    if (match) {
      env[match[1]!] = match[2]!.replaceAll(`'"'"'`, "'");
    }
  }

  return env;
}

async function readLauncherEnvironment(
  launcher: string,
): Promise<Record<string, string>> {
  try {
    return parsePersistedLauncherEnvironment(
      await fs.readFile(launcher, 'utf8'),
    );
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return {};
    }
    throw error;
  }
}

function tokenSourceKind(
  env: NodeJS.ProcessEnv,
): AgentConnectionStatus['tokenSource']['kind'] {
  if (env.NEXOWIRE_AGENT_TOKEN_DPAPI_FILE?.trim()) return 'dpapi-file';
  if (env.NEXOWIRE_AGENT_TOKEN_FILE?.trim()) return 'file';
  if (env.NEXOWIRE_AGENT_TOKEN_PLATFORM_NAME?.trim()) {
    return 'platform-store';
  }
  return 'none';
}

function inspectTokenSource(env: NodeJS.ProcessEnv): {
  configured: boolean;
  available: boolean;
  kind: AgentConnectionStatus['tokenSource']['kind'];
  token?: string;
  error: string | null;
} {
  const kind = tokenSourceKind(env);
  if (kind === 'none') {
    return {
      configured: false,
      available: false,
      kind,
      error: null,
    };
  }

  try {
    const token = agentTokenFromEnv(env);
    return {
      configured: true,
      available: Boolean(token),
      kind,
      ...(token ? { token } : {}),
      error: token
        ? null
        : 'Configured secret source resolved to an empty value.',
    };
  } catch (error) {
    return {
      configured: true,
      available: false,
      kind,
      error: cleanError(error),
    };
  }
}

function classifySocketError(
  error: unknown,
): AgentHubProbe['errorCategory'] {
  const message = cleanError(error).toLowerCase();
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code).toUpperCase()
      : '';

  if (
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    message.includes('getaddrinfo')
  ) {
    return 'dns';
  }
  if (
    code.startsWith('ERR_TLS') ||
    message.includes('certificate') ||
    message.includes('tls') ||
    message.includes('ssl')
  ) {
    return 'tls';
  }
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH'
  ) {
    return 'tcp';
  }
  return 'websocket';
}

export async function probeAgentHub(
  endpointInput: string,
  token: string | undefined,
  timeoutMs = 5_000,
): Promise<AgentHubProbe> {
  const endpoint = validateAgentHubUrl(endpointInput);
  const boundedTimeout = Math.min(
    30_000,
    Math.max(250, Math.round(timeoutMs)),
  );
  const startedAt = Date.now();

  return await new Promise<AgentHubProbe>((resolve) => {
    let settled = false;
    let socket: WebSocket | undefined;
    let timer: NodeJS.Timeout | undefined;

    const finish = (
      result: Omit<AgentHubProbe, 'endpoint' | 'durationMs'>,
    ): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (socket?.readyState === WebSocket.OPEN) {
        socket.close(1000, 'Enrollment probe complete');
      } else {
        socket?.terminate();
      }
      resolve({
        endpoint,
        durationMs: Date.now() - startedAt,
        ...result,
      });
    };

    try {
      socket = new WebSocket(
        endpoint,
        token
          ? {
              headers: {
                Authorization: `Bearer ${token}`,
              },
            }
          : undefined,
      );
    } catch (error) {
      finish({
        reachable: false,
        authenticated: false,
        status: 'network-error',
        errorCategory: classifySocketError(error),
        error: cleanError(error),
      });
      return;
    }

    timer = setTimeout(() => {
      finish({
        reachable: false,
        authenticated: false,
        status: 'timeout',
        errorCategory: 'timeout',
        error: `WebSocket handshake exceeded ${boundedTimeout} ms.`,
      });
    }, boundedTimeout);
    timer.unref();

    socket.once('open', () => {
      finish({
        reachable: true,
        authenticated: true,
        status: 'authenticated',
      });
    });

    socket.once(
      'unexpected-response',
      (_request, response) => {
        const statusCode = response.statusCode;
        response.resume();
        finish({
          reachable: true,
          authenticated: false,
          status:
            statusCode === 401
              ? 'unauthorized'
              : 'network-error',
          httpStatus: statusCode,
          ...(statusCode === 401
            ? {}
            : {
                errorCategory: 'websocket' as const,
                error: `Unexpected HTTP status ${statusCode}.`,
              }),
        });
      },
    );

    socket.once('error', (error) => {
      finish({
        reachable: false,
        authenticated: false,
        status: 'network-error',
        errorCategory: classifySocketError(error),
        error: cleanError(error),
      });
    });
  });
}

async function readDeviceId(homeDir: string): Promise<string | null> {
  const file = path.join(homeDir, '.nexowire', 'agent.json');
  try {
    const parsed = JSON.parse(
      await fs.readFile(file, 'utf8'),
    ) as { id?: unknown };
    return typeof parsed.id === 'string' && parsed.id.trim()
      ? parsed.id.trim()
      : null;
  } catch {
    return null;
  }
}

function configuredEndpoints(env: NodeJS.ProcessEnv): {
  endpoints: string[];
  error: string | null;
} {
  const configured =
    Boolean(env.NEXOWIRE_HUB_WS_URL?.trim()) ||
    Boolean(env.NEXOWIRE_HUB_WS_URLS?.trim());

  if (!configured) {
    return { endpoints: [], error: null };
  }

  try {
    return {
      endpoints: parseHubEndpoints(env).map(validateAgentHubUrl),
      error: null,
    };
  } catch (error) {
    return {
      endpoints: [],
      error: cleanError(error),
    };
  }
}

function runtimeState(
  lifecycle: NativeAgentLifecycleStatus,
): AgentConnectionStatus['runtimeState'] {
  if (!lifecycle.installed) return 'not-installed';
  if (
    lifecycle.state === 'running' ||
    lifecycle.state.startsWith('active/')
  ) {
    return 'running';
  }
  return 'configured';
}

export async function getAgentConnectionStatus(
  options: {
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    probe?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<AgentConnectionStatus> {
  const processEnv = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const lifecycle = await nativeAgentLifecycleStatus({
    env: processEnv,
    homeDir,
  });
  const persisted = await readLauncherEnvironment(
    lifecycle.launcher,
  );
  const effectiveEnv: NodeJS.ProcessEnv = {
    ...processEnv,
    ...persisted,
  };
  const endpoints = configuredEndpoints(effectiveEnv);
  const tokenSource = inspectTokenSource(effectiveEnv);
  const tailscale = await discoverTailscale();

  let probe: AgentHubProbe | null = null;
  let hubState: AgentConnectionStatus['hubState'] = 'not-probed';
  let authenticated = false;
  let lastError: string | null = null;

  if (endpoints.error) {
    hubState = 'invalid-configuration';
    lastError = endpoints.error;
  } else if (endpoints.endpoints.length === 0) {
    hubState = 'not-configured';
  } else if (!tokenSource.available) {
    hubState = 'token-unavailable';
    lastError = tokenSource.error;
  } else if (options.probe !== false) {
    probe = await probeAgentHub(
      endpoints.endpoints[0]!,
      tokenSource.token,
      options.timeoutMs,
    );
    authenticated = probe.authenticated;
    hubState = probe.authenticated
      ? 'reachable-authenticated'
      : probe.status === 'unauthorized'
        ? 'unauthorized'
        : 'unreachable';
    lastError = probe.error ?? null;
  }

  return {
    version: NEXOWIRE_VERSION,
    installed: lifecycle.installed,
    serviceState: lifecycle.state,
    runtimeState: runtimeState(lifecycle),
    hubState,
    authenticated,
    activeConnectionVerified: false,
    deviceId: await readDeviceId(homeDir),
    deviceName:
      effectiveEnv.NEXOWIRE_DEVICE_NAME?.trim() ||
      (lifecycle.installed ? os.hostname() : null),
    launcher: lifecycle.launcher,
    hubEndpoints: endpoints.endpoints,
    allowedRoots: parseAllowedRoots(
      effectiveEnv.NEXOWIRE_ALLOWED_ROOTS,
      homeDir,
    ),
    tokenSource: {
      configured: tokenSource.configured,
      available: tokenSource.available,
      kind: tokenSource.kind,
      error: tokenSource.error,
    },
    probe,
    tailscale,
    lastError,
  };
}

function check(
  id: string,
  status: AgentDoctorCheckStatus,
  summary: string,
  remediation?: string,
  details?: Record<string, unknown>,
): AgentDoctorCheck {
  return {
    id,
    status,
    summary,
    ...(remediation ? { remediation } : {}),
    ...(details ? { details } : {}),
  };
}

export async function doctorAgentEnrollment(
  options: {
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    timeoutMs?: number;
  } = {},
): Promise<AgentDoctorReport> {
  const status = await getAgentConnectionStatus({
    ...options,
    probe: true,
  });
  const checks: AgentDoctorCheck[] = [];

  checks.push(
    status.installed
      ? check(
          'lifecycle',
          'PASS',
          'Native-agent lifecycle is installed.',
          undefined,
          {
            serviceState: status.serviceState,
            runtimeState: status.runtimeState,
          },
        )
      : check(
          'lifecycle',
          'FAIL',
          'Native-agent lifecycle is not installed.',
          'Run nexowire agent enroll.',
        ),
  );

  if (status.hubState === 'invalid-configuration') {
    checks.push(
      check(
        'hub-endpoint',
        'FAIL',
        'Persisted Hub endpoint is invalid or still a placeholder.',
        'Enroll with the real ws:// loopback or wss:// remote /agent endpoint.',
        { error: status.lastError },
      ),
    );
  } else if (status.hubEndpoints.length === 0) {
    checks.push(
      check(
        'hub-endpoint',
        'BLOCKED',
        'No persisted Hub endpoint is configured.',
        'Run nexowire agent enroll --hub-url <endpoint>.',
      ),
    );
  } else {
    checks.push(
      check(
        'hub-endpoint',
        'PASS',
        'Persisted Hub endpoint is syntactically deployable.',
        undefined,
        { endpoints: status.hubEndpoints },
      ),
    );
  }

  checks.push(
    status.tokenSource.available
      ? check(
          'agent-credential',
          'PASS',
          'Protected native-agent credential source is readable.',
          undefined,
          { kind: status.tokenSource.kind },
        )
      : check(
          'agent-credential',
          status.tokenSource.configured ? 'FAIL' : 'BLOCKED',
          status.tokenSource.configured
            ? 'Configured native-agent credential source is unavailable.'
            : 'No protected native-agent credential source is configured.',
          'Use nexowire agent enroll so the token is sealed without appearing in argv or launcher text.',
          {
            kind: status.tokenSource.kind,
            error: status.tokenSource.error,
          },
        ),
  );

  if (status.probe) {
    checks.push(
      status.probe.authenticated
        ? check(
            'hub-websocket-auth',
            'PASS',
            'Hub accepted the protected agent credential.',
            undefined,
            {
              durationMs: status.probe.durationMs,
            },
          )
        : check(
            'hub-websocket-auth',
            'FAIL',
            status.probe.status === 'unauthorized'
              ? 'Hub rejected the native-agent credential.'
              : 'Hub WebSocket endpoint could not be reached.',
            status.probe.status === 'unauthorized'
              ? 'Issue or recover a valid agent credential and enroll again.'
              : 'Fix DNS/TLS/TCP/Tailscale reachability, then rerun nexowire agent doctor.',
            {
              status: status.probe.status,
              httpStatus: status.probe.httpStatus,
              errorCategory: status.probe.errorCategory,
              error: status.probe.error,
            },
          ),
    );
  } else {
    checks.push(
      check(
        'hub-websocket-auth',
        'BLOCKED',
        'Hub authentication probe could not run because prerequisites are incomplete.',
      ),
    );
  }

  checks.push(
    status.tailscale.installed && status.tailscale.running
      ? check(
          'tailscale',
          'PASS',
          'Tailscale is installed and connected.',
          undefined,
          {
            dnsName: status.tailscale.dnsName,
            ipv4: status.tailscale.ipv4,
            serveConfigured:
              status.tailscale.serveConfigured,
            funnelConfigured:
              status.tailscale.funnelConfigured,
          },
        )
      : check(
          'tailscale',
          'BLOCKED',
          status.tailscale.installed
            ? 'Tailscale is installed but not connected.'
            : 'Tailscale is not installed.',
          'Connect Tailscale before using the easy private-network path.',
        ),
  );

  checks.push(
    check(
      'mcp-registration',
      'BLOCKED',
      'Local checks cannot prove ChatGPT/MCP device registration.',
      'Enrollment is complete only after devices_list shows this stable device online and machine_snapshot plus machine_health succeed.',
      { deviceId: status.deviceId },
    ),
  );

  const overall = checks.some(
    (entry) => entry.status === 'FAIL',
  )
    ? 'FAIL'
    : checks.some((entry) => entry.status === 'BLOCKED')
      ? 'BLOCKED'
      : 'PASS';

  return {
    generatedAt: new Date().toISOString(),
    overall,
    status,
    checks,
    externalVerification: {
      required: true,
      criteria: [
        'devices_list shows the stable device ID online',
        'machine_snapshot succeeds through Nexowire MCP',
        'machine_health succeeds through Nexowire MCP',
        'autostart/reconnect is verified after the Hub path is live',
      ],
    },
  };
}

function parseTimeout(raw: string | undefined): number {
  if (!raw) throw new Error('--timeout-ms requires a value.');
  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < 250 ||
    value > 30_000
  ) {
    throw new Error(
      '--timeout-ms must be an integer between 250 and 30000.',
    );
  }
  return value;
}

export function parseAgentEnrollArgs(
  args: readonly string[],
): AgentEnrollOptions {
  const options: Partial<AgentEnrollOptions> = {};
  const allowedRoots: string[] = [];

  const valueAfter = (index: number, name: string): string => {
    const value = args[index + 1]?.trim();
    if (!value || value.startsWith('--')) {
      throw new Error(name + ' requires a value.');
    }
    return value;
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;

    if (arg === '--overwrite-secret') {
      options.overwriteSecret = true;
      continue;
    }
    if (arg === '--skip-connect-test') {
      options.skipConnectTest = true;
      continue;
    }
    if (
      arg === '--token' ||
      arg.startsWith('--token=') ||
      arg === '--bearer' ||
      arg.startsWith('--bearer=')
    ) {
      throw new Error(
        'Bearer tokens are never accepted as command-line arguments.',
      );
    }

    if (arg === '--hub-url') {
      options.hubUrl = valueAfter(index, arg);
      index++;
      continue;
    }
    if (arg.startsWith('--hub-url=')) {
      options.hubUrl = arg.slice('--hub-url='.length);
      continue;
    }
    if (arg === '--device-name') {
      options.deviceName = valueAfter(index, arg);
      index++;
      continue;
    }
    if (arg.startsWith('--device-name=')) {
      options.deviceName = arg.slice('--device-name='.length);
      continue;
    }
    if (arg === '--allow-root') {
      allowedRoots.push(valueAfter(index, arg));
      index++;
      continue;
    }
    if (arg.startsWith('--allow-root=')) {
      allowedRoots.push(arg.slice('--allow-root='.length));
      continue;
    }
    if (arg === '--secret-file') {
      options.secretFile = valueAfter(index, arg);
      index++;
      continue;
    }
    if (arg.startsWith('--secret-file=')) {
      options.secretFile = arg.slice('--secret-file='.length);
      continue;
    }
    if (arg === '--timeout-ms') {
      options.timeoutMs = parseTimeout(
        valueAfter(index, arg),
      );
      index++;
      continue;
    }
    if (arg.startsWith('--timeout-ms=')) {
      options.timeoutMs = parseTimeout(
        arg.slice('--timeout-ms='.length),
      );
      continue;
    }

    throw new Error('Unknown agent enroll option: ' + arg);
  }

  if (!options.hubUrl?.trim()) {
    throw new Error(
      'agent enroll requires --hub-url <ws://.../agent|wss://.../agent>.',
    );
  }

  options.hubUrl = validateAgentHubUrl(options.hubUrl);
  if (allowedRoots.length > 0) {
    options.allowedRoots = [
      ...new Set(
        allowedRoots.map((entry) => path.resolve(entry)),
      ),
    ];
  }

  return options as AgentEnrollOptions;
}

async function readSecretFromStdin(
  maxBytes = 1_048_576,
): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new Error(
        'Agent credential input exceeds the 1 MiB bound.',
      );
    }
    chunks.push(buffer);
  }
  const value = Buffer.concat(chunks)
    .toString('utf8')
    .trim();
  if (!value) {
    throw new Error('Agent credential input is empty.');
  }
  return value;
}

async function readHiddenSecret(
  prompt: string,
): Promise<string> {
  if (
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    !process.stdin.setRawMode
  ) {
    return await readSecretFromStdin();
  }

  process.stdout.write(prompt);
  const stdin = process.stdin;
  const previousRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();

  return await new Promise<string>((resolve, reject) => {
    let value = '';

    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode?.(previousRaw ?? false);
      stdin.pause();
      process.stdout.write('\n');
    };

    const onData = (chunk: Buffer | string): void => {
      const text = Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : chunk;
      for (const char of text) {
        if (char === '\u0003') {
          cleanup();
          reject(
            new Error('Agent enrollment cancelled.'),
          );
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          const trimmed = value.trim();
          if (!trimmed) {
            reject(
              new Error(
                'Agent credential input is empty.',
              ),
            );
          } else {
            resolve(trimmed);
          }
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
        if (
          Buffer.byteLength(value, 'utf8') >
          1_048_576
        ) {
          cleanup();
          reject(
            new Error(
              'Agent credential input exceeds the 1 MiB bound.',
            ),
          );
          return;
        }
      }
    };

    stdin.on('data', onData);
  });
}

export async function enrollNativeAgent(
  options: AgentEnrollOptions,
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  enrolled: true;
  connectTest: AgentHubProbe | null;
  lifecycle: NativeAgentLifecycleStatus;
  doctor: AgentDoctorReport;
  externalVerificationRequired: true;
}> {
  if (process.platform !== 'win32') {
    throw new Error(
      'agent enroll currently uses Windows CurrentUser DPAPI and is Windows-only.',
    );
  }

  const hubUrl = validateAgentHubUrl(options.hubUrl);
  const deviceName =
    options.deviceName?.trim() || os.hostname();
  if (!deviceName || deviceName.length > 128) {
    throw new Error(
      'Device name must be 1-128 characters.',
    );
  }

  const timeoutMs = options.timeoutMs ?? 5_000;
  const connectTest = options.skipConnectTest
    ? null
    : await probeAgentHub(hubUrl, token, timeoutMs);

  if (connectTest && !connectTest.authenticated) {
    throw new Error(
      connectTest.status === 'unauthorized'
        ? 'Hub rejected the supplied agent credential; enrollment was not persisted.'
        : `Hub connection test failed (${connectTest.errorCategory ?? connectTest.status}); enrollment was not persisted.`,
    );
  }

  const secretFile = path.resolve(
    options.secretFile ??
      path.join(
        os.homedir(),
        '.nexowire',
        'secrets',
        'agent-bearer-token.dpapi.json',
      ),
  );

  await writeProtectedSecretFile(
    secretFile,
    'agent-bearer-token',
    token,
    {
      overwrite:
        options.overwriteSecret === true,
    },
  );

  const lifecycleEnv: NodeJS.ProcessEnv = {
    ...env,
    NEXOWIRE_HUB_WS_URL: hubUrl,
    NEXOWIRE_DEVICE_NAME: deviceName,
    NEXOWIRE_ALLOWED_ROOTS: (
      options.allowedRoots?.length
        ? options.allowedRoots
        : [os.homedir()]
    ).join(path.delimiter),
    NEXOWIRE_AGENT_TOKEN_DPAPI_FILE: secretFile,
  };
  delete lifecycleEnv.NEXOWIRE_AGENT_TOKEN;
  delete lifecycleEnv.NEXOWIRE_AGENT_TOKENS;
  delete lifecycleEnv.NEXOWIRE_AGENT_TOKEN_FILE;
  delete lifecycleEnv.NEXOWIRE_AGENT_TOKEN_PLATFORM_NAME;

  const lifecycle =
    await installNativeAgentLifecycle({
      env: lifecycleEnv,
    });

  const doctor = await doctorAgentEnrollment({
    env,
    timeoutMs,
  });

  return {
    enrolled: true,
    connectTest,
    lifecycle,
    doctor,
    externalVerificationRequired: true,
  };
}

function parseProbeArgs(
  args: readonly string[],
): {
  probe: boolean;
  timeoutMs?: number;
} {
  const result: {
    probe: boolean;
    timeoutMs?: number;
  } = { probe: true };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--no-probe') {
      result.probe = false;
      continue;
    }
    if (arg === '--timeout-ms') {
      result.timeoutMs = parseTimeout(
        args[index + 1],
      );
      index++;
      continue;
    }
    if (arg.startsWith('--timeout-ms=')) {
      result.timeoutMs = parseTimeout(
        arg.slice('--timeout-ms='.length),
      );
      continue;
    }
    throw new Error(
      'Unknown agent status/doctor option: ' + arg,
    );
  }

  return result;
}

export async function runNativeAgentEnrollmentCommand(
  args: readonly string[],
): Promise<void> {
  const action = args[0] ?? 'status';

  if (action === 'status') {
    const options = parseProbeArgs(args.slice(1));
    const result = await getAgentConnectionStatus(
      options,
    );
    process.stdout.write(
      JSON.stringify(result, null, 2) + '\n',
    );
    return;
  }

  if (action === 'doctor') {
    const options = parseProbeArgs(args.slice(1));
    const report = await doctorAgentEnrollment(
      options,
    );
    process.stdout.write(
      JSON.stringify(report, null, 2) + '\n',
    );
    if (report.overall !== 'PASS') {
      process.exitCode = 2;
    }
    return;
  }

  if (action === 'enroll') {
    const options = parseAgentEnrollArgs(
      args.slice(1),
    );
    const token = await readHiddenSecret(
      'Native-agent bearer token (hidden): ',
    );
    const result = await enrollNativeAgent(
      options,
      token,
    );
    process.stdout.write(
      JSON.stringify(result, null, 2) + '\n',
    );
    if (result.doctor.overall !== 'PASS') {
      process.exitCode = 2;
    }
    return;
  }

  throw new Error(
    'Usage: nexowire agent [run|enroll|doctor|status|install|start|stop|restart|uninstall]',
  );
}
