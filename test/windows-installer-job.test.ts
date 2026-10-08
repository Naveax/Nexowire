import test from 'node:test';
import assert from 'node:assert/strict';
import { PathPolicy } from '../src/agent/path-policy.js';
import { executeCapability } from '../src/agent/executors.js';
import type { PrivilegedBrokerClient } from '../src/agent/privileged-broker-client.js';
import {
  validateInstallerInput,
  renderVerifiedInstallerRunner,
} from '../src/agent/windows-installer-job.js';
import {
  privilegeRequirement,
  isPrivilegedBrokerCapability,
} from '../src/security/privilege.js';
import { capabilitiesForPlatform } from '../src/protocol/capabilities.js';
import { isMcpToolAuthorized } from '../src/security/tool-authorization.js';

const sha256 = 'a'.repeat(64);

test('trusted installer validates a local hash-pinned package with bounded args', () => {
  const input = validateInstallerInput({
    file_path: 'C:\\Users\\Example\\Downloads\\trusted-setup.exe',
    sha256,
    arguments: ['/quiet', '/norestart'],
  });
  assert.equal(input.allow_unsigned, false);
  assert.equal(input.timeout_seconds, 600);
  assert.deepEqual(input.arguments, ['/quiet', '/norestart']);
  assert.throws(
    () => validateInstallerInput({
      file_path: 'C:\\Users\\Example\\Downloads\\install.txt',
      sha256,
    }),
    /Installer must be/,
  );
  assert.throws(
    () => validateInstallerInput({
      file_path: 'C:\\Users\\Example\\Downloads\\installer.exe',
      sha256: 'not-a-digest',
    }),
  );
  assert.throws(
    () => validateInstallerInput({
      file_path: 'C:\\Users\\Example\\Downloads\\install.ps1',
      sha256, arguments: ['"; whoami'],
    }),
  );
  assert.throws(
    () => validateInstallerInput({
      file_path: 'C:\\Users\\Example\\Downloads\\install.exe',
      sha256, allow_unsigned: true, publisher_thumbprint: 'b'.repeat(40),
    }),
    /Do not specify both/,
  );
});

test('broker installer runner stages only pinned bytes, never clicks UAC', () => {
  const script = renderVerifiedInstallerRunner(
    'C:\\ProgramData\\Nexowire\\verified-installers\\0a3fbac5-5b23-4fd4-9239-6a1f12bdf980',
  );
  assert.match(script, /Get-FileHash -LiteralPath \$pkg -Algorithm SHA256/);
  assert.match(script, /Get-AuthenticodeSignature/);
  assert.match(script, /Installer Authenticode signature is not valid/);
  assert.match(script, /Unexpected installer signer certificate/);
  assert.match(script, /Start-Process -FilePath \$program/);
  assert.match(script, /WaitForExit/);
  assert.match(script, /Stop-Process -Id \$process.Id/);
  assert.match(script, /Write-State "failed"/);
  assert.match(script, /Write-State "succeeded"/);
  assert.doesNotMatch(script, /-Verb\s+RunAs|consent\.exe|Invoke-Expression|iex\s/i);
});

test('installer capabilities require elevated Broker and stay Windows-only', () => {
  for (const cap of ['windows.installer.apply', 'windows.installer.status']) {
    assert.equal(privilegeRequirement(cap, {}), 'elevated');
    assert.equal(isPrivilegedBrokerCapability(cap), true);
    assert.ok(capabilitiesForPlatform('win32').includes(cap));
    assert.equal(capabilitiesForPlatform('linux').includes(cap), false);
  }
  assert.equal(isPrivilegedBrokerCapability('shell.exec'), false);
  assert.equal(privilegeRequirement('shell.exec', {}), 'standard');
});

test('SAFE mode and missing Broker fail before dispatching elevated installer', async () => {
  const policy = new PathPolicy(['*']);
  const payload = { file_path: 'C:\\Users\\Example\\Downloads\\setup.exe', sha256 };
  let calls = 0;
  const broker = {
    execute: async () => { calls++; return { scheduled: true }; },
  } as unknown as PrivilegedBrokerClient;
  await assert.rejects(
    () => executeCapability('windows.installer.apply', payload, policy, {
      accessMode: 'safe', privilegeMode: 'broker', privilegedBroker: broker,
    }),
    /owner FULL mode/,
  );
  await assert.rejects(
    () => executeCapability('windows.installer.apply', payload, policy, {
      accessMode: 'full', privilegeMode: 'direct', privilegedBroker: broker,
    }),
    /owner FULL mode/,
  );
  assert.equal(calls, 0);
  const result = await executeCapability(
    'windows.installer.apply', payload, policy, {
      accessMode: 'full', privilegeMode: 'broker', privilegedBroker: broker,
    },
  );
  assert.deepEqual(result, { scheduled: true });
  assert.equal(calls, 1);
});

test('SAFE mode may inspect existing installer job only through Broker', async () => {
  const policy = new PathPolicy(['*']);
  const broker = {
    execute: async (cap: string) => ({ capability: cap, state: 'queued' }),
  } as unknown as PrivilegedBrokerClient;
  const status = await executeCapability(
    'windows.installer.status',
    { job_id: '0a3fbac5-5b23-4fd4-9239-6a1f12bdf980' },
    policy,
    { accessMode: 'safe', privilegeMode: 'broker', privilegedBroker: broker },
  );
  assert.deepEqual(status, {
    capability: 'windows.installer.status', state: 'queued',
  });
  await assert.rejects(
    () => executeCapability(
      'windows.installer.status', { job_id: 'x' },
      policy, { accessMode: 'safe', privilegeMode: 'direct' },
    ),
    /existing privileged Broker/,
  );
});
