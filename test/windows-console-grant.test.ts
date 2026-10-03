import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPhysicalConsoleGrant,
  physicalConsoleGrantStatus,
  requestPhysicalConsoleGrant,
  requiresPhysicalConsoleGrant,
  revokePhysicalConsoleGrant,
} from '../src/agent/windows-console-grant.js';
import {
  capabilitiesForPlatform,
  isReadOnlyCapability,
} from '../src/protocol/capabilities.js';

test('physical console mutations are default-denied while private input stays isolated', () => {
  revokePhysicalConsoleGrant();

  for (const capability of [
    'windows.window.focus',
    'windows.clipboard.write',
    'windows.clipboard.clear',
    'windows.keyboard.type',
    'windows.keyboard.hotkey',
    'windows.pointer.move',
    'windows.pointer.click',
    'windows.pointer.scroll',
    'windows.accessibility.invoke',
    'windows.accessibility.set_value',
    'windows.private_desktop.show',
  ]) {
    assert.equal(
      requiresPhysicalConsoleGrant(capability),
      true,
      capability,
    );
    assert.throws(
      () => assertPhysicalConsoleGrant(capability),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'PHYSICAL_CONSOLE_GRANT_REQUIRED',
      capability,
    );
  }

  for (const capability of [
    'windows.screenshot',
    'windows.clipboard.read',
    'windows.window.list',
    'windows.private_pointer.move',
    'windows.private_pointer.click',
    'windows.private_keyboard.type',
    'windows.private_keyboard.hotkey',
    'windows.console_control.status',
    'windows.console_control.request',
    'windows.console_control.revoke',
  ]) {
    assert.equal(
      requiresPhysicalConsoleGrant(capability),
      false,
      capability,
    );
  }

  assert.deepEqual(
    physicalConsoleGrantStatus(),
    {
      active: false,
      grantId: null,
      grantedAt: null,
      expiresAt: null,
      remainingMs: 0,
      durationMinutes: null,
    },
  );
});

test('console-control status is read-only and Windows advertises grant capabilities', () => {
  assert.equal(
    isReadOnlyCapability(
      'windows.console_control.status',
    ),
    true,
  );
  assert.equal(
    isReadOnlyCapability(
      'windows.console_control.request',
    ),
    false,
  );
  assert.equal(
    isReadOnlyCapability(
      'windows.console_control.revoke',
    ),
    false,
  );

  const capabilities = new Set(
    capabilitiesForPlatform('win32'),
  );
  for (const capability of [
    'windows.private_desktop.show',
    'windows.console_control.status',
    'windows.console_control.request',
    'windows.console_control.revoke',
  ]) {
    assert.equal(
      capabilities.has(capability),
      true,
      capability,
    );
  }
});

test(
  'local approval creates a bounded grant that expires and can be denied',
  { skip: process.platform !== 'win32' },
  async () => {
    revokePhysicalConsoleGrant();

    const base = new Date(
      '2030-01-01T00:00:00.000Z',
    );
    const approved =
      await requestPhysicalConsoleGrant(
        {
          duration_minutes: 1,
          reason: 'test approval',
        },
        {
          now: () => base,
          decisionProvider: async (input) => {
            assert.equal(
              input.durationMinutes,
              1,
            );
            assert.equal(
              input.reason,
              'test approval',
            );
            return true;
          },
          timeoutMs: 1_000,
        },
      );

    assert.equal(approved.approved, true);
    assert.equal(approved.status.active, true);
    assert.equal(
      approved.status.durationMinutes,
      1,
    );
    assert.equal(
      approved.status.remainingMs,
      60_000,
    );
    assert.doesNotThrow(() =>
      assertPhysicalConsoleGrant(
        'windows.pointer.click',
        new Date(
          base.getTime() + 30_000,
        ),
      ),
    );

    assert.throws(
      () =>
        assertPhysicalConsoleGrant(
          'windows.pointer.click',
          new Date(
            base.getTime() + 60_001,
          ),
        ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code ===
          'PHYSICAL_CONSOLE_GRANT_REQUIRED',
    );

    const deniedAt = new Date(
      base.getTime() + 120_000,
    );
    const denied =
      await requestPhysicalConsoleGrant(
        {
          duration_minutes: 5,
          reason: 'test denial',
        },
        {
          now: () => deniedAt,
          decisionProvider: async () => false,
          timeoutMs: 1_000,
        },
      );
    assert.equal(denied.approved, false);
    assert.equal(denied.status.active, false);

    const revoked =
      revokePhysicalConsoleGrant();
    assert.equal(revoked.status.active, false);
  },
);
