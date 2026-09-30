import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  CapabilityPolicyError,
  CapabilityPolicyStore,
} from '../src/security/capability-policy.js';

test('capability policies persist allow/deny profiles and device bindings', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-capability-policy-'),
  );

  try {
    const first = new CapabilityPolicyStore(root);
    await first.initialize();

    const profile = await first.setProfile('Windows-Safe', {
      allow: ['windows.*', 'files.read', 'files.read'],
      deny: ['windows.registry.*', 'windows.firewall.control'],
    });
    assert.equal(profile.name, 'windows-safe');
    assert.deepEqual(profile.allow, ['files.read', 'windows.*']);
    assert.deepEqual(profile.deny, [
      'windows.firewall.control',
      'windows.registry.*',
    ]);

    const binding = await first.bind('device-a', 'WINDOWS-SAFE');
    assert.equal(binding.profile, 'windows-safe');

    assert.deepEqual(
      await first.decision('device-a', 'windows.window.list'),
      {
        allowed: true,
        bound: true,
        profile: 'windows-safe',
        matchedAllow: 'windows.*',
      },
    );

    const registry = await first.decision(
      'device-a',
      'windows.registry.read',
    );
    assert.equal(registry.allowed, false);
    assert.equal(registry.matchedAllow, 'windows.*');
    assert.equal(registry.matchedDeny, 'windows.registry.*');

    const file = await first.decision('device-a', 'files.read');
    assert.equal(file.allowed, true);

    const write = await first.decision('device-a', 'files.write');
    assert.equal(write.allowed, false);
    assert.equal(write.bound, true);

    const unbound = await first.decision(
      'unbound-device',
      'windows.registry.delete',
    );
    assert.deepEqual(unbound, {
      allowed: true,
      bound: false,
    });

    const second = new CapabilityPolicyStore(root);
    await second.initialize();
    assert.equal(
      (await second.decision('device-a', 'windows.window.focus')).allowed,
      true,
    );
    await assert.rejects(
      () =>
        second.assertAllowed(
          'device-a',
          'windows.firewall.control',
        ),
      (error: unknown) =>
        error instanceof CapabilityPolicyError &&
        error.code === 'CAPABILITY_DENIED',
    );

    const deleted = await second.deleteProfile('windows-safe');
    assert.deepEqual(deleted, {
      name: 'windows-safe',
      deleted: true,
      removedBindings: 1,
    });
    assert.deepEqual(await second.listBindings(), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('capability policy deny rules override wildcard allows', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-capability-policy-deny-'),
  );

  try {
    const store = new CapabilityPolicyStore(root);
    await store.setProfile('guarded', {
      allow: ['*'],
      deny: ['shell.exec', 'process.*'],
    });
    await store.bind('device-a', 'guarded');

    assert.equal(
      (await store.decision('device-a', 'files.read')).allowed,
      true,
    );
    assert.equal(
      (await store.decision('device-a', 'shell.exec')).allowed,
      false,
    );
    assert.equal(
      (await store.decision('device-a', 'process.start')).allowed,
      false,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('capability policies reject missing profiles and invalid patterns', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-capability-policy-invalid-'),
  );

  try {
    const store = new CapabilityPolicyStore(root);

    await assert.rejects(
      () => store.bind('device-a', 'missing'),
      (error: unknown) =>
        error instanceof CapabilityPolicyError &&
        error.code === 'POLICY_PROFILE_NOT_FOUND',
    );

    await assert.rejects(() =>
      store.setProfile('empty', { allow: [] }),
    );
    await assert.rejects(() =>
      store.setProfile('unsafe', {
        allow: ['windows.**'],
      }),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
