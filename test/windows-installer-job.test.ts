import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
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


test('Windows installer helper runs a benign pinned .cmd without UAC and records exit', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-installer-helper-smoke-'),
  );
  try {
    const installerBytes = Buffer.from('@echo off\r\nexit /b 0\r\n', 'utf8');
    const file = path.join(root, 'package.cmd');
    await fs.writeFile(file, installerBytes);
    await fs.writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({
        version: 1,
        sha256: createHash('sha256').update(installerBytes).digest('hex'),
        extension: '.cmd',
        arguments: [],
        allow_unsigned: true,
        publisher_thumbprint: null,
        timeoutMs: 10_000,
      }),
    );
    const runner = path.join(root, 'run.ps1');
    await fs.writeFile(
      runner, renderVerifiedInstallerRunner(root), 'utf8',
    );
    const process = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', runner],
      { windowsHide: true, encoding: 'utf8', timeout: 20_000 },
    );
    assert.equal(process.status, 0, process.stderr || process.stdout);
    const saved = JSON.parse(
      (await fs.readFile(path.join(root, 'status.json'), 'utf8'))
        .replace(/^\uFEFF/, ''),
    ) as { state: string; exitCode: number };
    assert.equal(saved.state, 'succeeded');
    assert.equal(saved.exitCode, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test('Windows installer helper rejects a modified payload before execution', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-installer-hash-fail-'),
  );
  try {
    await fs.writeFile(path.join(root, 'package.cmd'), '@echo off\r\nexit /b 0\r\n');
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({
      version: 1, sha256: 'f'.repeat(64), extension: '.cmd',
      arguments: [], allow_unsigned: true, publisher_thumbprint: null,
      timeoutMs: 10_000,
    }));
    const runner = path.join(root, 'run.ps1');
    await fs.writeFile(runner, renderVerifiedInstallerRunner(root), 'utf8');
    const process = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner],
      { windowsHide: true, encoding: 'utf8', timeout: 20_000 },
    );
    assert.equal(process.status, 1);
    const saved = JSON.parse(
      (await fs.readFile(path.join(root, 'status.json'), 'utf8')).replace(/^\uFEFF/, ''),
    ) as { state: string; error: string };
    assert.equal(saved.state, 'failed');
    assert.match(saved.error, /SHA-256 mismatch/);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});
