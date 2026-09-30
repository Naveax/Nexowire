import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  protectWindowsUserSecret,
  unprotectWindowsUserSecret,
  WindowsDpapiError,
} from '../src/security/windows-dpapi.js';
import {
  loadOrCreatePrivilegedBrokerToken,
} from '../src/security/privileged-broker-secret.js';

test(
  'Windows DPAPI round-trips current-user secrets without plaintext persistence',
  { skip: process.platform !== 'win32' },
  async () => {
    const plaintext = 'nexowire-secret-' + Date.now();
    const ciphertext = await protectWindowsUserSecret(plaintext);

    assert.notEqual(ciphertext, plaintext);
    assert.ok(ciphertext.length > plaintext.length);
    assert.equal(
      await unprotectWindowsUserSecret(ciphertext),
      plaintext,
    );
  },
);

test(
  'privileged broker token is stable and stored only as DPAPI ciphertext',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'nexowire-dpapi-broker-'),
    );
    const file = path.join(root, 'broker-secret.json');

    try {
      const first = await loadOrCreatePrivilegedBrokerToken({
        file,
      });
      const second = await loadOrCreatePrivilegedBrokerToken({
        file,
      });

      assert.equal(second, first);
      assert.match(first, /^nwxpb1.[A-Za-z0-9_-]+$/);

      const raw = await fs.readFile(file, 'utf8');
      assert.equal(raw.includes(first), false);
      const decoded = JSON.parse(raw) as {
        version?: number;
        protection?: string;
        ciphertext?: string;
      };
      assert.equal(decoded.version, 1);
      assert.equal(
        decoded.protection,
        'windows-dpapi-current-user',
      );
      assert.equal(typeof decoded.ciphertext, 'string');
      assert.ok((decoded.ciphertext?.length ?? 0) > 20);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'automatic broker secret storage fails closed off Windows',
  { skip: process.platform === 'win32' },
  async () => {
    await assert.rejects(
      () =>
        loadOrCreatePrivilegedBrokerToken({
          file: path.join(
            os.tmpdir(),
            'nexowire-should-not-create.json',
          ),
        }),
      /requires Windows DPAPI/i,
    );

    await assert.rejects(
      () => protectWindowsUserSecret('secret'),
      (error: unknown) =>
        error instanceof WindowsDpapiError &&
        error.code === 'WINDOWS_DPAPI_REQUIRED',
    );
  },
);
