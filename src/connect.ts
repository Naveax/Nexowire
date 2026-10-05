import {
  randomBytes,
} from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import { getOrCreateDeviceAnchor } from './agent/device-anchor.js';
import {
  enrollNativeAgent,
  validateAgentHubUrl,
} from './agent/native-agent-enrollment.js';
import { loadOrCreateAgentIdentity } from './agent/native-agent.js';

const execFileAsync = promisify(execFile);
const CONNECT_CALLBACK_PATH = '/nexowire-connect';
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_HOSTED_CONTROL_PLANE_URL =
  'https://nexowire-control-plane.nexowire-naveax.workers.dev';

export interface ConnectCliOptions {
  controlPlaneUrl: string;
  deviceName?: string;
  timeoutMs?: number;
  noBrowser?: boolean;
}

export interface ConnectApprovalResult {
  pairingId: string;
  token: string;
}

export interface ControlPlaneRegisteredDevice {
  id: string;
  name: string;
  platform: string;
}

export interface ConnectResult {
  paired: true;
  controlPlaneUrl: string;
  agentUrl: string;
  deviceId: string;
  deviceName: string;
  credentialStored: true;
  dataPlaneReady: true;
  authenticated: true;
  lifecycleState: string;
  doctorOverall: 'PASS' | 'BLOCKED' | 'FAIL';
}

export interface ConnectRuntime {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  openBrowser?: (url: string) => Promise<void>;
  now?: () => Date;
  enrollAgent?: typeof enrollNativeAgent;
}

function positiveTimeout(value: string): number {
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < 30_000 ||
    parsed > 15 * 60_000
  ) {
    throw new Error(
      '--timeout-ms must be an integer between 30000 and 900000.',
    );
  }
  return parsed;
}

export function normalizeControlPlaneUrl(
  input: string,
): string {
  const raw = input.trim();
  if (!raw) {
    throw new Error('Control-plane URL is empty.');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Control-plane URL is invalid.');
  }

  if (url.username || url.password) {
    throw new Error(
      'Control-plane URL must not contain embedded credentials.',
    );
  }
  if (url.search || url.hash) {
    throw new Error(
      'Control-plane URL must not contain a query string or fragment.',
    );
  }

  const local =
    url.hostname === '127.0.0.1' ||
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1';

  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error(
      'Control-plane URL must use HTTPS except for loopback development.',
    );
  }

  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function parseConnectArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ConnectCliOptions {
  const options: Partial<ConnectCliOptions> = {};

  const valueAfter = (index: number, name: string): string => {
    const value = args[index + 1]?.trim();
    if (!value || value.startsWith('--')) {
      throw new Error(name + ' requires a value.');
    }
    return value;
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--no-browser') {
      options.noBrowser = true;
      continue;
    }
    if (arg === '--control-plane-url') {
      options.controlPlaneUrl = valueAfter(index, arg);
      index++;
      continue;
    }
    if (arg.startsWith('--control-plane-url=')) {
      options.controlPlaneUrl =
        arg.slice('--control-plane-url='.length);
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
    if (arg === '--timeout-ms') {
      options.timeoutMs = positiveTimeout(
        valueAfter(index, arg),
      );
      index++;
      continue;
    }
    if (arg.startsWith('--timeout-ms=')) {
      options.timeoutMs = positiveTimeout(
        arg.slice('--timeout-ms='.length),
      );
      continue;
    }
    throw new Error('Unknown connect option: ' + arg);
  }

  const configured =
    options.controlPlaneUrl ??
    env.NEXOWIRE_CONTROL_PLANE_URL?.trim() ??
    DEFAULT_HOSTED_CONTROL_PLANE_URL;

  return {
    controlPlaneUrl: normalizeControlPlaneUrl(configured),
    ...(options.deviceName
      ? { deviceName: options.deviceName }
      : {}),
    ...(options.timeoutMs
      ? { timeoutMs: options.timeoutMs }
      : {}),
    ...(options.noBrowser
      ? { noBrowser: true }
      : {}),
  };
}

function defaultCredentialFile(
  env: NodeJS.ProcessEnv,
): string {
  return path.resolve(
    env.NEXOWIRE_AGENT_TOKEN_DPAPI_FILE?.trim() ||
      env.NEXOWIRE_CONTROL_PLANE_DEVICE_CREDENTIAL_DPAPI_FILE?.trim() ||
      path.join(
        os.homedir(),
        '.nexowire',
        'secrets',
        'agent-bearer-token.dpapi.json',
      ),
  );
}

function defaultConnectionFile(
  env: NodeJS.ProcessEnv,
): string {
  return path.resolve(
    env.NEXOWIRE_CONTROL_PLANE_CONNECTION_FILE?.trim() ||
      path.join(
        os.homedir(),
        '.nexowire',
        'control-plane.json',
      ),
  );
}

function boundedDeviceName(input: string): string {
  const value = input.trim();
  if (!value || value.length > 128) {
    throw new Error('Device name must be 1-128 characters.');
  }
  return value;
}

export function buildConnectApprovalUrl(input: {
  controlPlaneUrl: string;
  callbackUrl: string;
  state: string;
  deviceId: string;
  deviceName: string;
  platform: string;
}): string {
  const base = normalizeControlPlaneUrl(input.controlPlaneUrl);
  const callback = new URL(input.callbackUrl);
  if (
    callback.protocol !== 'http:' ||
    callback.hostname !== '127.0.0.1' ||
    callback.pathname !== CONNECT_CALLBACK_PATH
  ) {
    throw new Error(
      'Connect callback must be an http://127.0.0.1 loopback URL.',
    );
  }

  const url = new URL('/connect.html', base + '/');
  url.searchParams.set('callback', callback.toString());
  url.searchParams.set('state', input.state);
  url.searchParams.set('deviceId', input.deviceId);
  url.searchParams.set(
    'deviceName',
    boundedDeviceName(input.deviceName),
  );
  url.searchParams.set('platform', input.platform);
  return url.toString();
}

async function openDefaultBrowser(url: string): Promise<void> {
  if (process.platform === 'win32') {
    await execFileAsync(
      'rundll32.exe',
      ['url.dll,FileProtocolHandler', url],
      {
        windowsHide: true,
      },
    );
    return;
  }

  if (process.platform === 'darwin') {
    await execFileAsync('open', [url]);
    return;
  }

  await execFileAsync('xdg-open', [url]);
}

export async function startConnectLoopbackReceiver(input: {
  state: string;
  timeoutMs?: number;
}): Promise<{
  callbackUrl: string;
  result: Promise<ConnectApprovalResult>;
  close: () => Promise<void>;
}> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let resolveResult:
    | ((value: ConnectApprovalResult) => void)
    | undefined;
  let rejectResult:
    | ((reason: Error) => void)
    | undefined;

  const result = new Promise<ConnectApprovalResult>(
    (resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    },
  );

  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  const server = createServer((request, response) => {
    try {
      const url = new URL(
        request.url ?? '/',
        'http://127.0.0.1',
      );
      if (url.pathname !== CONNECT_CALLBACK_PATH) {
        response.writeHead(404, {
          'content-type': 'text/plain; charset=utf-8',
        });
        response.end('Not found');
        return;
      }

      const state = url.searchParams.get('state') ?? '';
      const pairingId =
        url.searchParams.get('pairing_id') ?? '';
      const token = url.searchParams.get('token') ?? '';

      if (
        state !== input.state ||
        !pairingId ||
        !token
      ) {
        response.writeHead(400, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(
          'Nexowire connection callback was rejected.',
        );
        return;
      }

      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(
        '<!doctype html><meta charset="utf-8"><title>Nexowire</title><body style="font-family:system-ui;background:#090b10;color:#fff;padding:48px"><h1>Bağlandı ✓</h1><p>Nexowire hazır. Bu sekmeyi kapatabilirsin.</p><script>setTimeout(()=>window.close(),900)</script></body>',
      );

      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        resolveResult?.({ pairingId, token });
      }
    } catch (error) {
      response.writeHead(400, {
        'content-type': 'text/plain; charset=utf-8',
      });
      response.end('Invalid callback');
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        rejectResult?.(
          error instanceof Error
            ? error
            : new Error(String(error)),
        );
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (
    !address ||
    typeof address === 'string'
  ) {
    server.close();
    throw new Error('Could not create loopback callback listener.');
  }

  timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectResult?.(
      new Error('Timed out waiting for Nexowire browser approval.'),
    );
    server.close();
  }, timeoutMs);
  timer.unref?.();

  return {
    callbackUrl:
      'http://127.0.0.1:' +
      address.port +
      CONNECT_CALLBACK_PATH,
    result,
    close: async () => {
      if (timer) clearTimeout(timer);
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    },
  };
}

async function consumePairing(input: {
  fetchImpl: typeof fetch;
  controlPlaneUrl: string;
  approval: ConnectApprovalResult;
  platform: string;
  deviceAnchorHash: string;
}): Promise<{
  device: ControlPlaneRegisteredDevice;
  deviceCredential: string;
  agentUrl: string;
}> {
  const response = await input.fetchImpl(
    input.controlPlaneUrl +
      '/api/v1/pairing/consume',
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pairingId: input.approval.pairingId,
        token: input.approval.token,
        platform: input.platform,
        deviceAnchorHash: input.deviceAnchorHash,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      'Control plane rejected pairing consume (HTTP ' +
        response.status +
        ').',
    );
  }

  const body = await response.json() as {
    device?: ControlPlaneRegisteredDevice;
    deviceCredential?: string;
    agentUrl?: string;
  };

  if (
    !body.device ||
    typeof body.device.id !== 'string' ||
    typeof body.device.name !== 'string' ||
    typeof body.deviceCredential !== 'string' ||
    !body.deviceCredential.startsWith('nwx_dev_') ||
    typeof body.agentUrl !== 'string'
  ) {
    throw new Error(
      'Control plane returned an invalid device enrollment response.',
    );
  }

  return {
    device: body.device,
    deviceCredential: body.deviceCredential,
    agentUrl: validateAgentHubUrl(body.agentUrl),
  };
}

async function writeConnectionMetadata(input: {
  file: string;
  controlPlaneUrl: string;
  agentUrl: string;
  device: ControlPlaneRegisteredDevice;
  credentialFile: string;
  anchorFile: string;
  connectedAt: string;
}): Promise<void> {
  await fs.mkdir(path.dirname(input.file), {
    recursive: true,
    mode: 0o700,
  });

  const temp =
    input.file +
    '.tmp-' +
    process.pid +
    '-' +
    randomBytes(4).toString('hex');

  await fs.writeFile(
    temp,
    JSON.stringify(
      {
        version: 1,
        controlPlaneUrl: input.controlPlaneUrl,
        agentUrl: input.agentUrl,
        deviceId: input.device.id,
        deviceName: input.device.name,
        credentialFile: input.credentialFile,
        anchorFile: input.anchorFile,
        connectedAt: input.connectedAt,
      },
      null,
      2,
    ) + '\n',
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );
  await fs.rename(temp, input.file);
}

export async function connectNexowire(
  options: ConnectCliOptions,
  runtime: ConnectRuntime = {},
): Promise<ConnectResult> {
  if (process.platform !== 'win32') {
    throw new Error(
      'One-click Nexowire connection currently requires Windows DPAPI.',
    );
  }

  const env = runtime.env ?? process.env;
  const fetchImpl = runtime.fetchImpl ?? fetch;
  const opener = runtime.openBrowser ?? openDefaultBrowser;
  const enrollAgent =
    runtime.enrollAgent ?? enrollNativeAgent;
  const controlPlaneUrl = normalizeControlPlaneUrl(
    options.controlPlaneUrl,
  );
  const deviceName = boundedDeviceName(
    options.deviceName?.trim() || os.hostname(),
  );
  const [anchor, identity] = await Promise.all([
    getOrCreateDeviceAnchor(env),
    loadOrCreateAgentIdentity(env),
  ]);
  const state = randomBytes(32).toString('base64url');
  const receiver = await startConnectLoopbackReceiver({
    state,
    timeoutMs: options.timeoutMs,
  });

  try {
    const approvalUrl = buildConnectApprovalUrl({
      controlPlaneUrl,
      callbackUrl: receiver.callbackUrl,
      state,
      deviceId: identity.id,
      deviceName,
      platform: process.platform,
    });

    if (options.noBrowser) {
      process.stdout.write(
        JSON.stringify(
          {
            browserApprovalRequired: true,
            approvalUrl,
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      await opener(approvalUrl);
    }

    const approval = await receiver.result;
    const registered = await consumePairing({
      fetchImpl,
      controlPlaneUrl,
      approval,
      platform: process.platform,
      deviceAnchorHash: anchor.anchorHash,
    });

    const credentialFile = defaultCredentialFile(env);
    const enrollment = await enrollAgent(
      {
        hubUrl: registered.agentUrl,
        deviceName: registered.device.name,
        allowedRoots: [os.homedir()],
        secretFile: credentialFile,
        overwriteSecret: true,
        timeoutMs: Math.min(
          options.timeoutMs ?? 5_000,
          15_000,
        ),
      },
      registered.deviceCredential,
      env,
    );

    if (
      !enrollment.connectTest ||
      enrollment.connectTest.authenticated !== true
    ) {
      throw new Error(
        'Native agent enrollment did not verify the data-plane credential.',
      );
    }

    const connectedAt = (
      runtime.now?.() ?? new Date()
    ).toISOString();
    await writeConnectionMetadata({
      file: defaultConnectionFile(env),
      controlPlaneUrl,
      agentUrl: registered.agentUrl,
      device: registered.device,
      credentialFile,
      anchorFile: anchor.storageFile,
      connectedAt,
    });

    return {
      paired: true,
      controlPlaneUrl,
      agentUrl: registered.agentUrl,
      deviceId: registered.device.id,
      deviceName: registered.device.name,
      credentialStored: true,
      dataPlaneReady: true,
      authenticated: true,
      lifecycleState: enrollment.lifecycle.state,
      doctorOverall: enrollment.doctor.overall,
    };
  } finally {
    await receiver.close();
  }
}

export async function runConnectCommand(
  args: readonly string[],
): Promise<void> {
  const options = parseConnectArgs(args);
  const result = await connectNexowire(options);
  process.stdout.write(
    JSON.stringify(result, null, 2) + '\n',
  );
}

