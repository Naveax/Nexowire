import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { executeCapability } from '../src/agent/executors.js';
import { PathPolicy } from '../src/agent/path-policy.js';
import { TaskGraphStore } from '../src/agent/task-graph-store.js';

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
