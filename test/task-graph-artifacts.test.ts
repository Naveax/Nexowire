import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ArtifactStore } from '../src/agent/artifact-store.js';
import { executeCapability } from '../src/agent/executors.js';
import { PathPolicy } from '../src/agent/path-policy.js';
import { TaskGraphStore } from '../src/agent/task-graph-store.js';

const shell = process.platform === 'win32' ? 'pwsh' : 'bash';

test('task graph registers declared artifacts and reuses references on resume', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-task-artifacts-'),
  );
  const policy = new PathPolicy([root]);
  const taskGraphs = new TaskGraphStore({
    stateFile: path.join(root, 'task-graphs.json'),
  });
  const artifacts = new ArtifactStore({
    stateFile: path.join(root, 'artifacts.json'),
  });
  await Promise.all([
    taskGraphs.initialize(),
    artifacts.initialize(),
  ]);

  const spec = {
    graph_id: 'artifact-graph',
    jobs: [
      {
        id: 'build',
        shell,
        cwd: root,
        command:
          'node -e "require(\'fs\').writeFileSync(\'dist.txt\',\'artifact-v1\')"',
        artifacts: [
          {
            path: 'dist.txt',
            label: 'distribution',
            kind: 'build',
          },
        ],
      },
    ],
  };

  try {
    const first = (await executeCapability(
      'task.graph.run',
      spec,
      policy,
      { taskGraphs, artifacts },
    )) as {
      data: {
        ok: boolean;
        results: Array<{
          id: string;
          status: string;
          artifactIds?: string[];
        }>;
      };
    };

    assert.equal(first.data.ok, true);
    const built = first.data.results[0];
    assert.equal(built?.status, 'succeeded');
    assert.equal(built?.artifactIds?.length, 1);

    const artifactId = built!.artifactIds![0]!;
    const listed = await artifacts.list({
      graphId: 'artifact-graph',
      jobId: 'build',
    });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, artifactId);
    assert.equal(listed[0]?.kind, 'build');
    assert.equal(listed[0]?.label, 'distribution');

    const checkpoint = taskGraphs.get('artifact-graph');
    assert.deepEqual(
      checkpoint.jobs[0]?.artifactIds,
      [artifactId],
    );

    const resumed = (await executeCapability(
      'task.graph.run',
      {
        ...spec,
        resume: true,
      },
      policy,
      { taskGraphs, artifacts },
    )) as {
      data: {
        ok: boolean;
        results: Array<{
          reused?: boolean;
          artifactIds?: string[];
        }>;
      };
    };

    assert.equal(resumed.data.ok, true);
    assert.equal(resumed.data.results[0]?.reused, true);
    assert.deepEqual(
      resumed.data.results[0]?.artifactIds,
      [artifactId],
    );
    assert.equal(
      (await artifacts.list({ graphId: 'artifact-graph' }))
        .length,
      1,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('successful command fails its task when a declared artifact is missing', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-task-artifact-missing-'),
  );
  const policy = new PathPolicy([root]);
  const artifacts = new ArtifactStore({
    stateFile: path.join(root, 'artifacts.json'),
  });
  await artifacts.initialize();

  try {
    const result = (await executeCapability(
      'task.graph.run',
      {
        jobs: [
          {
            id: 'build',
            shell,
            cwd: root,
            command: 'node -e "process.exit(0)"',
            artifacts: [
              {
                path: 'missing.bin',
                kind: 'build',
              },
            ],
          },
        ],
      },
      policy,
      { artifacts },
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
    assert.equal((await artifacts.list()).length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
