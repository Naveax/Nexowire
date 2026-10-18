import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyWindowsJobHelperBinary } from '../src/agent/windows-job-owner.js';
import { verifyWindowsKernelJob } from '../src/agent/windows-job-kernel-attestation.js';

test('helper-only replacement is rejected before any executable is launched', {
  skip: process.platform !== 'win32',
}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-job-trust-'));
  const helper = path.join(dir, 'windows-job-owner.exe');
  const manifest = path.join(dir, 'windows-job-owner.sha256');
  try {
    // Never execute either synthetic fixture.
    const approvedBytes = Buffer.from('reviewed helper fixture');
    await fs.writeFile(helper, approvedBytes);
    await fs.writeFile(manifest, createHash('sha256').update(approvedBytes).digest('hex'));
    await verifyWindowsJobHelperBinary(helper);
    await fs.writeFile(helper, Buffer.from('replacement with forged NWJOB4 marker'));
    await assert.rejects(
      () => verifyWindowsJobHelperBinary(helper),
      (error: unknown) => error instanceof Error &&
        'code' in error && error.code === 'WINDOWS_JOB_HELPER_UNTRUSTED',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('forged stdout/marker cannot prove Windows kernel Job ownership', {
  skip: process.platform !== 'win32',
  timeout: 15_000,
}, async () => {
  // Current test-runner PID, fake FILETIME and unallocated unique Job name.
  // This MUST fail even if a substituted helper emitted valid NWJOB4 syntax.
  // No process is spawned or terminated in this negative test.
  const unownedName = 'Local\\Nexowire-' + randomUUID();
  await assert.rejects(
    () => verifyWindowsKernelJob(process.pid, '133000000000000000', unownedName),
    /WINDOWS_JOB_KERNEL_ATTESTATION_FAILED/,
  );
});

test('helper path must not point through a symbolic link', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-job-link-'));
  try {
    const target = path.join(dir, 'target.exe');
    const helper = path.join(dir, 'windows-job-owner.exe');
    const bytes = Buffer.from('synthetic');
    await fs.writeFile(target, bytes);
    await fs.writeFile(path.join(dir, 'windows-job-owner.sha256'),
      createHash('sha256').update(bytes).digest('hex'));
    try {
      await fs.symlink(target, helper, 'file');
    } catch (error) {
      if (typeof error === 'object' && error && 'code' in error &&
          ['EPERM', 'EACCES'].includes(String(error.code))) {
        t.skip('Windows test account cannot create symbolic links');
        return;
      }
      throw error;
    }
    await assert.rejects(() => verifyWindowsJobHelperBinary(helper),
      (error: unknown) => error instanceof Error && 'code' in error &&
        error.code === 'WINDOWS_JOB_HELPER_UNTRUSTED');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('tagged production bundle fails closed without pinned Authenticode publisher', {
  skip: process.platform !== 'win32',
  timeout: 15_000,
}, async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-job-release-block-'));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_REF_TYPE: 'tag' };
    delete env.NEXOWIRE_WINDOWS_JOB_PUBLISHER_THUMBPRINT;
    const attempted = spawnSync(process.execPath,
      ['--import', 'tsx', 'scripts/build-windows-user-bundle.ts',
        '--output-dir', outputDir,
        '--source-sha', '0000000000000000000000000000000000000000'],
      { cwd: process.cwd(), env, windowsHide: true, encoding: 'utf8',
        timeout: 12_000, maxBuffer: 16_384 });
    assert.notEqual(attempted.status, 0);
    assert.match((attempted.stderr ?? '') + (attempted.stdout ?? ''),
      /WINDOWS_JOB_TRUSTED_PUBLISHER_NOT_CONFIGURED/);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
