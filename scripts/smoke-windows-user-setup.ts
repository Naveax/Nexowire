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
} {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--bundle-dir') {
      index++;
      if (index >= args.length) fail(arg + ' requires a value.');
      continue;
    }
    fail('Unknown Windows setup smoke option: ' + arg);
  }

  return {
    bundleDir: path.resolve(
      argValue(args, '--bundle-dir') ?? 'release-windows',
    ),
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
    child.once('exit', (code) => {
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

  const { bundleDir } = parseArgs(process.argv.slice(2));
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
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-setup-e2e-'),
  );
  const fakeLocalAppData = path.join(
    tempRoot,
    'LocalAppData',
  );
  await fs.mkdir(fakeLocalAppData, { recursive: true });

  const server = http.createServer((request, response) => {
    if (request.url !== '/Nexowire-Windows-x64.zip') {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/zip',
    });
    createReadStream(payload).pipe(response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      fail('Windows setup smoke HTTP server has no TCP address.');
    }
    const localUrl =
      'http://127.0.0.1:' +
      String(address.port) +
      '/Nexowire-Windows-x64.zip';

    let smokeSetup = setupText.replace(
      urlMatch[1]!,
      localUrl,
    );
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

    const command = process.env.ComSpec ?? 'cmd.exe';
    const installed = await waitForChild(
      command,
      [
        '/d',
        '/c',
        smokeSetupPath,
      ],
      {
        cwd: tempRoot,
        env: {
          ...process.env,
          LOCALAPPDATA: fakeLocalAppData,
        },
      },
    );

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

    const installRoot = path.join(
      fakeLocalAppData,
      'Nexowire',
      'versions',
      buildId,
    );
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
        env: process.env,
      },
    );
    assert.equal(runtime.exitCode, 0, runtime.stderr);
    assert.equal(runtime.stdout.trim(), version);

    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          version,
          buildId,
          setupExitCode: installed.exitCode,
          bundledRuntimeVerified: true,
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
