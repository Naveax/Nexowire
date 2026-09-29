import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ArtifactStore } from '../src/agent/artifact-store.js';
import { PathPolicy } from '../src/agent/path-policy.js';

test('artifact store persists metadata and verifies file identity', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-artifacts-'),
  );
  const stateFile = path.join(root, 'state', 'artifacts.json');
  const artifactPath = path.join(root, 'build.bin');
  const policy = new PathPolicy([root]);

  try {
    await fs.writeFile(artifactPath, 'artifact-v1', 'utf8');

    const store = new ArtifactStore({ stateFile });
    await store.initialize();
    const registered = await store.register(
      {
        path: artifactPath,
        label: 'release',
        kind: 'build',
        sourceGraphId: 'build-graph',
        sourceJobId: 'package',
      },
      policy,
    );

    assert.equal(registered.path, await fs.realpath(artifactPath));
    assert.equal(registered.label, 'release');
    assert.equal(registered.kind, 'build');
    assert.equal(registered.size, Buffer.byteLength('artifact-v1'));
    assert.match(registered.sha256, /^[a-f0-9]{64}$/);

    const verified = await store.verify(registered.id, policy);
    assert.equal(verified.exists, true);
    assert.equal(verified.matches, true);
    assert.equal(verified.current?.sha256, registered.sha256);

    const raw = await fs.readFile(stateFile, 'utf8');
    assert.doesNotMatch(raw, /artifact-v1/);

    const reloaded = new ArtifactStore({ stateFile });
    await reloaded.initialize();
    const listed = await reloaded.list({
      graphId: 'build-graph',
      jobId: 'package',
      kind: 'build',
    });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, registered.id);

    await fs.writeFile(artifactPath, 'artifact-v2', 'utf8');
    const changed = await reloaded.verify(registered.id, policy);
    assert.equal(changed.exists, true);
    assert.equal(changed.matches, false);

    await fs.rm(artifactPath, { force: true });
    const missing = await reloaded.verify(registered.id, policy);
    assert.equal(missing.exists, false);
    assert.equal(missing.matches, false);

    const pruned = await reloaded.prune({
      removeMissing: true,
      policy,
    });
    assert.equal(pruned.removed, 1);
    assert.equal(pruned.remaining, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('artifact registration rejects directories and hash size overflow', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-artifacts-invalid-'),
  );
  const stateFile = path.join(root, 'artifacts.json');
  const policy = new PathPolicy([root]);
  const store = new ArtifactStore({ stateFile });

  try {
    await assert.rejects(
      () => store.register({ path: root }, policy),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ARTIFACT_NOT_FILE',
    );

    const file = path.join(root, 'large.txt');
    await fs.writeFile(file, '0123456789', 'utf8');
    await assert.rejects(
      () =>
        store.register(
          { path: file, maxHashBytes: 5 },
          policy,
        ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ARTIFACT_TOO_LARGE',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
