import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAgentEnrollArgs,
  parsePersistedLauncherEnvironment,
  validateAgentHubUrl,
} from '../src/agent/native-agent-enrollment.js';

test('agent hub URL validation rejects placeholders and insecure remote ws', () => {
  assert.throws(
    () => validateAgentHubUrl('wss://HUB-ADRESI/agent'),
    /placeholder/,
  );
  assert.throws(
    () => validateAgentHubUrl('ws://10.0.0.2:43110/agent'),
    /wss:\/\//,
  );
  assert.equal(
    validateAgentHubUrl('ws://127.0.0.1:43110/agent'),
    'ws://127.0.0.1:43110/agent',
  );
  assert.equal(
    validateAgentHubUrl('wss://hub.example.net/agent'),
    'wss://hub.example.net/agent',
  );
});

test('persisted launcher parser reads PowerShell and shell environment references', () => {
  const parsed = parsePersistedLauncherEnvironment([
    "$env:NEXOWIRE_DEVICE_NAME='work-pc'",
    "$env:NEXOWIRE_HUB_WS_URL='wss://work-pc.example/agent'",
    "export NEXOWIRE_ALLOWED_ROOTS='/home/operator'",
  ].join('\n'));

  assert.deepEqual(parsed, {
    NEXOWIRE_DEVICE_NAME: 'work-pc',
    NEXOWIRE_HUB_WS_URL: 'wss://work-pc.example/agent',
    NEXOWIRE_ALLOWED_ROOTS: '/home/operator',
  });
});

test('agent enroll parser refuses secret argv and normalizes bounded options', () => {
  assert.throws(
    () =>
      parseAgentEnrollArgs([
        '--hub-url',
        'wss://hub.example.net/agent',
        '--token',
        'secret',
      ]),
    /never accepted/,
  );

  const parsed = parseAgentEnrollArgs([
    '--hub-url=wss://hub.example.net/agent',
    '--device-name',
    'work-pc',
    '--allow-root',
    '.',
    '--timeout-ms=2500',
    '--overwrite-secret',
  ]);

  assert.equal(parsed.hubUrl, 'wss://hub.example.net/agent');
  assert.equal(parsed.deviceName, 'work-pc');
  assert.equal(parsed.timeoutMs, 2500);
  assert.equal(parsed.overwriteSecret, true);
  assert.equal(parsed.allowedRoots?.length, 1);
});
