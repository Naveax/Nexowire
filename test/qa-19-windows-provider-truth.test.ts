import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync, type SpawnSyncReturns} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// QA19 independent source/OS-provider witness; never invoke a fixture .exe.
// All writes (including the synthetic DACL) are confined to unique TEMP trees.
// The existing #576 tests deliberately remain unchanged and failing where red.
const win = process.platform === 'win32';
type Audit = {
  kind: string;
  companionManifestMatches: boolean;
  authenticodeStatus: string;
  authenticodeEvidenceAvailable: boolean;
  authenticodeEvidenceError: string;
  publisherValid: boolean;
  externallyPinnedPublisherMatches: boolean;
  externallyPinnedReleaseSha256Matches: boolean;
  aclEvidenceAvailable: boolean;
  fileAclProtected: boolean;
  parentAclProtected: boolean;
  broadWriteGrantFound: boolean | null;
  parentBroadWriteGrantFound: boolean | null;
  provisionalFileTrustChecksPassed: boolean;
  signedReleaseManifestVerified: boolean;
  runningImageFileIdentityVerified: boolean;
  productionReady: boolean;
};
type NativeWitness = {
  signatureStatus: string;
  signerThumbprint: string;
  parentProtected: boolean;
  fileProtected: boolean;
  parentBroadModify: boolean;
};
const scriptPath = path.resolve('scripts/audit-windows-job-helper-trust.ps1');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";

function run(exe: string, args: string[], timeout = 18_000): SpawnSyncReturns<string> {
  return spawnSync(exe, args, {
    encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 64 * 1024,
  });
}
function mustSucceed(out: SpawnSyncReturns<string>, label: string): string {
  assert.equal(out.error, undefined, label + ': spawn failure ' + String(out.error));
  assert.equal(out.status, 0, label + ': ' + (out.stderr ?? '').slice(0, 2400));
  return (out.stdout ?? '').trim();
}
function audit(image: string, pinnedSha = '', publisher = ''): Audit {
  const raw = mustSucceed(run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-File', scriptPath,
    '-HelperPath', image,
    '-ExpectedReleaseSha256', pinnedSha,
    '-ExpectedPublisherThumbprint', publisher,
  ]), 'Windows Job native audit');
  const data = JSON.parse(raw) as Audit;
  assert.equal(data.kind, 'windows_job_helper_trust_audit_v1');
  return data;
}
function encodedPowerShell(command: string, exe = 'powershell.exe'): string {
  return mustSucceed(run(exe, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(command, 'utf16le').toString('base64'),
  ]), exe + ' encoded probe');
}
function nativeWitness(image: string): NativeWitness {
  // Runs in a fresh pwsh process. Source of truth is native OS provider and
  // .NET Windows ACL, NOT user-supplied cmdlet functions, JSON or a sha256 file.
  const parent = path.dirname(image);
  const cmd = [
    "$ErrorActionPreference='Stop'",
    'Import-Module Microsoft.PowerShell.Security -ErrorAction Stop',
    '$auth=Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath ' + quote(image) + ' -ErrorAction Stop',
    '$file=[IO.FileSystemAclExtensions]::GetAccessControl([IO.FileInfo]::new(' + quote(image) + '))',
    '$dir=[IO.FileSystemAclExtensions]::GetAccessControl([IO.DirectoryInfo]::new(' + quote(parent) + '))',
    "$unsafe=@('S-1-1-0','S-1-5-11','S-1-5-32-545','S-1-5-4','S-1-5-7')",
    '$mask=0x2 -bor 0x4 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000',
    '$bad=$false',
    'foreach($ace in $dir.Access){',
    " if($ace.AccessControlType -ne 'Allow'){continue}",
    ' $sid=try {$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value} catch {$ace.IdentityReference.Value}',
    ' if(($sid -in $unsafe) -and (([int64]$ace.FileSystemRights -band $mask) -ne 0)){$bad=$true}',
    '}',
    '[ordered]@{',
    ' signatureStatus=[string]$auth.Status',
    " signerThumbprint=$(if($auth.SignerCertificate){[string]$auth.SignerCertificate.Thumbprint}else{''})",
    ' parentProtected=[bool]$dir.AreAccessRulesProtected',
    ' fileProtected=[bool]$file.AreAccessRulesProtected',
    ' parentBroadModify=[bool]$bad',
    '} | ConvertTo-Json -Compress',
  ].join('\n');
  return JSON.parse(encodedPowerShell(cmd, 'pwsh.exe')) as NativeWitness;
}
async function tempFixture(bytes: Buffer): Promise<{
  dir: string; image: string; manifest: string; pinned: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-qa19-truth-'));
  const image = path.join(dir, 'windows-job-owner.exe');
  const manifest = path.join(dir, 'windows-job-owner.sha256');
  const pinned = sha(bytes);
  await fs.writeFile(image, bytes);
  await fs.writeFile(manifest, pinned + '\n');
  return {dir, image, manifest, pinned};
}
async function removeFixture(dir: string): Promise<void> {
  await fs.rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
}
function assertNoProductionTrust(observed: Audit): void {
  assert.equal(observed.productionReady, false);
  assert.equal(observed.signedReleaseManifestVerified, false);
  assert.equal(observed.runningImageFileIdentityVerified, false);
}

test('QA19 native Windows signed surrogate versus unavailable PowerShell provider is not a forged PASS', {
  skip: !win, timeout: 40_000,
}, async () => {
  const source = path.join(process.env.SystemRoot ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const fixture = await tempFixture(await fs.readFile(source));
  try {
    const native = nativeWitness(fixture.image);
    assert.equal(native.signatureStatus, 'Valid',
      'independent Windows Authenticode provider did not validate the real OS image');
    assert.match(native.signerThumbprint, /^[a-f0-9]{40}$/i);
    const observed = audit(fixture.image, fixture.pinned, native.signerThumbprint);
    assert.equal(observed.companionManifestMatches, true);
    assert.equal(observed.externallyPinnedReleaseSha256Matches, true);
    // The signed file remains a Windows surrogate, NOT a Nexowire release.
    if (observed.authenticodeStatus === 'UNAVAILABLE') {
      assert.equal(observed.authenticodeEvidenceAvailable, false);
      assert.equal(observed.publisherValid, false);
      assert.equal(observed.provisionalFileTrustChecksPassed, false);
    } else {
      assert.equal(observed.authenticodeStatus, 'Valid',
        'unexpected signature state must not be promoted to valid');
      assert.equal(observed.authenticodeEvidenceAvailable, true);
      assert.equal(observed.publisherValid, true);
    }
    assertNoProductionTrust(observed);

    // Force source PowerShell Security provider unavailability, while leaving
    // file bytes, hash and OS-native signed witness unchanged.
    const forced = [
      'Import-Module Microsoft.PowerShell.Management',
      'Import-Module Microsoft.PowerShell.Utility',
      'Remove-Module Microsoft.PowerShell.Security -Force -ErrorAction SilentlyContinue',
      "$PSModuleAutoLoadingPreference='None'",
      '& ' + quote(scriptPath) + ' -HelperPath ' + quote(fixture.image) +
        ' -ExpectedReleaseSha256 ' + quote(fixture.pinned) +
        ' -ExpectedPublisherThumbprint ' + quote(native.signerThumbprint),
    ].join('; ');
    const unavailable = JSON.parse(encodedPowerShell(forced)) as Audit;
    assert.equal(unavailable.authenticodeStatus, 'UNAVAILABLE');
    assert.equal(unavailable.authenticodeEvidenceAvailable, false);
    assert.equal(unavailable.publisherValid, false);
    assert.equal(unavailable.aclEvidenceAvailable, false);
    assert.equal(unavailable.broadWriteGrantFound, null);
    assert.equal(unavailable.parentBroadWriteGrantFound, null);
    assert.equal(unavailable.provisionalFileTrustChecksPassed, false);
    assertNoProductionTrust(unavailable);
  } finally {
    await removeFixture(fixture.dir);
  }
});

test('QA19 malicious function shadow claims Valid and protected ACL but cannot forge native facts', {
  skip: !win, timeout: 25_000,
}, async () => {
  const fixture = await tempFixture(Buffer.from('UNSIGNED-TEST-SURROGATE-DO-NOT-EXECUTE'));
  try {
    const injected = [
      "function Get-AuthenticodeSignature { [pscustomobject]@{ Status='Valid'; SignerCertificate=[pscustomobject]@{Thumbprint=('A'*40)} } }",
      'function Get-Acl { [pscustomobject]@{AreAccessRulesProtected=$true;Access=@()} }',
      '& ' + quote(scriptPath) + ' -HelperPath ' + quote(fixture.image) +
        ' -ExpectedReleaseSha256 ' + quote(fixture.pinned) +
        ' -ExpectedPublisherThumbprint ' + quote('A'.repeat(40)),
    ].join('; ');
    const observed = JSON.parse(encodedPowerShell(injected)) as Audit;
    assert.notEqual(observed.authenticodeStatus, 'Valid',
      'unqualified fake function cannot be an OS-signed executable witness');
    assert.equal(observed.publisherValid, false);
    assert.equal(observed.externallyPinnedPublisherMatches, false);
    assert.equal(observed.provisionalFileTrustChecksPassed, false);
    assertNoProductionTrust(observed);
  } finally {
    await removeFixture(fixture.dir);
  }
});

test('QA19 protected file DACL does not cure independently observed inherited parent Modify', {
  skip: !win, timeout: 30_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-qa19-parent-'));
  const parent = path.join(root, 'helper-parent');
  try {
    await fs.mkdir(parent);
    const image = path.join(parent, 'windows-job-owner.exe');
    const bytes = Buffer.from('QA19 SYNTHETIC DACL INPUT; NEVER EXECUTE');
    await fs.writeFile(image, bytes);
    await fs.writeFile(path.join(parent, 'windows-job-owner.sha256'), sha(bytes) + '\n');

    // Touch only a newly created TEMP directory. Protect the parent DACL,
    // then grant Authenticated Users Modify with inheritable OI/CI flags.
    // A "protected" parent DACL is NOT a clean parent DACL.
    mustSucceed(run('icacls.exe', [parent, '/inheritance:d']), 'TEMP parent DACL protection');
    mustSucceed(run('icacls.exe', [parent, '/grant', '*S-1-5-11:(OI)(CI)M']),
      'TEMP parent inherited Modify');
    mustSucceed(run('icacls.exe', [image, '/inheritance:d']), 'TEMP leaf DACL protection');

    const native = nativeWitness(image);
    assert.equal(native.parentProtected, true);
    assert.equal(native.fileProtected, true);
    assert.equal(native.parentBroadModify, true,
      'native directory ACE shows unsafe write despite protected child DACL');

    const observed = audit(image, sha(bytes));
    if (observed.aclEvidenceAvailable) {
      assert.equal(observed.parentBroadWriteGrantFound, true,
        'available audit may not suppress dangerous parent ACE');
    } else {
      assert.equal(observed.parentBroadWriteGrantFound, null,
        'unavailable audit MUST report unknown, not secure');
    }
    assert.equal(observed.provisionalFileTrustChecksPassed, false);
    assertNoProductionTrust(observed);
  } finally {
    await removeFixture(root);
  }
});

test('QA19 stale then attacker-paired companion manifest cannot replace pinned release/source identity', {
  skip: !win, timeout: 24_000,
}, async () => {
  const fixture = await tempFixture(Buffer.from('QA19_UNSIGNED_SOURCE_A'));
  try {
    const oldPinned = fixture.pinned;
    const replacement = Buffer.from('QA19_UNSIGNED_SOURCE_B_MODIFIED');
    await fs.writeFile(fixture.image, replacement);
    const stale = audit(fixture.image, oldPinned);
    assert.equal(stale.companionManifestMatches, false);
    assert.equal(stale.externallyPinnedReleaseSha256Matches, false);
    assert.equal(stale.provisionalFileTrustChecksPassed, false);
    assertNoProductionTrust(stale);

    // Pairing a replacement image with a fresh attacker digest does not make
    // that digest independently pinned or the image publisher-signed.
    await fs.writeFile(fixture.manifest, sha(replacement) + '\n');
    const paired = audit(fixture.image, oldPinned);
    assert.equal(paired.companionManifestMatches, true);
    assert.equal(paired.externallyPinnedReleaseSha256Matches, false);
    assert.equal(paired.publisherValid, false);
    assert.equal(paired.provisionalFileTrustChecksPassed, false);
    assertNoProductionTrust(paired);

    const prod = run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-File', scriptPath,
      '-HelperPath', fixture.image, '-Production',
      '-ExpectedReleaseSha256', oldPinned,
    ]);
    assert.notEqual(prod.status, 0, 'signed-release proof absent: NO-GO');
    assert.match((prod.stdout ?? '') + (prod.stderr ?? ''),
      /WINDOWS_JOB_PRODUCTION_TRUST_BLOCKED/);
  } finally {
    await removeFixture(fixture.dir);
  }
});
