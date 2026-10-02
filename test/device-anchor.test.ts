import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  deriveDeviceAnchorHash,
  getOrCreateDeviceAnchor,
} from '../src/agent/device-anchor.js';

test('device anchor hash is deterministic and does not reveal the secret', () => {
  const secret = 'example-device-anchor-secret';
  const first = deriveDeviceAnchorHash(secret);
  const second = deriveDeviceAnchorHash(secret);

  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first.includes(secret), false);
});

test(
  'Windows device anchor persists through DPAPI without exposing plaintext',
  { skip: process.platform !== 'win32' },
  async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'nexowire-device-anchor-'),
    );
    const file = path.join(dir, 'anchor.dpapi.json');
    const env = {
      ...process.env,
      NEXOWIRE_DEVICE_ANCHOR_DPAPI_FILE: file,
    };

    try {
      const first = await getOrCreateDeviceAnchor(env);
      const second = await getOrCreateDeviceAnchor(env);

      assert.equal(first.anchorHash, second.anchorHash);
      assert.equal(first.storageFile, path.resolve(file));

      const raw = await fs.readFile(file, 'utf8');
      assert.equal(raw.includes(first.anchorHash), false);
      assert.match(raw, /windows-dpapi-current-user/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
