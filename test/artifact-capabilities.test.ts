import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ArtifactStore } from '../src/agent/artifact-store.js';
import { executeCapability } from '../src/agent/executors.js';
import { PathPolicy } from '../src/agent/path-policy.js';
import { isReadOnlyCapability } from '../src/protocol/capabilities.js';

test('artifact capabilities register, list, get, verify, and prune metadata', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-artifact-capabilities-'),
  );
  const policy = new PathPolicy([root]);
  const store = new ArtifactStore({
    stateFile: path.join(root, 'artifacts.json'),
  });
  await store.initialize();

  try {
    const file = path.join(root, 'report.json');
    await fs.writeFile(file, '{"ok":true}', 'utf8');

    const registered = (await executeCapability(
      'artifact.register',
      {
        path: file,
        label: 'test-report',
        kind: 'report',
        source_graph_id: 'checks',
        source_job_id: 'unit',
      },
      policy,
      { artifacts: store },
    )) as {
      data: { id: string; sha256: string; size: number };
    };
    assert.match(registered.data.id, /^[0-9a-f-]{36}$/i);
    assert.match(registered.data.sha256, /^[a-f0-9]{64}$/);

    const listed = (await executeCapability(
      'artifact.list',
      {
        graph_id: 'checks',
        job_id: 'unit',
        kind: 'report',
      },
      policy,
      { artifacts: store },
    )) as { data: Array<{ id: string }> };
    assert.deepEqual(
      listed.data.map((entry) => entry.id),
      [registered.data.id],
    );

    const fetched = (await executeCapability(
      'artifact.get',
      { artifact_id: registered.data.id },
      policy,
      { artifacts: store },
    )) as { data: { label?: string } };
    assert.equal(fetched.data.label, 'test-report');

    const verified = (await executeCapability(
      'artifact.verify',
      { artifact_id: registered.data.id },
      policy,
      { artifacts: store },
    )) as { data: { matches: boolean; exists: boolean } };
    assert.equal(verified.data.exists, true);
    assert.equal(verified.data.matches, true);

    await fs.rm(file);
    const missing = (await executeCapability(
      'artifact.verify',
      { artifact_id: registered.data.id },
      policy,
      { artifacts: store },
    )) as { data: { matches: boolean; exists: boolean } };
    assert.equal(missing.data.exists, false);
    assert.equal(missing.data.matches, false);

    const pruned = (await executeCapability(
      'artifact.prune',
      { remove_missing: true },
      policy,
      { artifacts: store },
    )) as { data: { removed: number; remaining: number } };
    assert.equal(pruned.data.removed, 1);
    assert.equal(pruned.data.remaining, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('artifact reads are failover-safe while registry mutations are not', () => {
  for (const capability of [
    'artifact.list',
    'artifact.get',
    'artifact.verify',
  ]) {
    assert.equal(isReadOnlyCapability(capability), true, capability);
  }
  for (const capability of [
    'artifact.register',
    'artifact.prune',
  ]) {
    assert.equal(isReadOnlyCapability(capability), false, capability);
  }
});
