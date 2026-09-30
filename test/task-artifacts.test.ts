import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { executeCapability } from '../src/agent/executors.js';
import { PathPolicy } from '../src/agent/path-policy.js';
import { TaskGraphStore } from '../src/agent/task-graph-store.js';
import { isReadOnlyCapability } from '../src/protocol/capabilities.js';

const shell = process.platform === 'win32' ? 'pwsh' : 'bash';

test('task graph records verified artifact metadata without persisting artifact content', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-task-artifacts-'),
  );
  const stateFile = path.join(root, 'task-graphs.json');
  const artifact = path.join(root, 'artifact.txt');
  const policy = new PathPolicy([root]);
  const store = new TaskGraphStore({ stateFile });
  await store.initialize();

  try {
    const command =
      process.platform === 'win32'
        ? "Set-Content -LiteralPath 'artifact.txt' -Value 'artifact-secret-content' -NoNewline"
        : "printf 'artifact-secret-content' > artifact.txt";

    const result = (await executeCapability(
      'task.graph.run',
      {
        graph_id: 'artifact-demo',
        jobs: [
          {
            id: 'produce',
            shell,
            cwd: root,
            command,
            artifacts: ['artifact.txt'],
          },
        ],
      },
      policy,
      { taskGraphs: store },
    )) as {
      data: {
        ok: boolean;
        results: Array<{
          status: string;
          artifacts?: Array<{
            requestedPath: string;
            path: string;
            size: number;
            sha256: string;
          }>;
        }>;
      };
    };

    assert.equal(result.data.ok, true);
    assert.equal(result.data.results[0]?.status, 'succeeded');
    const metadata = result.data.results[0]?.artifacts?.[0];
    assert.ok(metadata);
    assert.equal(metadata.requestedPath, 'artifact.txt');
    assert.equal(metadata.path, artifact);
    assert.equal(metadata.size, 'artifact-secret-content'.length);
    assert.match(metadata.sha256, /^[a-f0-9]{64}$/);

    const checkpoint = store.get('artifact-demo');
    const saved = checkpoint.jobs[0]?.artifacts?.[0];
    assert.ok(saved);
    assert.equal(saved.path, artifact);
    assert.equal(saved.sha256, metadata.sha256);

    const raw = await fs.readFile(stateFile, 'utf8');
    assert.doesNotMatch(raw, /artifact-secret-content/);
    assert.match(raw, /artifact\.txt/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('task graph fails a job when a declared artifact is missing', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-task-artifacts-missing-'),
  );
  const stateFile = path.join(root, 'task-graphs.json');
  const policy = new PathPolicy([root]);
  const store = new TaskGraphStore({ stateFile });
  await store.initialize();

  try {
    const result = (await executeCapability(
      'task.graph.run',
      {
        graph_id: 'missing-artifact-demo',
        jobs: [
          {
            id: 'produce',
            shell,
            cwd: root,
            command:
              process.platform === 'win32'
                ? "Write-Output 'done'"
                : "printf 'done\n'",
            artifacts: ['missing.bin'],
          },
        ],
      },
      policy,
      { taskGraphs: store },
    )) as {
      data: {
        ok: boolean;
        results: Array<{
          status: string;
          error?: string;
        }>;
      };
    };

    assert.equal(result.data.ok, false);
    assert.equal(result.data.results[0]?.status, 'failed');
    assert.match(
      result.data.results[0]?.error ?? '',
      /ENOENT|no such file/i,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('task artifact lifecycle lists, re-verifies, detects changes, and detects missing files', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-task-artifact-lifecycle-'),
  );
  const stateFile = path.join(root, 'task-graphs.json');
  const artifact = path.join(root, 'artifact.txt');
  const policy = new PathPolicy([root]);
  const store = new TaskGraphStore({ stateFile });
  await store.initialize();

  try {
    const original = 'artifact-secret-content';
    const changed = 'artifact-secret-contXnt';
    assert.equal(changed.length, original.length);

    const command =
      process.platform === 'win32'
        ? "Set-Content -LiteralPath 'artifact.txt' -Value 'artifact-secret-content' -NoNewline"
        : "printf 'artifact-secret-content' > artifact.txt";

    const run = (await executeCapability(
      'task.graph.run',
      {
        graph_id: 'artifact-lifecycle',
        jobs: [
          {
            id: 'produce',
            shell,
            cwd: root,
            command,
            artifacts: ['artifact.txt'],
          },
        ],
      },
      policy,
      { taskGraphs: store },
    )) as {
      data: { ok: boolean };
    };
    assert.equal(run.data.ok, true);

    const listed = (await executeCapability(
      'task.artifact.list',
      {
        graph_id: 'artifact-lifecycle',
        job_id: 'produce',
        limit: 10,
      },
      policy,
      { taskGraphs: store },
    )) as {
      data: {
        artifacts: Array<{
          graphId: string;
          graphStatus: string;
          jobId: string;
          jobStatus: string;
          path: string;
          size: number;
          sha256: string;
        }>;
      };
    };
    assert.equal(listed.data.artifacts.length, 1);
    assert.equal(listed.data.artifacts[0]?.graphId, 'artifact-lifecycle');
    assert.equal(listed.data.artifacts[0]?.jobId, 'produce');
    assert.equal(listed.data.artifacts[0]?.path, artifact);
    assert.equal(listed.data.artifacts[0]?.size, original.length);
    assert.match(
      listed.data.artifacts[0]?.sha256 ?? '',
      /^[a-f0-9]{64}$/,
    );

    const verified = (await executeCapability(
      'task.artifact.verify',
      {
        graph_id: 'artifact-lifecycle',
        max_bytes_each: 1_000_000,
      },
      policy,
      { taskGraphs: store },
    )) as {
      data: {
        ok: boolean;
        summary: {
          total: number;
          verified: number;
          changed: number;
          missing: number;
          unverified: number;
          errors: number;
        };
        artifacts: Array<{
          status: string;
          verified: boolean;
          actual?: { sha256?: string };
        }>;
      };
    };
    assert.equal(verified.data.ok, true);
    assert.deepEqual(verified.data.summary, {
      total: 1,
      verified: 1,
      changed: 0,
      missing: 0,
      unverified: 0,
      errors: 0,
    });
    assert.equal(verified.data.artifacts[0]?.status, 'verified');

    await fs.writeFile(artifact, changed, 'utf8');
    const changedResult = (await executeCapability(
      'task.artifact.verify',
      { graph_id: 'artifact-lifecycle' },
      policy,
      { taskGraphs: store },
    )) as {
      data: {
        ok: boolean;
        summary: { changed: number };
        artifacts: Array<{
          status: string;
          actual?: { sha256?: string };
          sha256: string;
        }>;
      };
    };
    assert.equal(changedResult.data.ok, false);
    assert.equal(changedResult.data.summary.changed, 1);
    assert.equal(changedResult.data.artifacts[0]?.status, 'changed');
    assert.notEqual(
      changedResult.data.artifacts[0]?.actual?.sha256,
      changedResult.data.artifacts[0]?.sha256,
    );

    await fs.writeFile(artifact, original, 'utf8');
    const bounded = (await executeCapability(
      'task.artifact.verify',
      {
        graph_id: 'artifact-lifecycle',
        max_bytes_each: 4,
      },
      policy,
      { taskGraphs: store },
    )) as {
      data: {
        summary: { unverified: number };
        artifacts: Array<{
          status: string;
          error?: { code?: string };
        }>;
      };
    };
    assert.equal(bounded.data.summary.unverified, 1);
    assert.equal(bounded.data.artifacts[0]?.status, 'unverified');
    assert.equal(
      bounded.data.artifacts[0]?.error?.code,
      'ARTIFACT_VERIFY_LIMIT',
    );

    await fs.unlink(artifact);
    const missing = (await executeCapability(
      'task.artifact.verify',
      { graph_id: 'artifact-lifecycle' },
      policy,
      { taskGraphs: store },
    )) as {
      data: {
        summary: { missing: number };
        artifacts: Array<{
          status: string;
          error?: { code?: string };
        }>;
      };
    };
    assert.equal(missing.data.summary.missing, 1);
    assert.equal(missing.data.artifacts[0]?.status, 'missing');
    assert.equal(missing.data.artifacts[0]?.error?.code, 'ENOENT');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('task artifact hashing is bounded during collection', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-task-artifact-bounded-'),
  );
  const stateFile = path.join(root, 'task-graphs.json');
  const policy = new PathPolicy([root]);
  const store = new TaskGraphStore({ stateFile });
  await store.initialize();

  try {
    const command =
      process.platform === 'win32'
        ? "Set-Content -LiteralPath 'large.txt' -Value '1234567890' -NoNewline"
        : "printf '1234567890' > large.txt";

    const result = (await executeCapability(
      'task.graph.run',
      {
        graph_id: 'artifact-bounded',
        jobs: [
          {
            id: 'produce',
            shell,
            cwd: root,
            command,
            artifacts: ['large.txt'],
            artifact_max_bytes: 4,
          },
        ],
      },
      policy,
      { taskGraphs: store },
    )) as {
      data: {
        ok: boolean;
        results: Array<{ status: string; error?: string }>;
      };
    };

    assert.equal(result.data.ok, false);
    assert.equal(result.data.results[0]?.status, 'failed');
    assert.match(
      result.data.results[0]?.error ?? '',
      /exceeds hash max_bytes/i,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('task artifact list and verify are read-only capabilities', () => {
  assert.equal(isReadOnlyCapability('task.artifact.list'), true);
  assert.equal(isReadOnlyCapability('task.artifact.verify'), true);
});
