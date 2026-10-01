import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface ReleaseCandidateVerification {
  artifact: {
    file: string;
    bytes: number;
    sha256: string;
  };
  package: {
    name: string;
    version: string;
    nodeEngine: string | null;
  };
  sourceCommit: string | null;
  skills: number;
  sbomFormat: string;
  verified: true;
}

interface ReleaseManifest {
  schemaVersion: number;
  package: {
    name: string;
    version: string;
    nodeEngine: string | null;
  };
  source: {
    repository: string;
    commit: string | null;
  };
  artifact: {
    file: string;
    bytes: number;
    sha256: string;
  };
  skills: {
    count: number;
    names: string[];
  };
}

function fail(message: string): never {
  throw new Error('Release candidate verification failed: ' + message);
}

async function sha256File(
  file: string,
): Promise<{ sha256: string; bytes: number }> {
  const data = await fs.readFile(file);
  return {
    sha256: createHash('sha256').update(data).digest('hex'),
    bytes: data.length,
  };
}

function currentGitHead(cwd: string): string | null {
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

function assertSha256(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(value)
  ) {
    fail(label + ' is not a SHA-256 digest.');
  }
  return value.toLowerCase();
}

async function expectedSkills(root: string): Promise<string[]> {
  const skillRoot = path.join(root, 'skills');
  const names = (await fs.readdir(skillRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const name of names) {
    await fs.access(path.join(skillRoot, name, 'SKILL.md'));
  }
  return names;
}

function parseChecksumFile(
  content: string,
  artifactName: string,
): string {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length !== 1) {
    fail(
      'SHA256SUMS must contain exactly one canonical artifact entry.',
    );
  }

  const match = /^([a-f0-9]{64})\s{2}(.+)$/i.exec(lines[0]!);
  if (!match) {
    fail('SHA256SUMS has an invalid canonical entry.');
  }
  if (match[2] !== artifactName) {
    fail(
      'SHA256SUMS artifact name does not match the candidate tarball.',
    );
  }
  return match[1]!.toLowerCase();
}

export async function verifyReleaseCandidate(options: {
  artifactPath: string;
  manifestPath?: string;
  checksumPath?: string;
  sbomPath?: string;
  rootDir?: string;
  expectedCommit?: string | null;
}): Promise<ReleaseCandidateVerification> {
  const root = path.resolve(options.rootDir ?? process.cwd());
  const artifactPath = path.resolve(options.artifactPath);
  const manifestPath = path.resolve(
    options.manifestPath ?? path.join(root, 'release-manifest.json'),
  );
  const checksumPath = path.resolve(
    options.checksumPath ?? path.join(root, 'SHA256SUMS'),
  );
  const sbomPath = path.resolve(
    options.sbomPath ?? path.join(root, 'nexowire-sbom.cdx.json'),
  );
  const artifactName = path.basename(artifactPath);

  const packageJson = JSON.parse(
    await fs.readFile(path.join(root, 'package.json'), 'utf8'),
  ) as {
    name?: unknown;
    version?: unknown;
    private?: unknown;
    engines?: { node?: unknown };
  };

  if (packageJson.name !== 'nexowire') {
    fail('package name is not nexowire.');
  }
  if (
    typeof packageJson.version !== 'string' ||
    packageJson.version.length === 0
  ) {
    fail('package version is missing.');
  }
  if (packageJson.private !== true) {
    fail(
      'package.json must remain private until publication is explicitly authorized.',
    );
  }

  const nodeEngine =
    typeof packageJson.engines?.node === 'string'
      ? packageJson.engines.node
      : null;
  const artifact = await sha256File(artifactPath);

  const checksumDigest = parseChecksumFile(
    await fs.readFile(checksumPath, 'utf8'),
    artifactName,
  );
  if (checksumDigest !== artifact.sha256) {
    fail('SHA256SUMS does not match the candidate tarball bytes.');
  }

  const manifest = JSON.parse(
    await fs.readFile(manifestPath, 'utf8'),
  ) as ReleaseManifest;

  if (manifest.schemaVersion !== 1) {
    fail('release manifest schemaVersion is not 1.');
  }
  if (
    manifest.package?.name !== packageJson.name ||
    manifest.package?.version !== packageJson.version ||
    manifest.package?.nodeEngine !== nodeEngine
  ) {
    fail('release manifest package metadata does not match package.json.');
  }
  if (manifest.source?.repository !== 'Naveax/Nexowire') {
    fail('release manifest repository is not canonical.');
  }

  const expectedCommit =
    options.expectedCommit === undefined
      ? currentGitHead(root)
      : options.expectedCommit;
  if (
    expectedCommit !== null &&
    manifest.source?.commit !== expectedCommit
  ) {
    fail('release manifest source commit does not match the checkout.');
  }

  if (
    manifest.artifact?.file !== artifactName ||
    manifest.artifact?.bytes !== artifact.bytes ||
    assertSha256(
      manifest.artifact?.sha256,
      'release manifest artifact hash',
    ) !== artifact.sha256
  ) {
    fail('release manifest artifact metadata does not match the tarball.');
  }

  const skills = await expectedSkills(root);
  const manifestSkills = manifest.skills?.names;
  if (
    !Array.isArray(manifestSkills) ||
    manifest.skills.count !== skills.length ||
    manifestSkills.length !== skills.length ||
    manifestSkills.some(
      (name, index) => name !== skills[index],
    )
  ) {
    fail('release manifest skill inventory does not match the checkout.');
  }

  const sbom = JSON.parse(
    await fs.readFile(sbomPath, 'utf8'),
  ) as {
    bomFormat?: unknown;
    metadata?: {
      component?: {
        name?: unknown;
        version?: unknown;
        purl?: unknown;
      };
    };
  };

  if (sbom.bomFormat !== 'CycloneDX') {
    fail('SBOM bomFormat is not CycloneDX.');
  }
  const sbomName = sbom.metadata?.component?.name;
  const sbomVersion = sbom.metadata?.component?.version;
  const sbomPurl = sbom.metadata?.component?.purl;
  if (
    typeof sbomName !== 'string' ||
    sbomName.toLowerCase() !== packageJson.name.toLowerCase() ||
    sbomVersion !== packageJson.version
  ) {
    fail('SBOM root component does not match package.json.');
  }
  if (
    typeof sbomPurl === 'string' &&
    sbomPurl.toLowerCase() !==
      ('pkg:npm/' + packageJson.name + '@' + packageJson.version).toLowerCase()
  ) {
    fail('SBOM root component purl does not match package.json.');
  }

  return {
    artifact: {
      file: artifactName,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    },
    package: {
      name: packageJson.name,
      version: packageJson.version,
      nodeEngine,
    },
    sourceCommit: manifest.source.commit,
    skills: skills.length,
    sbomFormat: 'CycloneDX',
    verified: true,
  };
}

async function main(): Promise<void> {
  const artifactPath = process.argv[2];
  const manifestPath = process.argv[3];
  const checksumPath = process.argv[4];
  const sbomPath = process.argv[5];

  if (!artifactPath) {
    throw new Error(
      'Usage: node --import tsx scripts/verify-release-candidate.ts <artifact.tgz> [release-manifest.json] [SHA256SUMS] [nexowire-sbom.cdx.json]',
    );
  }

  const result = await verifyReleaseCandidate({
    artifactPath,
    ...(manifestPath ? { manifestPath } : {}),
    ...(checksumPath ? { checksumPath } : {}),
    ...(sbomPath ? { sbomPath } : {}),
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

const entry = process.argv[1]
  ? path.resolve(process.argv[1])
  : undefined;
if (entry === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
