import test from 'node:test';
import assert from 'node:assert/strict';
import { PathPolicy } from '../src/agent/path-policy.js';
import { executeCapability } from '../src/agent/executors.js';
import type { PrivilegedBrokerClient } from '../src/agent/privileged-broker-client.js';
import { inspectWindowsUacStatus } from '../src/agent/windows-uac-status.js';
import {
  capabilitiesForPlatform,
  isReadOnlyCapability,
} from '../src/protocol/capabilities.js';
import { requiredCapabilityForMcpTool } from '../src/mcp/tool-capabilities.js';

const elevated = {
  probe: async () => ({ reachable: true, elevated: true, version: '1.0.5' }),
} as Pick<PrivilegedBrokerClient, 'probe'>;

test('UAC status detects a possible consent dialog but never clicks it', async () => {
  const result = await inspectWindowsUacStatus({
    platform: 'win32',
    accessMode: 'full',
    consentCount: async () => 1,
    broker: elevated,
  });
  assert.equal(result.observation, 'pending');
  assert.equal(result.consentProcessCount, 1);
  assert.equal(result.brokerElevated, true);
  assert.equal(result.autoClickConsentSupported, false);
  assert.equal(result.recommendedAction, 'use_preapproved_installer_broker');
  assert.match(result.message, /existing secure desktop dialog is not controlled/);
});

test('SAFE with consent.exe pending cannot auto-route to elevated execution', async () => {
  const result = await inspectWindowsUacStatus({
    platform: 'win32',
    accessMode: 'safe',
    consentCount: async () => 1,
    broker: elevated,
  });
  assert.equal(result.recommendedAction, 'local_user_consent_required');
  assert.equal(result.autoClickConsentSupported, false);
});

test('FULL without elevated Broker never suggests automated privileged execution', async () => {
  const result = await inspectWindowsUacStatus({
    platform: 'win32',
    accessMode: 'full',
    consentCount: async () => 2,
    broker: {
      probe: async () => ({
        reachable: true, elevated: false, version: '1.0.4',
      }),
    } as Pick<PrivilegedBrokerClient, 'probe'>,
  });
  assert.equal(result.brokerElevated, false);
  assert.equal(result.recommendedAction, 'local_user_consent_required');
});

test('inaccessible or failed UAC process inspection is unknown, never clear', async () => {
  const result = await inspectWindowsUacStatus({
    platform: 'win32',
    accessMode: 'full',
    consentCount: async () => { throw new Error('Access denied'); },
    broker: elevated,
  });
  assert.equal(result.observation, 'unknown');
  assert.equal(result.consentProcessCount, null);
  assert.equal(result.recommendedAction, 'investigate_process_visibility');
});

test('absence of consent is only a point-in-time observation', async () => {
  const result = await inspectWindowsUacStatus({
    platform: 'win32',
    accessMode: 'safe',
    consentCount: async () => 0,
  });
  assert.equal(result.observation, 'clear');
  assert.equal(result.recommendedAction, 'no_uac_prompt_detected');
  assert.match(result.message, /point-in-time observation/);
});

test('UAC status is Windows-only and read-only, not an elevation grant', async () => {
  assert.ok(capabilitiesForPlatform('win32').includes('windows.uac.status'));
  assert.ok(!capabilitiesForPlatform('linux').includes('windows.uac.status'));
  assert.equal(isReadOnlyCapability('windows.uac.status'), true);
  assert.equal(requiredCapabilityForMcpTool('windows_uac_status'), 'windows.uac.status');
  await assert.rejects(
    () => inspectWindowsUacStatus({
      platform: 'linux', accessMode: 'full', consentCount: async () => 0,
    }),
    /requires a Windows agent/,
  );
  const policy = new PathPolicy(['*']);
  if (process.platform !== 'win32') {
    await assert.rejects(
      () => executeCapability('windows.uac.status', {}, policy, {
        accessMode: 'full',
      }),
      /requires a Windows agent/,
    );
  }
});
