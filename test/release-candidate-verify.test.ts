import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { generateReleaseMetadata } from '../scripts/generate-release-metadata.js';
import { verifyReleaseCandidate } from '../scripts/verify-release-candidate.js';

async function fixture() {
  const root = process.cwd();
  const temp = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-release-verify-'),
  );
  const artifact = path.join(temp, 'nexowire-test.tgz');
  await fs.writeFile(
    artifact,
    Buffer.from('nexowire-release-candidate', 'utf8'),
  );

  const metadata = await generateReleaseMetadata({
    artifactPath: artifact,
    outputDir: temp,
    rootDir: root,
  });
  const packageJson = JSON.parse(
    await fs.readFile(path.join(root, 'package.json'), 'utf8'),
  ) as { name: string; version: string };

  const sbomPath = path.join(temp, 'nexowire-sbom.cdx.json');
  await fs.writeFile(
    sbomPath,
    JSON.stringify(
      {
        bomFormat: 'CycloneDX',
        specVersion: '1.6',
        metadata: {
          component: {
            type: 'application',
            name: 'Nexowire',
            version: packageJson.version,
            purl:
              'pkg:npm/' +
              packageJson.name +
              '@' +
              packageJson.version,
          },
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  return {
    root,
    temp,
    artifact,
    manifestPath: metadata.manifestPath,
    checksumPath: metadata.checksumPath,
    sbomPath,
  };
}

test('release candidate verifier independently accepts matching evidence', async () => {
  const f = await fixture();
  try {
    const result = await verifyReleaseCandidate({
      artifactPath: f.artifact,
      manifestPath: f.manifestPath,
      checksumPath: f.checksumPath,
      sbomPath: f.sbomPath,
      rootDir: f.root,
    });

    assert.equal(result.verified, true);
    assert.equal(result.package.name, 'nexowire');
    assert.equal(result.artifact.file, 'nexowire-test.tgz');
    assert.match(result.artifact.sha256, /^[a-f0-9]{64}$/);
    assert.ok(result.artifact.bytes > 0);
    assert.ok(result.skills > 0);
    assert.equal(result.sbomFormat, 'CycloneDX');
  } finally {
    await fs.rm(f.temp, { recursive: true, force: true });
  }
});

test('release candidate verifier rejects tarball tampering after metadata generation', async () => {
  const f = await fixture();
  try {
    await fs.appendFile(f.artifact, 'tampered', 'utf8');
    await assert.rejects(
      () =>
        verifyReleaseCandidate({
          artifactPath: f.artifact,
          manifestPath: f.manifestPath,
          checksumPath: f.checksumPath,
          sbomPath: f.sbomPath,
          rootDir: f.root,
        }),
      /SHA256SUMS does not match/,
    );
  } finally {
    await fs.rm(f.temp, { recursive: true, force: true });
  }
});

test('release candidate verifier rejects manifest and SBOM drift', async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(
      await fs.readFile(f.manifestPath, 'utf8'),
    ) as {
      skills: { count: number; names: string[] };
    };
    manifest.skills.names = [...manifest.skills.names].reverse();
    await fs.writeFile(
      f.manifestPath,
      JSON.stringify(manifest, null, 2) + '\n',
      'utf8',
    );

    await assert.rejects(
      () =>
        verifyReleaseCandidate({
          artifactPath: f.artifact,
          manifestPath: f.manifestPath,
          checksumPath: f.checksumPath,
          sbomPath: f.sbomPath,
          rootDir: f.root,
        }),
      /skill inventory does not match/,
    );

    await generateReleaseMetadata({
      artifactPath: f.artifact,
      outputDir: f.temp,
      rootDir: f.root,
    });
    const sbom = JSON.parse(
      await fs.readFile(f.sbomPath, 'utf8'),
    ) as { metadata: { component: { version: string } } };
    sbom.metadata.component.version = '999.0.0';
    await fs.writeFile(
      f.sbomPath,
      JSON.stringify(sbom, null, 2) + '\n',
      'utf8',
    );

    await assert.rejects(
      () =>
        verifyReleaseCandidate({
          artifactPath: f.artifact,
          manifestPath: f.manifestPath,
          checksumPath: f.checksumPath,
          sbomPath: f.sbomPath,
          rootDir: f.root,
        }),
      /SBOM root component does not match/,
    );
  } finally {
    await fs.rm(f.temp, { recursive: true, force: true });
  }
});
