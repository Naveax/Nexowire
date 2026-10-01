import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface ReleaseMetadataResult {
  manifestPath: string;
  checksumPath: string;
  sha256: string;
  bytes: number;
  skills: number;
}

async function sha256File(file: string): Promise<{ sha256: string; bytes: number }> {
  const data = await fs.readFile(file);
  return {
    sha256: createHash('sha256').update(data).digest('hex'),
    bytes: data.length,
  };
}

function gitHead(cwd: string): string | null {
  const explicit = process.env.GITHUB_SHA?.trim();
  if (explicit) return explicit;

  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return null;
  const value = (result.stdout ?? '').trim();
  return /^[a-f0-9]{40}$/i.test(value) ? value : null;
}

export async function generateReleaseMetadata(options: {
  artifactPath: string;
  outputDir?: string;
  rootDir?: string;
}): Promise<ReleaseMetadataResult> {
  const root = path.resolve(options.rootDir ?? process.cwd());
  const artifactPath = path.resolve(options.artifactPath);
  const outputDir = path.resolve(options.outputDir ?? root);
  const artifactName = path.basename(artifactPath);

  const packageJson = JSON.parse(
    await fs.readFile(path.join(root, 'package.json'), 'utf8'),
  ) as {
    name?: unknown;
    version?: unknown;
    engines?: { node?: unknown };
  };

  if (packageJson.name !== 'nexowire') {
    throw new Error('Release metadata root is not the Nexowire package.');
  }
  if (typeof packageJson.version !== 'string' || !packageJson.version) {
    throw new Error('Nexowire package version is missing.');
  }

  const artifact = await sha256File(artifactPath);
  const skillRoot = path.join(root, 'skills');
  const skillNames = (await fs.readdir(skillRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const skillName of skillNames) {
    await fs.access(path.join(skillRoot, skillName, 'SKILL.md'));
  }

  const manifest = {
    schemaVersion: 1,
    package: {
      name: packageJson.name,
      version: packageJson.version,
      nodeEngine:
        typeof packageJson.engines?.node === 'string'
          ? packageJson.engines.node
          : null,
    },
    source: {
      repository: 'Naveax/Nexowire',
      commit: gitHead(root),
    },
    artifact: {
      file: artifactName,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    },
    skills: {
      count: skillNames.length,
      names: skillNames,
    },
  };

  await fs.mkdir(outputDir, { recursive: true });
  const manifestPath = path.join(outputDir, 'release-manifest.json');
  const checksumPath = path.join(outputDir, 'SHA256SUMS');
  await fs.writeFile(
    manifestPath,
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );
  await fs.writeFile(
    checksumPath,
    artifact.sha256 + '  ' + artifactName + '\n',
    'utf8',
  );

  return {
    manifestPath,
    checksumPath,
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    skills: skillNames.length,
  };
}

async function main(): Promise<void> {
  const artifactPath = process.argv[2];
  const outputDir = process.argv[3];
  if (!artifactPath) {
    throw new Error(
      'Usage: node --import tsx scripts/generate-release-metadata.ts <artifact.tgz> [output-dir]',
    );
  }
  const result = await generateReleaseMetadata({
    artifactPath,
    ...(outputDir ? { outputDir } : {}),
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

const entry = process.argv[1]
  ? path.resolve(process.argv[1])
  : undefined;
if (entry === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
