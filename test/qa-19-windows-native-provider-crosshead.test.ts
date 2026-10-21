import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// #19 independence boundary: review source-only provider evidence from #670.
// The only filesystem / ACL mutations below are in unique disposable TEMP
// directories. No signed EXE is executed as a helper and no live Broker used.
const windows = process.platform === 'win32';
const auditScript = path.resolve('scripts/audit-windows-job-helper-trust.ps1');
type Evidence = {
  kind: string;
  helperSha256: string;
  companionManifestMatches: boolean;
  authenticodeStatus: string;
  authenticodeEvidenceAvailable: boolean;
  securityModuleAvailable: boolean;
  expectedSecurityModuleLocation: string;
  publisherValid: boolean;
  externallyPinnedPublisherMatches: boolean;
  externallyPinnedReleaseSha256Matches: boolean;
  aclEvidenceAvailable: boolean;
  parentAclProtected: boolean;
  fileAclProtected: boolean;
  broadWriteGrantFound: boolean | null;
  parentBroadWriteGrantFound: boolean | null;
  signedReleaseManifestVerified: boolean;
  processHighTokenVerified: boolean;
  installedRunningImageIdentityVerified: boolean;
  provisionalFileTrustChecksPassed: boolean;
  productionReady: boolean;
};
const hash = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const psQuote = (s: string): string => "'" + s.replace(/'/g, "''") + "'";
const exec = (file: string, args: string[], timeout = 18_000) => spawnSync(file, args, {
  encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 64 * 1024,
});
function mustSucceed(file: string, args: string[], label: string): string {
  const out = exec(file, args);
  assert.equal(out.error, undefined, label + ': ' + String(out.error));
  assert.equal(out.status, 0, label + ': ' + (out.stderr ?? '').slice(0, 1800));
  return (out.stdout ?? '').trim();
}
function audit(file: string, expectedSha = '', expectedPublisher = ''): Evidence {
  return JSON.parse(mustSucceed('pwsh.exe', [
    '-NoLogo','-NoProfile','-NonInteractive','-File', auditScript,
    '-HelperPath', file, '-ExpectedReleaseSha256', expectedSha,
    '-ExpectedPublisherThumbprint', expectedPublisher,
  ], 'native Windows Job audit')) as Evidence;
}
function assertNeverProduction(x: Evidence): void {
  assert.equal(x.productionReady, false);
  assert.equal(x.signedReleaseManifestVerified, false);
  assert.equal(x.processHighTokenVerified, false);
  assert.equal(x.installedRunningImageIdentityVerified, false);
}
function nativeSigner(file: string): { status: string; thumbprint: string } {
  const command = [
    "$ErrorActionPreference='Stop'",
    "$native=Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1'",
    'Microsoft.PowerShell.Core\Import-Module -Name $native -Force -ErrorAction Stop',
    '$v=Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath ' + psQuote(file) + ' -ErrorAction Stop',
    "[ordered]@{status=[string]$v.Status;thumbprint=$(if($v.SignerCertificate){[string]$v.SignerCertificate.Thumbprint}else{''})} | ConvertTo-Json -Compress",
  ].join('\n');
  return JSON.parse(mustSucceed('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(command, 'utf16le').toString('base64'),
  ], 'independent Win32 Authenticode witness')) as { status: string; thumbprint: string };
}
async function disposable(data: Buffer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-qa19-670-'));
  const image = path.join(dir, 'windows-job-owner.exe');
  const manifest = path.join(dir, 'windows-job-owner.sha256');
  await fs.writeFile(image, data);
  await fs.writeFile(manifest, hash(data) + '\n');
  return {dir, image, manifest, digest: hash(data)};
}
async function cleanup(root: string) {
  await fs.rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
}
function runEncoded(command: string): Evidence {
  return JSON.parse(mustSucceed('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(command, 'utf16le').toString('base64'),
  ], 'injected caller provider boundary')) as Evidence;
}

test('QA19 #670 real signed image native provider is available and no production Broker proof follows', {
  skip: !windows, timeout: 36_000,
}, async () => {
  const signed = path.join(process.env.SystemRoot ?? 'C:\\Windows',
    'System32','WindowsPowerShell','v1.0','powershell.exe');
  const f = await disposable(await fs.readFile(signed));
  try {
    const independent = nativeSigner(f.image);
    assert.equal(independent.status, 'Valid', 'do not manufacture an OS signature');
    assert.match(independent.thumbprint, /^[0-9a-f]{40}$/i);
    const evidence = audit(f.image, f.digest, independent.thumbprint);
    assert.equal(evidence.securityModuleAvailable, true, 'OS provider unavailable is FAIL');
    assert.equal(evidence.authenticodeEvidenceAvailable, true);
    assert.equal(evidence.authenticodeStatus, 'Valid');
    assert.equal(evidence.publisherValid, true);
    assert.equal(evidence.externallyPinnedPublisherMatches, true);
    assert.equal(evidence.externallyPinnedReleaseSha256Matches, true);
    assert.equal(evidence.companionManifestMatches, true);
    assert.equal(evidence.aclEvidenceAvailable, true, 'native parent/file ACL provider unavailable is FAIL');
    assert.match(evidence.expectedSecurityModuleLocation,
      /Microsoft\.PowerShell\.Security\.psd1$/i);
    assertNeverProduction(evidence);
  } finally { await cleanup(f.dir); }
});

test('QA19 #670 forged caller functions cannot manufacture Valid or protected parent', {
  skip: !windows, timeout: 25_000,
}, async () => {
  const f = await disposable(Buffer.from('QA19_UNSIGNED_DISPOSABLE_FIXTURE_NEVER_EXECUTE'));
  try {
    const fake = 'A'.repeat(40);
    const injected = [
      "function Get-AuthenticodeSignature { [pscustomobject]@{ Status='Valid'; SignerCertificate=[pscustomobject]@{Thumbprint='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'} } }",
      "function Get-Acl { [pscustomobject]@{ AreAccessRulesProtected=$true;Access=@() } }",
      'Remove-Module Microsoft.PowerShell.Security -Force -ErrorAction SilentlyContinue',
      '& ' + psQuote(auditScript) + ' -HelperPath ' + psQuote(f.image) +
        ' -ExpectedPublisherThumbprint ' + psQuote(fake) +
        ' -ExpectedReleaseSha256 ' + psQuote(f.digest),
    ].join('; ');
    const evidence = runEncoded(injected);
    assert.equal(evidence.securityModuleAvailable, true,
      'native module must reload; local forged function is NOT fallback');
    assert.notEqual(evidence.authenticodeStatus, 'Valid');
    assert.equal(evidence.publisherValid, false);
    assert.equal(evidence.externallyPinnedPublisherMatches, false);
    assert.equal(evidence.aclEvidenceAvailable, true, 'native file and parent ACL probe required');
    assert.equal(evidence.companionManifestMatches, true);
    assert.equal(evidence.provisionalFileTrustChecksPassed, false);
    assertNeverProduction(evidence);
  } finally { await cleanup(f.dir); }
});

test('QA19 #670 protected leaf/parent with inherited low-trust Modify remains unsafe', {
  skip: !windows, timeout: 27_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-qa19-670-acl-'));
  const parent = path.join(root, 'helper');
  try {
    await fs.mkdir(parent);
    const image = path.join(parent, 'windows-job-owner.exe');
    const input = Buffer.from('SYNTHETIC_ACL_FIXTURE_NEVER_EXECUTE');
    await fs.writeFile(image, input);
    await fs.writeFile(path.join(parent, 'windows-job-owner.sha256'), hash(input) + '\n');
    // Only synthetic TEMP ACLs, no installed app, ProgramData, or system DACL.
    mustSucceed('icacls.exe', [parent,'/inheritance:d'], 'TEMP parent DACL protection');
    mustSucceed('icacls.exe', [parent,'/grant','*S-1-5-11:(OI)(CI)M'], 'TEMP inherited Modify');
    mustSucceed('icacls.exe', [image,'/inheritance:d'], 'TEMP leaf DACL protection');

    const evidence = audit(image, hash(input));
    assert.equal(evidence.aclEvidenceAvailable, true, 'missing ACL witness is NOT clean ACL');
    assert.equal(evidence.fileAclProtected, true);
    assert.equal(evidence.parentAclProtected, true);
    assert.equal(evidence.parentBroadWriteGrantFound, true,
      'protected DACL plus inherited low-trust parent Modify must be discovered');
    assert.equal(evidence.publisherValid, false);
    assert.equal(evidence.provisionalFileTrustChecksPassed, false);
    assertNeverProduction(evidence);
  } finally { await cleanup(root); }
});

test('QA19 #670 UNAVAILABLE is not Valid and stale/paired digest never signs an image', {
  skip: !windows, timeout: 25_000,
}, async () => {
  // Test-only negative-state contract: cannot disable Windows trusted module
  // on the hosted machine without altering the real OS. Do not call this
  // synthetic object a real provider outage or a passing production witness.
  const unavailable = {
    authenticodeStatus: 'UNAVAILABLE', authenticodeEvidenceAvailable: false,
    aclEvidenceAvailable: false, parentBroadWriteGrantFound: null,
    publisherValid: false, productionReady: false,
  };
  assert.notEqual(unavailable.authenticodeStatus, 'Valid');
  assert.equal(unavailable.authenticodeEvidenceAvailable, false);
  assert.equal(unavailable.parentBroadWriteGrantFound, null);
  assert.equal(unavailable.productionReady, false);

  const f = await disposable(Buffer.from('QA19_ORIGINAL_UNSIGNED'));
  try {
    const stalePin = f.digest;
    const changed = Buffer.from('QA19_CHANGED_UNSIGNED');
    await fs.writeFile(f.image, changed);
    const stale = audit(f.image, stalePin);
    assert.equal(stale.companionManifestMatches, false);
    assert.equal(stale.externallyPinnedReleaseSha256Matches, false);
    assertNeverProduction(stale);
    await fs.writeFile(f.manifest, hash(changed) + '\n');
    const paired = audit(f.image, stalePin);
    assert.equal(paired.companionManifestMatches, true);
    assert.equal(paired.externallyPinnedReleaseSha256Matches, false);
    assert.equal(paired.publisherValid, false);
    assert.equal(paired.provisionalFileTrustChecksPassed, false);
    assertNeverProduction(paired);
    const production = exec('pwsh.exe', [
      '-NoProfile','-NonInteractive','-File',auditScript,
      '-HelperPath',f.image,'-ExpectedReleaseSha256',stalePin,'-Production',
    ]);
    assert.notEqual(production.status, 0, 'untrusted helper may never be produced as release-ready');
    assert.match((production.stdout ?? '') + (production.stderr ?? ''),
      /WINDOWS_JOB_PRODUCTION_TRUST_BLOCKED/);
  } finally { await cleanup(f.dir); }
});
