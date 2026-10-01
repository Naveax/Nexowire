import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

interface PackFile {
  path: string;
  size?: number;
  mode?: number;
}

interface PackResult {
  filename: string;
  files: PackFile[];
  entryCount: number;
  packedSize: number;
  unpackedSize: number;
}

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    cwd: process.cwd(),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
}

const root = process.cwd();
const packageJson = JSON.parse(
  await fs.readFile(path.join(root, 'package.json'), 'utf8'),
) as {
  name?: string;
  version?: string;
  private?: boolean;
  bin?: Record<string, string>;
  files?: string[];
};

assert.equal(packageJson.name, 'nexowire');
assert.match(
  packageJson.version ?? '',
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
);
assert.equal(
  packageJson.private,
  true,
  'GitHub release artifacts remain private from npm publish by default.',
);
assert.equal(packageJson.bin?.nexowire, 'dist/src/cli.js');
assert.deepEqual(packageJson.files, [
  'dist/src',
  'skills',
  'README.md',
]);

const builtCli = path.join(root, 'dist', 'src', 'cli.js');
const cliText = await fs.readFile(builtCli, 'utf8');
assert.ok(
  cliText.startsWith('#!/usr/bin/env node'),
  'Built CLI must preserve the executable shebang.',
);

const help = run(process.execPath, [builtCli, '--help']);
assert.match(
  help,
  new RegExp(
    '^Nexowire ' + escapeRegExp(String(packageJson.version)),
    'm',
  ),
  'CLI help version must match package.json.',
);
const versionOutput = run(process.execPath, [builtCli, '--version']).trim();
assert.equal(
  versionOutput,
  packageJson.version,
  'CLI --version must match package.json.',
);

const skillRoot = path.join(root, 'skills');
const skillEntries = await fs.readdir(skillRoot, {
  withFileTypes: true,
});
const skillNames = skillEntries
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
assert.ok(skillNames.length >= 1, 'At least one bundled skill is required.');

for (const skillName of skillNames) {
  await fs.access(path.join(skillRoot, skillName, 'SKILL.md'));
}

function runNpm(args: string[]): string {
  if (process.platform !== 'win32') {
    return run('npm', args);
  }

  const command = [
    'npm.cmd',
    ...args.map((arg) =>
      '"' + arg.replace(/"/g, '""') + '"'
    ),
  ].join(' ');

  return run(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/s', '/c', command],
  );
}

const dryRun = runNpm(['pack', '--dry-run', '--json']);
const decoded = JSON.parse(dryRun) as PackResult[];
assert.equal(decoded.length, 1);
const pack = decoded[0]!;
const packedPaths = new Set(pack.files.map((file) => file.path));

for (const required of [
  'package.json',
  'README.md',
  'dist/src/cli.js',
]) {
  assert.ok(
    packedPaths.has(required),
    'Release package is missing required path: ' + required,
  );
}

for (const skillName of skillNames) {
  assert.ok(
    packedPaths.has('skills/' + skillName + '/SKILL.md'),
    'Release package is missing skill: ' + skillName,
  );
}

const deniedPrefixes = [
  '.github/',
  'src/',
  'test/',
  'scripts/',
  '.nexowire/',
];
const deniedExact = new Set([
  '.env',
  '.env.example',
  'HANDOFF.md',
  'PROJECT_STATE.json',
  'ROADMAP.md',
]);

for (const file of pack.files) {
  assert.equal(
    deniedExact.has(file.path) ||
      deniedPrefixes.some((prefix) => file.path.startsWith(prefix)),
    false,
    'Release package unexpectedly includes development-only path: ' + file.path,
  );
}

assert.ok(
  pack.entryCount <= 5_000,
  'Release package contains an unexpectedly large file count.',
);
assert.ok(
  pack.unpackedSize <= 16 * 1024 * 1024,
  'Release package exceeds the 16 MiB unpacked safety budget.',
);

const smokeRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), 'nexowire-release-smoke-'),
);
let installSmokeVerified = false;
let bundledSkillsVerified = false;
try {
  const packDir = path.join(smokeRoot, 'pack');
  const installDir = path.join(smokeRoot, 'install');
  const unrelatedCwd = path.join(smokeRoot, 'cwd');
  await fs.mkdir(packDir, { recursive: true });
  await fs.mkdir(installDir, { recursive: true });
  await fs.mkdir(unrelatedCwd, { recursive: true });

  const actualPack = JSON.parse(
    runNpm([
      'pack',
      '--json',
      '--pack-destination',
      packDir,
    ]),
  ) as PackResult[];
  assert.equal(actualPack.length, 1);
  const tarball = path.join(packDir, actualPack[0]!.filename);

  const installArgs = [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--prefix',
    installDir,
    tarball,
  ];
  if (process.platform === 'win32') {
    const command = [
      'npm.cmd',
      ...installArgs.map((arg) =>
        '"' + arg.replace(/"/g, '""') + '"'
      ),
    ].join(' ');
    const install = spawnSync(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', command],
      {
        encoding: 'utf8',
        windowsHide: true,
        cwd: unrelatedCwd,
      },
    );
    if (install.error) throw install.error;
    if (install.status !== 0) {
      throw new Error(
        'Clean tarball install failed:\n' +
          (install.stdout ?? '') +
          '\n' +
          (install.stderr ?? ''),
      );
    }
  } else {
    const install = spawnSync('npm', installArgs, {
      encoding: 'utf8',
      windowsHide: true,
      cwd: unrelatedCwd,
    });
    if (install.error) throw install.error;
    if (install.status !== 0) {
      throw new Error(
        'Clean tarball install failed:\n' +
          (install.stdout ?? '') +
          '\n' +
          (install.stderr ?? ''),
      );
    }
  }

  const installedRoot = path.join(
    installDir,
    'node_modules',
    'nexowire',
  );
  const installedCli = path.join(
    installedRoot,
    'dist',
    'src',
    'cli.js',
  );
  const installedHelp = spawnSync(
    process.execPath,
    [installedCli, '--help'],
    {
      encoding: 'utf8',
      windowsHide: true,
      cwd: unrelatedCwd,
    },
  );
  assert.equal(installedHelp.status, 0);
  assert.match(
    installedHelp.stdout ?? '',
    new RegExp(
      '^Nexowire ' +
        escapeRegExp(String(packageJson.version)),
      'm',
    ),
  );
  installSmokeVerified = true;

  const installedConfigUrl = pathToFileURL(
    path.join(installedRoot, 'dist', 'src', 'config.js'),
  ).href;
  const probe = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      [
        "import { loadConfig } from " +
          JSON.stringify(installedConfigUrl) + ";",
        "const config = loadConfig({}, process.cwd(), {",
        "  platformSingle: () => undefined,",
        "  platformList: () => undefined,",
        "});",
        "process.stdout.write(config.skillsDir);",
      ].join("\n"),
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      cwd: unrelatedCwd,
    },
  );
  assert.equal(
    probe.status,
    0,
    'Installed config probe failed: ' + (probe.stderr ?? ''),
  );
  const installedSkillsDir = (probe.stdout ?? '').trim();
  assert.equal(
    await fs.realpath(installedSkillsDir),
    await fs.realpath(path.join(installedRoot, 'skills')),
  );
  await fs.access(
    path.join(installedSkillsDir, 'browser-control', 'SKILL.md'),
  );
  bundledSkillsVerified = true;
} finally {
  await fs.rm(smokeRoot, { recursive: true, force: true });
}

process.stdout.write(
  JSON.stringify(
    {
      ready: true,
      package: packageJson.name,
      version: packageJson.version,
      filename: pack.filename,
      entries: pack.entryCount,
      packedBytes: pack.packedSize,
      unpackedBytes: pack.unpackedSize,
      skills: skillNames.length,
      cliHelpVerified: true,
      cliVersionVerified: true,
      installSmokeVerified,
      bundledSkillsVerified,
    },
    null,
    2,
  ) + '\n',
);
