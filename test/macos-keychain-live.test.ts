import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  PlatformSecretError,
  PlatformSecretStore,
} from '../src/security/platform-secret-store.js';

const enabled =
  process.platform === 'darwin' &&
  process.env.NEXOWIRE_LIVE_MACOS_KEYCHAIN_TEST === '1';

test(
  'macOS Keychain write/read/overwrite/delete uses the real first-party backend',
  { skip: !enabled, timeout: 30_000 },
  async (t) => {
    const store = new PlatformSecretStore({
      platform: 'darwin',
    });
    const suffix = randomUUID();
    const reference = {
      purpose: 'ci-keychain-write',
      name: 'nexowire-' + suffix,
    };
    const first = 'nwx-ci-first-' + suffix;
    const second = 'nwx-ci-second-' + suffix;

    t.after(async () => {
      try {
        await store.delete(reference);
      } catch {
        // Best-effort cleanup if the test failed mid-write.
      }
    });

    assert.equal(store.status(reference).present, false);

    await store.write(reference, first);
    assert.equal(store.status(reference).present, true);
    assert.equal(store.readSync(reference), first);

    await assert.rejects(
      () => store.write(reference, 'must-not-replace'),
      (error: unknown) =>
        error instanceof PlatformSecretError &&
        error.code === 'PLATFORM_SECRET_EXISTS',
    );
    assert.equal(store.readSync(reference), first);

    await store.write(reference, second, {
      overwrite: true,
    });
    assert.equal(store.readSync(reference), second);

    assert.equal(await store.delete(reference), true);
    assert.equal(store.status(reference).present, false);
    assert.equal(await store.delete(reference), false);
  },
);
