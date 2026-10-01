import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { generateReleaseMetadata } from '../scripts/generate-release-metadata.js';

test('release metadata binds artifact checksum and bundled skill inventory', async () => {
  const root = process.cwd();
  const temp = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-release-metadata-'),
  );
  try {
    const artifact = path.join(temp, 'nexowire-test.tgz');
    const bytes = Buffer.from('nexowire-release-artifact', 'utf8');
    await fs.writeFile(artifact, bytes);

    const result = await generateReleaseMetadata({
      artifactPath: artifact,
      outputDir: temp,
      rootDir: root,
    });

    const expectedSha = createHash('sha256')
      .update(bytes)
      .digest('hex');
    assert.equal(result.sha256, expectedSha);
    assert.equal(result.bytes, bytes.length);
    assert.ok(result.skills >= 1);

    const manifest = JSON.parse(
      await fs.readFile(result.manifestPath, 'utf8'),
    ) as {
      schemaVersion: number;
      package: { name: string; version: string };
      artifact: { file: string; bytes: number; sha256: string };
      skills: { count: number; names: string[] };
    };
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.package.name, 'nexowire');
    assert.equal(manifest.artifact.file, 'nexowire-test.tgz');
    assert.equal(manifest.artifact.bytes, bytes.length);
    assert.equal(manifest.artifact.sha256, expectedSha);
    assert.equal(manifest.skills.count, manifest.skills.names.length);
    assert.equal(manifest.skills.count, result.skills);
    assert.ok(manifest.skills.names.includes('browser-control'));

    assert.equal(
      await fs.readFile(result.checksumPath, 'utf8'),
      expectedSha + '  nexowire-test.tgz\n',
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
