import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseS3BinaryVerificationArgs } from '../scripts/verify-windows-agent-binary.js';
import {
  inspectSignedWindowsBinary,
  validateWindowsBinaryTrustPins,
  type WindowsBinaryTrustPins,
} from '../scripts/s3-windows-binary-trust.js';

const notepad = 'C:\\Windows\\System32\\notepad.exe';
const blankPins: WindowsBinaryTrustPins = {
  filePath: notepad, expectedSha256: 'a'.repeat(64),
  expectedCertificateSha256: 'b'.repeat(64),
  expectedPublisherSubject: 'CN=Production Pinned Publisher',
};
test('read-only verifier requires strict local Windows path and real trust pins', () => {
  for (const filePath of ['\\\\evil\\payload.exe', 'relative\\payload.exe',
    'C:\\evil.exe:alternate', 'C:\\broken\\new\nline.exe', '\\\\?\\C:\\Windows\\notepad.exe']) {
    assert.throws(() => validateWindowsBinaryTrustPins({ ...blankPins, filePath }), /S3_BINARY_PATH_INVALID/);
  }
  assert.throws(() => validateWindowsBinaryTrustPins({
    ...blankPins, expectedSha256: 'wrong',
  }), /S3_BINARY_PIN_INVALID/);
  assert.throws(() => inspectSignedWindowsBinary(blankPins, 'linux'), /S3_BINARY_WINDOWS_REQUIRED/);
});

function observeWindowsSigner(filePath: string): {
  expectedCertificateSha256: string;
  expectedPublisherSubject: string;
} {
  const script = [
    "$ErrorActionPreference='Stop'",
    '$s=Get-AuthenticodeSignature -LiteralPath ' + "'" + filePath.replaceAll("'", "''") + "'",
    "if($s.Status -ne 'Valid'){throw 'SIGNED_WINDOWS_BINARY_NOT_AVAILABLE'}",
    '$h=[Security.Cryptography.SHA256]::Create()',
    'try{$c=([BitConverter]::ToString($h.ComputeHash($s.SignerCertificate.RawData))).Replace("-","").ToLowerInvariant()}finally{$h.Dispose()}',
    '[pscustomobject]@{cert=$c;subject=$s.SignerCertificate.Subject}|ConvertTo-Json -Compress',
  ].join(';');
  const result = spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
    });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as { cert: string; subject: string };
  return {
    expectedCertificateSha256: parsed.cert,
    expectedPublisherSubject: parsed.subject,
  };
}

test('real Windows signed OS executable: correct pin succeeds and forged pins fail', {
  skip: process.platform !== 'win32',
}, async () => {
  const cert = observeWindowsSigner(notepad);
  const fileSha256 = createHash('sha256').update(await fs.readFile(notepad)).digest('hex');
  const pins: WindowsBinaryTrustPins = {
    filePath: notepad, expectedSha256: fileSha256,
    expectedCertificateSha256: cert.expectedCertificateSha256,
    expectedPublisherSubject: cert.expectedPublisherSubject,
  };
  const valid = inspectSignedWindowsBinary(pins);
  assert.deepEqual(valid, {
    status: 'signature_verified',
    fileSha256, certificateSha256: cert.expectedCertificateSha256,
    publisherSubject: cert.expectedPublisherSubject,
    safeToExecute: false, productionModified: false,
  });
  assert.throws(() => inspectSignedWindowsBinary({
    ...pins, expectedSha256: '0'.repeat(64),
  }), /S3_BINARY_HASH_MISMATCH/);
  assert.throws(() => inspectSignedWindowsBinary({
    ...pins, expectedPublisherSubject: 'CN=Some Other Vendor',
  }), /S3_BINARY_PUBLISHER_MISMATCH/);
  assert.throws(() => inspectSignedWindowsBinary({
    ...pins, expectedCertificateSha256: '0'.repeat(64),
  }), /S3_BINARY_CERTIFICATE_MISMATCH/);
});

test('unsigned local payload cannot be mistaken for a trusted publisher', {
  skip: process.platform !== 'win32',
}, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-s3-unsigned-'));
  try {
    const filePath = path.join(tmp, 'unsigned.exe');
    const bytes = Buffer.from('UNSIGNED_ONLY_NEVER_EXECUTE');
    await fs.writeFile(filePath, bytes);
    const cert = observeWindowsSigner(notepad);
    assert.throws(() => inspectSignedWindowsBinary({
      filePath, expectedSha256: createHash('sha256').update(bytes).digest('hex'),
      expectedCertificateSha256: cert.expectedCertificateSha256,
      expectedPublisherSubject: cert.expectedPublisherSubject,
    }), /S3_BINARY_BAD_SIGNATURE/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});


test('read-only CLI requires explicit four independent pins and rejects ambiguity', () => {
  const values = ['--file', notepad, '--sha256', 'a'.repeat(64),
    '--cert-sha256', 'b'.repeat(64), '--subject', 'CN=Pinned Organization'];
  assert.deepEqual(parseS3BinaryVerificationArgs(values), {
    ...blankPins, expectedPublisherSubject: 'CN=Pinned Organization',
  });
  for (const broken of [
    values.slice(0, 6),
    [...values, '--sha256', '0'.repeat(64)],
    ['--file', notepad, '--sha256', 'a'.repeat(64), '--subject', 'CN=Vendor', '--hidden', 'evil'],
    ['--file', notepad, '--sha256', 'a'.repeat(64), '--cert-sha256', 'b'.repeat(64), '--subject'],
  ]) {
    assert.throws(() => parseS3BinaryVerificationArgs(broken), /S3_BINARY_ARGUMENTS_INVALID/);
  }
});

test('tampered signed executable fails native Authenticode despite matching new hash', {
  skip: process.platform !== 'win32',
}, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-s3-tamper-'));
  try {
    const dest = path.join(tmp, 'changed-notepad.exe');
    await fs.copyFile(notepad, dest);
    await fs.appendFile(dest, Buffer.from('CHANGED_S3_TEST_ONLY'));
    const cert = observeWindowsSigner(notepad);
    const sha = createHash('sha256').update(await fs.readFile(dest)).digest('hex');
    assert.throws(() => inspectSignedWindowsBinary({
      filePath: dest, expectedSha256: sha,
      expectedCertificateSha256: cert.expectedCertificateSha256,
      expectedPublisherSubject: cert.expectedPublisherSubject,
    }), /S3_BINARY_BAD_SIGNATURE/);
  } finally {
    await fs.rm(tmp, {recursive: true, force: true});
  }
});
