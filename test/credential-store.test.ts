import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  CredentialStore,
  CredentialStoreError,
} from '../src/security/credential-store.js';
import { authorizeBearer } from '../src/security/auth.js';

test('credential store persists only hashes and supports live revocation refresh', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-credentials-'),
  );

  try {
    let now = Date.parse('2026-09-30T12:00:00.000Z');
    const clock = () => now;

    const writer = new CredentialStore(root, { now: clock });
    const reader = new CredentialStore(root, { now: clock });
    await Promise.all([writer.initialize(), reader.initialize()]);

    const issued = await writer.issue('mcp', {
      name: 'chatgpt-primary',
      ttlMs: 60_000,
    });

    assert.match(
      issued.token,
      /^nwx1\.mcp\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    );
    assert.equal(reader.verify('mcp', issued.token), true);
    assert.equal(reader.verify('agent', issued.token), false);
    assert.equal(reader.verify('mcp', 'wrong-token'), false);

    const raw = await fs.readFile(
      path.join(root, 'credentials.json'),
      'utf8',
    );
    assert.equal(raw.includes(issued.token), false);
    assert.equal(raw.includes('chatgpt-primary'), true);
    assert.match(raw, /"tokenHash": "[a-f0-9]{64}"/);

    const listed = reader.list({ scope: 'mcp' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, issued.credential.id);
    assert.equal(
      'tokenHash' in (listed[0] as unknown as Record<string, unknown>),
      false,
    );

    await writer.revoke(issued.credential.id);
    assert.equal(reader.verify('mcp', issued.token), false);
    assert.equal(reader.hasConfigured('mcp'), true);
    assert.equal(reader.hasUsable('mcp'), false);

    const all = reader.list({ includeRevoked: true });
    assert.equal(all[0]?.revokedAt !== undefined, true);

    if (process.platform !== 'win32') {
      const stat = await fs.stat(
        path.join(root, 'credentials.json'),
      );
      assert.equal(stat.mode & 0o777, 0o600);
    }

    now += 120_000;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('credential expiry and scope are enforced without plaintext persistence', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-credentials-expiry-'),
  );

  try {
    let now = Date.parse('2026-09-30T12:00:00.000Z');
    const store = new CredentialStore(root, {
      now: () => now,
    });
    await store.initialize();

    const issued = await store.issue('agent', {
      ttlMs: 1_000,
    });
    assert.equal(store.verify('agent', issued.token), true);
    assert.equal(store.verify('mcp', issued.token), false);

    now += 1_001;
    assert.equal(store.verify('agent', issued.token), false);
    assert.equal(store.hasUsable('agent'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('credential revoke is idempotent in time but rejects unknown IDs', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-credentials-revoke-'),
  );

  try {
    const store = new CredentialStore(root);
    await store.initialize();
    const issued = await store.issue('mcp');

    const first = await store.revoke(issued.credential.id);
    const second = await store.revoke(issued.credential.id);
    assert.equal(second.revokedAt, first.revokedAt);

    await assert.rejects(
      () =>
        store.revoke(
          'AAAAAAAAAAAA',
        ),
      (error: unknown) =>
        error instanceof CredentialStoreError &&
        error.code === 'CREDENTIAL_NOT_FOUND',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('authorization accepts static rotation tokens or active stored credentials', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-credentials-auth-'),
  );

  try {
    const store = new CredentialStore(root);
    await store.initialize();
    const issued = await store.issue('mcp');

    assert.equal(
      authorizeBearer(
        'Bearer legacy-token',
        'mcp',
        ['legacy-token'],
        store,
      ),
      true,
    );
    assert.equal(
      authorizeBearer(
        'Bearer ' + issued.token,
        'mcp',
        [],
        store,
      ),
      true,
    );
    assert.equal(
      authorizeBearer(
        'Bearer ' + issued.token,
        'agent',
        [],
        store,
      ),
      false,
    );

    await store.revoke(issued.credential.id);
    assert.equal(
      authorizeBearer(
        'Bearer ' + issued.token,
        'mcp',
        [],
        store,
      ),
      false,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
