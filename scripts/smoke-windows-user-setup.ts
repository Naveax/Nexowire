import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

function fail(message: string): never {
  throw new Error(message);
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

function parseArgs(args: readonly string[]): {
  bundleDir: string;
  profile: 'ascii' | 'unicode';
  downloadSource: 'fixture' | 'github';
  scenario: 'install' | 'checksum-mismatch';
} {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (['--bundle-dir', '--profile', '--download-source', '--scenario'].includes(arg)) {
      index++;
      if (index >= args.length) fail(arg + ' requires a value.');
      continue;
    }
    fail('Unknown Windows setup smoke option: ' + arg);
  }

  const profile = argValue(args, '--profile') ?? 'unicode';
  if (profile !== 'ascii' && profile !== 'unicode') fail('Invalid smoke profile.');
  const downloadSource = argValue(args, '--download-source') ?? 'fixture';
  if (downloadSource !== 'fixture' && downloadSource !== 'github') fail('Invalid smoke download source.');
  const scenario = argValue(args, '--scenario') ?? 'install';
  if (scenario !== 'install' && scenario !== 'checksum-mismatch') fail('Invalid smoke scenario.');
  if (scenario === 'checksum-mismatch' && downloadSource !== 'fixture') fail('Checksum fault injection requires the isolated fixture.');
  return {
    bundleDir: path.resolve(
      argValue(args, '--bundle-dir') ?? 'release-windows',
    ),
    profile,
    downloadSource,
    scenario,
  };
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await fs.readFile(file));
  return hash.digest('hex');
}

function parseChecksumFile(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([a-fA-F0-9]{64})\s{2}(.+)$/.exec(line);
    if (!match) fail('Invalid Windows checksum line: ' + line);
    result.set(match[2]!, match[1]!.toLowerCase());
  }
  return result;
}

async function waitForChild(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
  },
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
      });
    });
  });
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    fail('Windows setup smoke must run on Windows.');
  }

  const { bundleDir, profile: profileKind, downloadSource, scenario } = parseArgs(process.argv.slice(2));
  const payload = path.join(
    bundleDir,
    'Nexowire-Windows-x64.zip',
  );
  const setupSource = path.join(
    bundleDir,
    'Nexowire-Setup.cmd',
  );
  const checksumPath = path.join(
    bundleDir,
    'SHA256SUMS-Windows',
  );

  const [setupText, checksumText] = await Promise.all([
    fs.readFile(setupSource, 'utf8'),
    fs.readFile(checksumPath, 'utf8'),
  ]);
  const checksums = parseChecksumFile(checksumText);
  assert.equal(
    await sha256File(payload),
    checksums.get('Nexowire-Windows-x64.zip'),
    'Windows payload checksum file does not match payload bytes.',
  );
  assert.equal(
    await sha256File(setupSource),
    checksums.get('Nexowire-Setup.cmd'),
    'Windows checksum file does not match setup bytes.',
  );

  const buildMatch = /^set "NX_BUILD_ID=([^"]+)"$/m.exec(
    setupText,
  );
  const versionMatch = /^set "NX_VERSION=([^"]+)"$/m.exec(
    setupText,
  );
  const urlMatch = /^set "NX_PAYLOAD_URL=([^"]+)"$/m.exec(
    setupText,
  );
  if (!buildMatch || !versionMatch || !urlMatch) {
    fail('Windows setup is missing pinned build metadata.');
  }

  const buildId = buildMatch[1]!;
  const version = versionMatch[1]!;
  if (downloadSource === 'github') {
    // Test only the already published immutable payload, never a guessed URL
    // for an unreleased candidate. The child gets no inherited GitHub token.
    assert.equal(version, '1.0.7');
    assert.equal(urlMatch[1], 'https://github.com/Naveax/Nexowire/releases/download/v1.0.7/Nexowire-Windows-x64.zip');
    assert.equal(checksums.get('Nexowire-Windows-x64.zip'), '1d463f408d9f18840748c2e83080adfa3f642afadefd000f8c43cadae5e20896');
  }
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-setup-e2e-'),
  );
  const profile = path.join(tempRoot, profileKind === 'unicode' ? 'Empty Profile Çığ' : 'Empty Profile');
  const fakeLocalAppData = path.join(profile, 'AppData', 'Local');
  await fs.mkdir(fakeLocalAppData, { recursive: true });
  // Hosted Windows runners already have Node/npm/Git/pwsh. A successful setup
  // on that inherited PATH did not establish the promised empty-PC bootstrap.
  // Keep only Windows' own tools and a disposable user profile for ALL children.
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!windowsRoot || !path.isAbsolute(windowsRoot)) fail('Windows system root is unavailable.');
  const system32 = path.join(windowsRoot, 'System32');
  const appData = path.join(profile, 'AppData', 'Roaming');
  await fs.mkdir(appData, { recursive: true });
  const cleanEnv: NodeJS.ProcessEnv = {
    SystemRoot: windowsRoot, WINDIR: windowsRoot,
    ComSpec: path.join(system32, 'cmd.exe'),
    PATH: [system32, windowsRoot, path.join(system32, 'WindowsPowerShell', 'v1.0')].join(';'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    USERPROFILE: profile, APPDATA: appData, LOCALAPPDATA: fakeLocalAppData,
    TEMP: tempRoot, TMP: tempRoot,
  };
  for (const tool of ['node', 'npm', 'git', 'pwsh']) {
    const probe = await waitForChild(path.join(system32, 'where.exe'), [tool], {
      cwd: tempRoot, env: cleanEnv,
    });
    assert.notEqual(probe.exitCode, 0, 'Fresh-PC smoke unexpectedly inherited ' + tool);
  }

  let fixtureRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url !== '/Nexowire-Windows-x64.zip') {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/zip',
    });
    fixtureRequests++;
    if (scenario === 'checksum-mismatch') {
      // Keep the original installer and expected digest. Only the test HTTP
      // response is corrupted, as with a truncated/intercepted ZIP download.
      response.end('controlled incomplete Nexowire ZIP fixture');
      return;
    }
    createReadStream(payload).pipe(response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  try {
    let verifiedSetupText = setupText;
    if (downloadSource === 'github') {
      // Download the exact initial CMD offered by the UI, not just its ZIP.
      // The child has only built-in Windows tools and no inherited GH_TOKEN.
      const downloadedSetup = path.join(tempRoot, 'Nexowire-Setup-from-GitHub.cmd');
      const bootstrap = await waitForChild(
        path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          "$ErrorActionPreference='Stop'; $web=New-Object System.Net.WebClient; try { $web.DownloadFile($env:NEXOWIRE_SMOKE_SETUP_URL, $env:NEXOWIRE_SMOKE_SETUP_FILE) } finally { $web.Dispose() }"],
        { cwd: tempRoot, env: { ...cleanEnv,
          NEXOWIRE_SMOKE_SETUP_URL: 'https://raw.githubusercontent.com/Naveax/Nexowire/96315d5dd4986fffbd24a96859309271d2a88ffe/installers/Nexowire-Setup.cmd',
          NEXOWIRE_SMOKE_SETUP_FILE: downloadedSetup,
        } },
      );
      assert.equal(bootstrap.exitCode, 0, bootstrap.stderr);
      assert.equal(await sha256File(downloadedSetup), checksums.get('Nexowire-Setup.cmd'),
        'Public bootstrap differs from the repository-pinned installer.');
      verifiedSetupText = await fs.readFile(downloadedSetup, 'utf8');
    }
    const address = server.address();
    if (!address || typeof address === 'string') {
      fail('Windows setup smoke HTTP server has no TCP address.');
    }
    const localUrl =
      'http://127.0.0.1:' +
      String(address.port) +
      '/Nexowire-Windows-x64.zip';

    let smokeSetup = downloadSource === 'fixture'
      ? verifiedSetupText.replace(urlMatch[1]!, localUrl)
      : verifiedSetupText;
    smokeSetup = smokeSetup.replace(
      "$shortcutPath = Join-Path ([Environment]::GetFolderPath('Programs')) 'Nexowire.lnk';",
      "$shortcutPath = Join-Path $env:NX_INSTALL 'Nexowire.lnk';",
    );
    smokeSetup = smokeSetup.replace(
      "Start-Process -FilePath $shortcut.TargetPath -ArgumentList $shortcut.Arguments -WorkingDirectory $env:NX_INSTALL;",
      "Write-Output 'launcher-ready';",
    );
    // The setup smoke must not register a real task on the host.
    smokeSetup = smokeSetup.replace(
      '& $autoNode $autoCli update auto install | Out-Null;',
      "$global:LASTEXITCODE=0; Write-Output 'hourly-updater-simulated';",
    );
    smokeSetup = smokeSetup.replace(
      /^pause$/m,
      'rem smoke-no-pause',
    );

    assert.match(smokeSetup, /launcher-ready/);
    assert.match(smokeSetup, /hourly-updater-simulated/);
    assert.doesNotMatch(smokeSetup, /& \$autoNode \$autoCli update auto install/);
    assert.doesNotMatch(
      smokeSetup,
      /GetFolderPath\('Programs'\)/,
    );

    const smokeSetupPath = path.join(
      tempRoot,
      'Nexowire-Setup-smoke.cmd',
    );
    await fs.writeFile(
      smokeSetupPath,
      smokeSetup,
      'ascii',
    );

    const command = path.join(system32, 'cmd.exe');
    const installed = await waitForChild(
      command,
      [
        '/d',
        '/c',
        smokeSetupPath,
      ],
      {
        cwd: tempRoot,
        env: cleanEnv,
      },
    );

    const installRoot = path.join(
      fakeLocalAppData,
      'Nexowire',
      'versions',
      buildId,
    );
    if (downloadSource === 'github') {
      assert.equal(fixtureRequests, 0, 'Public HTTPS test must never fall back to the fixture.');
    } else {
      assert.ok(fixtureRequests > 0, 'Installer did not request the fixture payload.');
    }
    if (scenario === 'checksum-mismatch') {
      assert.notEqual(installed.exitCode, 0, 'Corrupt payload must be rejected.');
      assert.match(installed.stdout + installed.stderr, /Nexowire payload checksum mismatch/);
      assert.doesNotMatch(installed.stdout, /^(?:launcher-ready|hourly-updater-simulated)$/m);
      await assert.rejects(fs.access(installRoot), { code: 'ENOENT' });
      process.stdout.write(JSON.stringify({
        testPassed: true, scenario, installed: false,
        setupExitCode: installed.exitCode, rejectedBeforeExtraction: true,
        ambientNodeNpmGitPwshAbsent: true, profileIsolated: true, profileKind,
        taskRegistrationAndBrowserSimulated: true, oauthOrDevicePairingVerified: false,
      }, null, 2) + '\n');
      return;
    }

    assert.equal(
      installed.exitCode,
      0,
      [
        'Windows setup smoke failed.',
        installed.stdout,
        installed.stderr,
      ].join('\n'),
    );
    assert.match(installed.stdout, /launcher-ready/);
    assert.match(installed.stdout, /hourly-updater-simulated/);

    const nodeExe = path.join(
      installRoot,
      'runtime',
      'node.exe',
    );
    const cli = path.join(
      installRoot,
      'app',
      'dist',
      'src',
      'cli.js',
    );
    const launcher = path.join(
      installRoot,
      'Nexowire.vbs',
    );
    const shortcut = path.join(
      installRoot,
      'Nexowire.lnk',
    );

    for (const required of [
      nodeExe,
      cli,
      launcher,
      shortcut,
    ]) {
      await fs.access(required);
    }

    const runtime = await waitForChild(
      nodeExe,
      [cli, '--version'],
      {
        cwd: installRoot,
        env: cleanEnv,
      },
    );
    assert.equal(runtime.exitCode, 0, runtime.stderr);
    assert.equal(runtime.stdout.trim(), version);

    // Test the actual hidden launcher with a disposable sentinel CLI, after
    // verifying the real packaged CLI version. Never start an Agent or OAuth
    // flow from CI, and never equate this fixture with account connectivity.
    const originalCli = await fs.readFile(cli);
    const marker = path.join(profile, 'launcher-result.json');
    try {
      await fs.writeFile(cli, [
        "import { writeFileSync } from 'node:fs';",
        'writeFileSync(process.env.NEXOWIRE_SMOKE_MARKER, JSON.stringify({args:process.argv.slice(2),executable:process.execPath}));',
      ].join('\n'));
      const hidden = await waitForChild(path.join(system32, 'wscript.exe'), ['//B', launcher], {
        cwd: installRoot,
        env: { ...cleanEnv, NEXOWIRE_SMOKE_MARKER: marker },
      });
      assert.equal(hidden.exitCode, 0, hidden.stderr);
      const deadline = Date.now() + 20_000;
      while (!(await fs.stat(marker).catch(() => null)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const readback = JSON.parse(await fs.readFile(marker, 'utf8')) as { args: string[]; executable: string };
      assert.deepEqual(readback.args, ['connect']);
      assert.equal(readback.executable.toLowerCase(), nodeExe.toLowerCase());
    } finally {
      await fs.writeFile(cli, originalCli);
    }

    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          version,
          buildId,
          setupExitCode: installed.exitCode,
          bundledRuntimeVerified: true,
          ambientNodeNpmGitPwshAbsent: true,
          profileIsolated: true,
          profileKind,
          downloadSource,
          payloadDownloadedOverPublicHttps: downloadSource === 'github',
          bootstrapDownloadedOverPublicHttps: downloadSource === 'github',
          taskRegistrationAndBrowserSimulated: true,
          oauthOrDevicePairingVerified: false,
          hiddenLauncherFixtureVerified: true,
          launcherVerified: true,
          shortcutVerified: true,
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await fs.rm(tempRoot, {
      recursive: true,
      force: true,
    });
  }
}

await main();
