import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  buildConnectApprovalUrl,
  connectNexowire,
  normalizeControlPlaneUrl,
  parseConnectArgs,
  startConnectLoopbackReceiver,
} from '../src/connect.js';

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

test('connect CLI accepts env URL and rejects unknown flags', () => {
  assert.deepEqual(
    parseConnectArgs([], {
      NEXOWIRE_CONTROL_PLANE_URL: 'https://example.com/',
    }),
    {
      controlPlaneUrl: 'https://example.com',
    },
  );

  assert.throws(
    () => parseConnectArgs(['--wat'], {
      NEXOWIRE_CONTROL_PLANE_URL: 'https://example.com',
    }),
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
  assert.equal(url.searchParams.get('deviceName'), 'gaming-pc');

  assert.throws(
    () =>
      buildConnectApprovalUrl({
        controlPlaneUrl: 'https://example.com',
        callbackUrl: 'https://evil.example/nexowire-connect',
        state: 'x',
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
  'one-click connect stores device credential with DPAPI and never exposes it in result',
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
      'device-credential.dpapi.json',
    );
    const connectionFile = path.join(
      dir,
      'control-plane.json',
    );

    const env = {
      ...process.env,
      NEXOWIRE_DEVICE_ANCHOR_DPAPI_FILE: anchorFile,
      NEXOWIRE_CONTROL_PLANE_DEVICE_CREDENTIAL_DPAPI_FILE:
        credentialFile,
      NEXOWIRE_CONTROL_PLANE_CONNECTION_FILE:
        connectionFile,
    };

    let consumeBody:
      | Record<string, unknown>
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

      return Response.json({
        device: {
          id: 'device-123',
          name: 'gaming-pc',
          platform: 'win32',
        },
        deviceCredential:
          'nwx_dev_test-secret-that-must-not-leak',
      });
    };

    const openBrowser = async (approvalUrl: string) => {
      const approval = new URL(approvalUrl);
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
          now: () =>
            new Date('2026-10-02T12:00:00.000Z'),
        },
      );

      assert.deepEqual(result, {
        paired: true,
        controlPlaneUrl: 'https://example.com',
        deviceId: 'device-123',
        deviceName: 'gaming-pc',
        credentialStored: true,
        dataPlaneReady: false,
        next: 'data-plane-enrollment',
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
      assert.match(metadata, /"deviceId": "device-123"/);
    } finally {
      await fs.rm(dir, {
        recursive: true,
        force: true,
      });
    }
  },
);
