import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  buildConnectApprovalUrl,
  connectNexowire,
  DEFAULT_HOSTED_CONTROL_PLANE_URL,
  normalizeControlPlaneUrl,
  parseConnectArgs,
  startConnectLoopbackReceiver,
} from '../src/connect.js';
import { writeProtectedSecretFile } from '../src/security/protected-secret-files.js';

test('control-plane URL requires HTTPS except loopback development', () => {
  assert.equal(
    normalizeControlPlaneUrl('https://example.com/'),
    'https://example.com',
  );
  assert.equal(
    normalizeControlPlaneUrl('http://127.0.0.1:8787/'),
    'http://127.0.0.1:8787',
  );
  assert.throws(
    () => normalizeControlPlaneUrl('http://example.com'),
    /must use HTTPS/,
  );
  assert.throws(
    () => normalizeControlPlaneUrl('https://user:pass@example.com'),
    /embedded credentials/,
  );
});

test('connect CLI defaults to hosted Nexowire and keeps advanced overrides', () => {
  assert.deepEqual(parseConnectArgs([], {}), {
    controlPlaneUrl: DEFAULT_HOSTED_CONTROL_PLANE_URL,
  });

  assert.deepEqual(
    parseConnectArgs([], {
      NEXOWIRE_CONTROL_PLANE_URL: 'https://example.com/',
    }),
    {
      controlPlaneUrl: 'https://example.com',
    },
  );

  assert.deepEqual(
    parseConnectArgs(
      ['--control-plane-url', 'https://override.example/'],
      { NEXOWIRE_CONTROL_PLANE_URL: 'https://env.example' },
    ),
    {
      controlPlaneUrl: 'https://override.example',
    },
  );

  assert.throws(
    () => parseConnectArgs(['--wat'], {}),
    /Unknown connect option/,
  );
});

test('approval URL only accepts a strict 127.0.0.1 callback', () => {
  const url = new URL(
    buildConnectApprovalUrl({
      controlPlaneUrl: 'https://example.com',
      callbackUrl:
        'http://127.0.0.1:43199/nexowire-connect',
      state: 'state-123',
      deviceId: '11111111-1111-4111-8111-111111111111',
      deviceName: 'gaming-pc',
      platform: 'win32',
    }),
  );

  assert.equal(url.origin, 'https://example.com');
  assert.equal(url.pathname, '/connect.html');
  assert.equal(
    url.searchParams.get('callback'),
    'http://127.0.0.1:43199/nexowire-connect',
  );
  assert.equal(url.searchParams.get('state'), 'state-123');
  assert.equal(
    url.searchParams.get('deviceId'),
    '11111111-1111-4111-8111-111111111111',
  );
  assert.equal(url.searchParams.get('deviceName'), 'gaming-pc');

  assert.throws(
    () =>
      buildConnectApprovalUrl({
        controlPlaneUrl: 'https://example.com',
        callbackUrl: 'https://evil.example/nexowire-connect',
        state: 'x',
        deviceId: '11111111-1111-4111-8111-111111111111',
        deviceName: 'pc',
        platform: 'win32',
      }),
    /127\.0\.0\.1/,
  );
});

test('loopback receiver rejects wrong state and accepts the matching state', async () => {
  const receiver = await startConnectLoopbackReceiver({
    state: 'expected-state',
    timeoutMs: 30_000,
  });

  try {
    const wrong = new URL(receiver.callbackUrl);
    wrong.searchParams.set('state', 'wrong');
    wrong.searchParams.set('pairing_id', 'pair-wrong');
    wrong.searchParams.set('token', 'token-wrong');
    const wrongResponse = await fetch(wrong);
    assert.equal(wrongResponse.status, 400);

    const good = new URL(receiver.callbackUrl);
    good.searchParams.set('state', 'expected-state');
    good.searchParams.set('pairing_id', 'pair-1');
    good.searchParams.set('token', 'token-1');
    const goodResponse = await fetch(good);
    assert.equal(goodResponse.status, 200);

    assert.deepEqual(await receiver.result, {
      pairingId: 'pair-1',
      token: 'token-1',
    });
  } finally {
    await receiver.close();
  }
});

test(
  'one-click connect verifies data-plane auth and stores the device credential with DPAPI',
  { skip: process.platform !== 'win32' },
  async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'nexowire-connect-'),
    );
    const anchorFile = path.join(
      dir,
      'device-anchor.dpapi.json',
    );
    const credentialFile = path.join(
      dir,
      'agent-bearer-token.dpapi.json',
    );
    const connectionFile = path.join(
      dir,
      'control-plane.json',
    );
    const identityFile = path.join(dir, 'agent.json');

    const env = {
      ...process.env,
      NEXOWIRE_DEVICE_ANCHOR_DPAPI_FILE: anchorFile,
      NEXOWIRE_AGENT_TOKEN_DPAPI_FILE: credentialFile,
      NEXOWIRE_CONTROL_PLANE_CONNECTION_FILE:
        connectionFile,
      NEXOWIRE_AGENT_IDENTITY_FILE: identityFile,
    };

    let consumeBody:
      | Record<string, unknown>
      | undefined;
    let approvalDeviceId: string | undefined;
    let enrolled:
      | {
          hubUrl: string;
          token: string;
          secretFile: string;
        }
      | undefined;

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      assert.equal(
        url,
        'https://example.com/api/v1/pairing/consume',
      );
      consumeBody = JSON.parse(
        String(init?.body ?? '{}'),
      ) as Record<string, unknown>;

      assert.ok(approvalDeviceId);
      return Response.json({
        device: {
          id: approvalDeviceId,
          name: 'gaming-pc',
          platform: 'win32',
        },
        deviceCredential:
          'nwx_dev_test-secret-that-must-not-leak',
        agentUrl: 'wss://relay.example.com/agent',
      });
    };

    const openBrowser = async (approvalUrl: string) => {
      const approval = new URL(approvalUrl);
      approvalDeviceId =
        approval.searchParams.get('deviceId') ?? undefined;
      assert.match(
        approvalDeviceId ?? '',
        /^[0-9a-f-]{36}$/i,
      );
      const callback = new URL(
        approval.searchParams.get('callback')!,
      );
      callback.searchParams.set(
        'state',
        approval.searchParams.get('state')!,
      );
      callback.searchParams.set(
        'pairing_id',
        'pairing-123',
      );
      callback.searchParams.set(
        'token',
        'nwx_pair_test',
      );
      const response = await fetch(callback);
      assert.equal(response.status, 200);
    };

    const enrollAgent = async (
      options: {
        hubUrl: string;
        secretFile?: string;
      },
      token: string,
    ) => {
      assert.ok(options.secretFile);
      enrolled = {
        hubUrl: options.hubUrl,
        token,
        secretFile: options.secretFile!,
      };
      await writeProtectedSecretFile(
        options.secretFile!,
        'agent-bearer-token',
        token,
        { overwrite: true },
      );
      return {
        enrolled: true as const,
        connectTest: {
          endpoint: options.hubUrl,
          reachable: true,
          authenticated: true,
          status: 'authenticated' as const,
          durationMs: 1,
        },
        lifecycle: {
          installed: true,
          platform: 'win32' as const,
          name: 'Nexowire Native Agent',
          state: 'running',
          autostart: true,
          pid: 123,
          launcher: 'launcher.ps1',
          definition: 'task',
        },
        doctor: {
          overall: 'PASS' as const,
        },
        externalVerificationRequired: true as const,
      } as any;
    };

    try {
      const result = await connectNexowire(
        {
          controlPlaneUrl: 'https://example.com',
          deviceName: 'gaming-pc',
        },
        {
          env,
          fetchImpl,
          openBrowser,
          enrollAgent: enrollAgent as any,
          now: () =>
            new Date('2026-10-02T12:00:00.000Z'),
        },
      );

      assert.deepEqual(result, {
        paired: true,
        controlPlaneUrl: 'https://example.com',
        agentUrl: 'wss://relay.example.com/agent',
        deviceId: approvalDeviceId,
        deviceName: 'gaming-pc',
        credentialStored: true,
        dataPlaneReady: true,
        authenticated: true,
        lifecycleState: 'running',
        doctorOverall: 'PASS',
      });

      assert.equal(
        consumeBody?.pairingId,
        'pairing-123',
      );
      assert.equal(
        consumeBody?.token,
        'nwx_pair_test',
      );
      assert.match(
        String(consumeBody?.deviceAnchorHash),
        /^[a-f0-9]{64}$/,
      );
      assert.deepEqual(enrolled, {
        hubUrl: 'wss://relay.example.com/agent',
        token: 'nwx_dev_test-secret-that-must-not-leak',
        secretFile: credentialFile,
      });

      const protectedCredential =
        await fs.readFile(credentialFile, 'utf8');
      assert.equal(
        protectedCredential.includes(
          'nwx_dev_test-secret-that-must-not-leak',
        ),
        false,
      );
      assert.match(
        protectedCredential,
        /windows-dpapi-current-user/,
      );

      const metadata =
        await fs.readFile(connectionFile, 'utf8');
      assert.equal(
        metadata.includes(
          'nwx_dev_test-secret-that-must-not-leak',
        ),
        false,
      );
      assert.ok(approvalDeviceId);
      assert.match(
        metadata,
        new RegExp(
          '"deviceId": "' + approvalDeviceId + '"',
        ),
      );
      assert.match(
        metadata,
        /"agentUrl": "wss:\/\/relay\.example\.com\/agent"/,
      );
    } finally {
      await fs.rm(dir, {
        recursive: true,
        force: true,
      });
    }
  },
);
