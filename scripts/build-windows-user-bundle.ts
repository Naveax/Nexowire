import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { windowsShortcutInterop } from './windows-shortcut-interop.js';

interface BundleOptions {
  outputDir: string;
  repository: string;
  nodeVersion: string;
  sourceSha: string;
}

interface BundleResult {
  version: string;
  sourceSha: string;
  nodeVersion: string;
  payloadZip: string;
  payloadSha256: string;
  setupScript: string;
  checksumFile: string;
}

function fail(message: string): never {
  throw new Error(message);
}

function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string } = {},
): string {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd ?? process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(
      [command, ...args].join(' ') +
        ' failed with exit ' +
        String(result.status) +
        '\n' +
        (result.stdout ?? '') +
        '\n' +
        (result.stderr ?? ''),
    );
  }
  return result.stdout ?? '';
}

function runPowerShell(script: string): string {
  return run(
    process.env.SystemRoot
      ? path.join(
          process.env.SystemRoot,
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        )
      : 'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ],
  );
}

function psLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await fs.readFile(file));
  return hash.digest('hex');
}

function safeVersion(value: string): string {
  const version = value.trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail('Invalid package/Node version: ' + value);
  }
  return version;
}

function safeRepository(value: string): string {
  const repository = value.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    fail('Invalid GitHub repository: ' + value);
  }
  return repository;
}

function safeSourceSha(value: string): string {
  const sha = value.trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sha)) {
    fail('Invalid source SHA: ' + value);
  }
  return sha;
}

function argValue(
  args: readonly string[],
  name: string,
): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    fail(name + ' requires a value.');
  }
  return value;
}

export function parseBundleArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): BundleOptions {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (
      [
        '--output-dir',
        '--repository',
        '--node-version',
        '--source-sha',
      ].includes(arg)
    ) {
      index++;
      if (index >= args.length) fail(arg + ' requires a value.');
      continue;
    }
    fail('Unknown Windows bundle option: ' + arg);
  }

  const sourceSha =
    argValue(args, '--source-sha') ??
    env.GITHUB_SHA ??
    run('git', ['rev-parse', 'HEAD']).trim();

  return {
    outputDir: path.resolve(
      argValue(args, '--output-dir') ??
        path.join('release-windows'),
    ),
    repository: safeRepository(
      argValue(args, '--repository') ??
        env.GITHUB_REPOSITORY ??
        'Naveax/Nexowire',
    ),
    nodeVersion: safeVersion(
      argValue(args, '--node-version') ??
        process.versions.node,
    ),
    sourceSha: safeSourceSha(sourceSha),
  };
}

export function renderHiddenLauncher(): string {
  return [
    'Option Explicit',
    'Dim fso, shell, root, nodePath, cliPath, command',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'Set shell = CreateObject("WScript.Shell")',
    'root = fso.GetParentFolderName(WScript.ScriptFullName)',
    'nodePath = fso.BuildPath(root, "runtime\\node.exe")',
    'cliPath = fso.BuildPath(root, "app\\dist\\src\\cli.js")',
    'command = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & cliPath & Chr(34) & " connect"',
    'shell.Run command, 0, False',
    '',
  ].join('\r\n');
}

export function renderSetupScript(input: {
  version: string;
  sourceSha: string;
  payloadSha256: string;
  repository: string;
}): string {
  const version = safeVersion(input.version);
  const sourceSha = safeSourceSha(input.sourceSha);
  const repository = safeRepository(input.repository);
  const checksum = input.payloadSha256.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(checksum)) {
    fail('Invalid payload SHA-256.');
  }

  const buildId =
    version + '-' + sourceSha.slice(0, 12);
  const shortcutName = version.includes('-')
    ? 'Nexowire Experimental.lnk'
    : 'Nexowire.lnk';
  const assetUrl =
    'https://github.com/' +
    repository +
    '/releases/download/v' +
    version +
    '/Nexowire-Windows-x64.zip';

  const powershellCommand = [
    "$ErrorActionPreference = 'Stop';",
    "$ProgressPreference = 'SilentlyContinue';",
    "if (-not (Test-Path -LiteralPath $env:NX_INSTALL)) {",
    // CI artifacts may precede the matching tagged GitHub release.
    // Prefer the sibling checksum-pinned ZIP and never trust an old tag
    // merely because it uses the same semantic version.
    "  if (Test-Path -LiteralPath $env:NX_LOCAL_ZIP -PathType Leaf) {",
    "    [System.IO.File]::Copy($env:NX_LOCAL_ZIP, $env:NX_ZIP, $false);",
    "  } else {",
    "    $web = New-Object System.Net.WebClient;",
    "    try { $web.DownloadFile($env:NX_PAYLOAD_URL, $env:NX_ZIP) } finally { $web.Dispose() };",
    "  };",
    "  $sha = [System.Security.Cryptography.SHA256]::Create();",
    "  $stream = [System.IO.File]::OpenRead($env:NX_ZIP);",
    "  try { $actual = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() } finally { $stream.Dispose(); $sha.Dispose() };",
    "  if ($actual -ne $env:NX_PAYLOAD_SHA256) { throw 'Nexowire payload checksum mismatch. Use the matching ZIP beside Nexowire-Setup.cmd or the correct published release.' };",
    "  New-Item -ItemType Directory -Force -Path $env:NX_EXTRACT | Out-Null;",
    "  Add-Type -AssemblyName System.IO.Compression.FileSystem;",
    "  [System.IO.Compression.ZipFile]::ExtractToDirectory($env:NX_ZIP, $env:NX_EXTRACT);",
    "  $source = Join-Path $env:NX_EXTRACT 'Nexowire';",
    "  if (-not (Test-Path -LiteralPath (Join-Path $source 'runtime\\node.exe'))) { throw 'Nexowire payload is incomplete.' };",
    "  New-Item -ItemType Directory -Force -Path (Split-Path $env:NX_INSTALL -Parent) | Out-Null;",
    "  Move-Item -LiteralPath $source -Destination $env:NX_INSTALL;",
    "};",
    "$launcher = Join-Path $env:NX_INSTALL 'Nexowire.vbs';",
    "if (-not (Test-Path -LiteralPath $launcher)) { throw 'Nexowire launcher is missing.' };",
    // Base64 is only ASCII-safe transport for C# through cmd.exe quoting. The
    // decoded source uses Windows' own Shell Link API; no downloaded helper.
    "Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" +
      Buffer.from(windowsShortcutInterop, 'utf8').toString('base64') + "')));",
    "$shortcutPath = Join-Path ([Environment]::GetFolderPath('Programs')) '" + shortcutName + "';",
    "$shortcut = @{ TargetPath = (Join-Path $env:WINDIR 'System32\\wscript.exe'); Arguments = ([char]34 + $launcher + [char]34) };",
    "[NexowireShortcut]::Save($shortcutPath, $shortcut.TargetPath, $shortcut.Arguments, $env:NX_INSTALL);",
    // Preview builds must not silently register a stable-channel hourly
    // updater. Stable releases keep their existing update behavior.
    ...(version.includes('-')
      ? ["Write-Output 'Nexowire experimental preview: automatic updates disabled';"]
      : [
          "$autoNode = Join-Path $env:NX_INSTALL 'runtime\\node.exe';",
          "$autoCli = Join-Path $env:NX_INSTALL 'app\\dist\\src\\cli.js';",
          "& $autoNode $autoCli update auto install | Out-Null;",
          "if ($LASTEXITCODE -ne 0) { throw 'Nexowire hourly auto-update task registration failed.' };",
        ]),
    "Start-Process -FilePath $shortcut.TargetPath -ArgumentList $shortcut.Arguments -WorkingDirectory $env:NX_INSTALL;",
    "Remove-Item -LiteralPath $env:NX_TMP -Recurse -Force -ErrorAction SilentlyContinue;",
  ].join(' ');

  return [
    '@echo off',
    'setlocal EnableExtensions',
    'title Nexowire Setup',
    'set "NX_VERSION=' + version + '"',
    'set "NX_BUILD_ID=' + buildId + '"',
    'set "NX_PAYLOAD_SHA256=' + checksum + '"',
    'set "NX_PAYLOAD_URL=' + assetUrl + '"',
    'set "NX_LOCAL_ZIP=%~dp0Nexowire-Windows-x64.zip"',
    'set "NX_TMP=%TEMP%\\Nexowire-Setup-%RANDOM%%RANDOM%"',
    'set "NX_ZIP=%NX_TMP%\\Nexowire-Windows-x64.zip"',
    'set "NX_EXTRACT=%NX_TMP%\\extract"',
    'set "NX_INSTALL=%LOCALAPPDATA%\\Nexowire\\versions\\%NX_BUILD_ID%"',
    'mkdir "%NX_TMP%" >nul 2>&1',
    'if errorlevel 1 goto :failed',
    'echo Installing Nexowire...',
    'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' +
      powershellCommand +
      '"',
    'if errorlevel 1 goto :failed',
    'exit /b 0',
    '',
    ':failed',
    'echo.',
    'echo Nexowire could not be installed.',
    'echo Please keep this window open and report the error above.',
    'pause',
    'exit /b 1',
    '',
  ].join('\r\n');
}

async function copyTree(
  source: string,
  destination: string,
): Promise<void> {
  await fs.cp(source, destination, {
    recursive: true,
    force: true,
  });
}

function runNpmCi(cwd: string): void {
  const comSpec = process.env.ComSpec ?? 'cmd.exe';
  run(
    comSpec,
    [
      '/d',
      '/s',
      '/c',
      'npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund',
    ],
    { cwd },
  );
}

/** Use Windows PowerShell 5.1/.NET Framework's supported two-argument API. */
export function nodeRuntimeExtractionPowerShell(
  archive: string,
  extracted: string,
): string {
  return [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '[System.IO.Compression.ZipFile]::ExtractToDirectory(' +
      psLiteral(archive) + ', ' + psLiteral(extracted) + ')',
  ].join('; ');
}

async function downloadNodeRuntime(
  tempRoot: string,
  nodeVersion: string,
): Promise<string> {
  const base =
    'https://nodejs.org/dist/v' + nodeVersion;
  const archiveName =
    'node-v' + nodeVersion + '-win-x64.zip';
  const archive = path.join(tempRoot, archiveName);
  const sums = path.join(tempRoot, 'SHASUMS256.txt');
  const extracted = path.join(tempRoot, 'node-runtime');

  // Fetch only; untrusted ZIP bytes must not be extracted before SHA-256.
  runPowerShell(
    [
      "$ErrorActionPreference='Stop'",
      "$ProgressPreference='SilentlyContinue'",
      'Invoke-WebRequest -UseBasicParsing -Uri ' +
        psLiteral(base + '/' + archiveName) +
        ' -OutFile ' +
        psLiteral(archive),
      'Invoke-WebRequest -UseBasicParsing -Uri ' +
        psLiteral(base + '/SHASUMS256.txt') +
        ' -OutFile ' +
        psLiteral(sums),
    ].join('; '),
  );

  const sumText = await fs.readFile(sums, 'utf8');
  const expectedLine = sumText
    .split(/\r?\n/)
    .find((line) => line.trim().endsWith('  ' + archiveName));
  if (!expectedLine) {
    fail('Node SHASUMS256 does not contain ' + archiveName);
  }
  const expected = expectedLine.trim().split(/\s+/)[0]!.toLowerCase();
  assert.match(expected, /^[a-f0-9]{64}$/);
  const actual = await sha256File(archive);
  assert.equal(
    actual,
    expected,
    'Official Node runtime archive checksum mismatch.',
  );

  // The signed release archive hash is verified BEFORE any ZIP entry is read.
  // Windows PowerShell 5.1 Expand-Archive can invoke an unavailable .NET
  // ExtractToDirectory(3 args) overload on hosted Windows; use the two-arg
  // framework API directly on a fresh, dedicated extraction directory.
  await fs.mkdir(extracted, { recursive: true });
  runPowerShell(nodeRuntimeExtractionPowerShell(archive, extracted));

  const runtimeRoot = path.join(
    extracted,
    'node-v' + nodeVersion + '-win-x64',
  );
  await fs.access(path.join(runtimeRoot, 'node.exe'));
  await fs.access(path.join(runtimeRoot, 'LICENSE'));
  return runtimeRoot;
}

// Verify BEFORE reading built outputs or mutating the output directory.
// A CI negative fixture should test the policy itself even if dist/ is absent.
export function assertWindowsJobPostSigningDigest(
  actual: string, manifest: string, approved?: string,
): void {
  if (!/^[a-f0-9]{64}$/.test(actual) ||
      manifest.trim() !== actual ||
      (approved !== undefined && approved !== actual)) {
    fail('WINDOWS_JOB_POST_SIGNING_DIGEST_MISMATCH');
  }
}

export function assertTrustedWindowsJobPublisher(
  root: string, env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  // PR bundles are unsigned staging artifacts, never release authorization.
  if (env.GITHUB_REF_TYPE !== 'tag') return undefined;
  const expectedPublisher =
    (env.NEXOWIRE_WINDOWS_JOB_PUBLISHER_THUMBPRINT ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(expectedPublisher)) {
    fail('WINDOWS_JOB_TRUSTED_PUBLISHER_NOT_CONFIGURED: tagged release blocked.');
  }
  const signerSha256 = (env.NEXOWIRE_WINDOWS_JOB_SIGNER_SHA256 ?? '').trim().toLowerCase();
  const subject = (env.NEXOWIRE_WINDOWS_JOB_PUBLISHER_SUBJECT ?? '').trim();
  const artifactSha256 = (env.NEXOWIRE_WINDOWS_JOB_ARTIFACT_SHA256 ?? '').trim().toLowerCase();
  const signTool = env.NEXOWIRE_WINDOWS_SIGNTOOL_PATH ?? '';
  if (!/^[a-f0-9]{64}$/.test(signerSha256) ||
      !/^[a-f0-9]{64}$/.test(artifactSha256) || !subject ||
      !/^[A-Za-z]:\\\\/.test(signTool) ||
      path.win32.normalize(signTool) !== signTool ||
      path.win32.basename(signTool).toLowerCase() !== 'signtool.exe') {
    fail('WINDOWS_JOB_SIGNED_RELEASE_POLICY_NOT_CONFIGURED');
  }
  const helperSource = path.join(root, 'native', 'windows-job-owner.exe');
  const manifestPath = path.join(root, 'native', 'windows-job-owner.sha256');
  const verifyBytes = () => assertWindowsJobPostSigningDigest(
    createHash('sha256').update(readFileSync(helperSource)).digest('hex'),
    readFileSync(manifestPath, 'utf8'),
    artifactSha256,
  );
  verifyBytes();
  const actual = JSON.parse(runPowerShell([
    '$ErrorActionPreference = "Stop"',
    '$signature = Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath ' + psLiteral(helperSource),
    'if ($signature.Status -ne "Valid" -or $signature.SignatureType -ne "Authenticode" -or -not $signature.SignerCertificate) { throw "WINDOWS_JOB_HELPER_UNSIGNED_OR_INVALID" }',
    'if (-not $signature.TimeStamperCertificate) { throw "WINDOWS_JOB_TIMESTAMP_REQUIRED" }',
    '$h = [Security.Cryptography.SHA256]::Create()',
    'try { $der = [BitConverter]::ToString($h.ComputeHash($signature.SignerCertificate.RawData)).Replace("-","").ToLowerInvariant() } finally { $h.Dispose() }',
    '[pscustomobject]@{ thumbprint=$signature.SignerCertificate.Thumbprint.ToLowerInvariant(); signerSha256=$der; subject=$signature.SignerCertificate.Subject } | ConvertTo-Json -Compress',
  ].join('; '))) as { thumbprint: string; signerSha256: string; subject: string };
  if (actual.thumbprint !== expectedPublisher || actual.signerSha256 !== signerSha256 ||
      actual.subject !== subject) {
    fail('WINDOWS_JOB_PUBLISHER_MISMATCH: tagged release blocked.');
  }
  // SignTool /tw warns if no timestamp; require exit 0, not warnings (2).
  // The SDK tool and all pins must be provisioned by the release authority.
  const verified = spawnSync(signTool, ['verify', '/pa', '/all', '/tw', '/v', helperSource], {
    shell: false, windowsHide: true, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
  });
  if (verified.error || verified.signal || verified.status !== 0) {
    fail('WINDOWS_JOB_TIMESTAMP_OR_SIGNATURE_VERIFICATION_FAILED');
  }
  verifyBytes();
  return artifactSha256;
}

export async function buildWindowsUserBundle(
  options: BundleOptions,
): Promise<BundleResult> {
  if (process.platform !== 'win32') {
    fail('Windows user bundle must be built on Windows.');
  }

  const root = process.cwd();
  const packageJson = JSON.parse(
    await fs.readFile(path.join(root, 'package.json'), 'utf8'),
  ) as { name?: string; version?: string };
  assert.equal(packageJson.name, 'nexowire');
  const version = safeVersion(packageJson.version ?? '');

  const approvedJobDigest = assertTrustedWindowsJobPublisher(root);
  const jobSource = path.join(root, 'native', 'windows-job-owner.exe');
  const jobManifest = await fs.readFile(path.join(root, 'native', 'windows-job-owner.sha256'), 'utf8');
  const jobDigest = await sha256File(jobSource);
  assertWindowsJobPostSigningDigest(jobDigest, jobManifest, approvedJobDigest);

  const cli = path.join(root, 'dist', 'src', 'cli.js');
  await fs.access(cli);

  await fs.rm(options.outputDir, {
    recursive: true,
    force: true,
  });
  await fs.mkdir(options.outputDir, { recursive: true });

  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-windows-bundle-'),
  );

  try {
    const payloadRoot = path.join(tempRoot, 'Nexowire');
    const appRoot = path.join(payloadRoot, 'app');
    const runtimeRoot = path.join(payloadRoot, 'runtime');
    await fs.mkdir(appRoot, { recursive: true });
    await fs.mkdir(runtimeRoot, { recursive: true });

    await copyTree(
      path.join(root, 'dist', 'src'),
      path.join(appRoot, 'dist', 'src'),
    );
    // The Job guardian is a required runtime dependency on Windows.
    // Fail the release rather than shipping a silently unmanaged shell.
    const bundledJobOwner=path.join(appRoot,'dist','native','windows-job-owner.exe');
    await fs.mkdir(path.dirname(bundledJobOwner),{recursive:true});
    await fs.copyFile(jobSource,bundledJobOwner);
    // Bind the staged bytes to the verified post-signing digest, not a stale
    // pre-signing build checksum or a mutable adjacent manifest.
    const bundledJobDigest = await sha256File(bundledJobOwner);
    assertWindowsJobPostSigningDigest(bundledJobDigest, jobManifest, jobDigest);
    await fs.writeFile(
      path.join(appRoot, 'dist', 'native', 'windows-job-owner.sha256'),
      bundledJobDigest + '\n',
      'utf8',
    );
    await copyTree(
      path.join(root, 'skills'),
      path.join(appRoot, 'skills'),
    );
    await fs.copyFile(
      path.join(root, 'README.md'),
      path.join(appRoot, 'README.md'),
    );
    await fs.copyFile(
      path.join(root, 'package.json'),
      path.join(appRoot, 'package.json'),
    );
    await fs.copyFile(
      path.join(root, 'package-lock.json'),
      path.join(appRoot, 'package-lock.json'),
    );

    runNpmCi(appRoot);

    const officialNodeRoot =
      await downloadNodeRuntime(
        tempRoot,
        options.nodeVersion,
      );
    await fs.copyFile(
      path.join(officialNodeRoot, 'node.exe'),
      path.join(runtimeRoot, 'node.exe'),
    );
    await fs.copyFile(
      path.join(officialNodeRoot, 'LICENSE'),
      path.join(runtimeRoot, 'NODE-LICENSE.txt'),
    );

    await fs.writeFile(
      path.join(payloadRoot, 'Nexowire.vbs'),
      renderHiddenLauncher(),
      'utf8',
    );
    await fs.writeFile(
      path.join(payloadRoot, 'BUILD.txt'),
      [
        'Nexowire ' + version,
        'Source: ' + options.sourceSha,
        'Node: ' + options.nodeVersion,
        '',
      ].join('\r\n'),
      'utf8',
    );

    const bundledNode = path.join(
      runtimeRoot,
      'node.exe',
    );
    const bundledCli = path.join(
      appRoot,
      'dist',
      'src',
      'cli.js',
    );
    const smoke = spawnSync(
      bundledNode,
      [bundledCli, '--version'],
      {
        cwd: payloadRoot,
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    if (smoke.error) throw smoke.error;
    assert.equal(
      smoke.status,
      0,
      'Bundled Nexowire runtime smoke failed: ' +
        (smoke.stderr ?? ''),
    );
    assert.equal(
      (smoke.stdout ?? '').trim(),
      version,
      'Bundled Nexowire runtime version mismatch.',
    );

    const payloadZip = path.join(
      options.outputDir,
      'Nexowire-Windows-x64.zip',
    );
    runPowerShell(
      'Compress-Archive -LiteralPath ' +
        psLiteral(payloadRoot) +
        ' -DestinationPath ' +
        psLiteral(payloadZip) +
        ' -CompressionLevel Optimal -Force',
    );
    const payloadSha256 =
      await sha256File(payloadZip);

    const setupScript = path.join(
      options.outputDir,
      'Nexowire-Setup.cmd',
    );
    await fs.writeFile(
      setupScript,
      renderSetupScript({
        version,
        sourceSha: options.sourceSha,
        payloadSha256,
        repository: options.repository,
      }),
      'utf8',
    );

    const setupSha256 = await sha256File(setupScript);
    const checksumFile = path.join(
      options.outputDir,
      'SHA256SUMS-Windows',
    );
    await fs.writeFile(
      checksumFile,
      [
        payloadSha256 + '  Nexowire-Windows-x64.zip',
        setupSha256 + '  Nexowire-Setup.cmd',
        '',
      ].join('\n'),
      'utf8',
    );

    return {
      version,
      sourceSha: options.sourceSha,
      nodeVersion: options.nodeVersion,
      payloadZip,
      payloadSha256,
      setupScript,
      checksumFile,
    };
  } finally {
    await fs.rm(tempRoot, {
      recursive: true,
      force: true,
    });
  }
}

async function main(): Promise<void> {
  const result = await buildWindowsUserBundle(
    parseBundleArgs(process.argv.slice(2)),
  );
  process.stdout.write(
    JSON.stringify(result, null, 2) + '\n',
  );
}

const invokedAs = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';

if (import.meta.url === invokedAs) {
  await main();
}
