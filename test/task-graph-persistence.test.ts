import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { executeCapability } from '../src/agent/executors.js';
import { PathPolicy } from '../src/agent/path-policy.js';
import { TaskGraphStore } from '../src/agent/task-graph-store.js';

const shell = process.platform === 'win32' ? 'pwsh' : 'bash';

function fixtureCommand(markerName = 'marker.txt'): string {
  return `node -e "require('fs').appendFileSync('${markerName}','ran\\n')"`;
}

test('task graph store marks in-flight jobs unknown after restart without persisting payloads', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-task-store-restart-'),
  );
  const stateFile = path.join(root, 'task-graphs.json');

  try {
    const first = new TaskGraphStore({ stateFile });
    await first.initialize();
    const graph = await first.prepare({
      id: 'restart-demo',
      specHash: 'a'.repeat(64),
      jobs: [
        { id: 'running-job', dependsOn: [] },
        { id: 'pending-job', dependsOn: ['running-job'] },
      ],
      resume: false,
      retryFailed: false,
      retryUnknown: false,
    });

    graph.status = 'running';
    graph.jobs[0]!.status = 'running';
    graph.jobs[0]!.attempts = 1;
    graph.jobs[0]!.startedAt = new Date().toISOString();
    await first.save(graph);

    const second = new TaskGraphStore({ stateFile });
    await second.initialize();
    const recovered = second.get('restart-demo');

    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.jobs[0]?.status, 'unknown');
    assert.equal(recovered.jobs[1]?.status, 'pending');

    const raw = await fs.readFile(stateFile, 'utf8');
    assert.equal(raw.includes('"command"'), false);
    assert.equal(raw.includes('"stdout"'), false);
    assert.equal(raw.includes('"stderr"'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('persisted task graph resume reuses succeeded jobs instead of rerunning them', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-task-store-resume-'),
  );
  const stateFile = path.join(root, 'task-graphs.json');
  const marker = path.join(root, 'marker.txt');
  const policy = new PathPolicy([root]);
  const store = new TaskGraphStore({ stateFile });
  await store.initialize();

  const spec = {
    graph_id: 'resume-demo',
    jobs: [
      {
        id: 'once',
        shell,
        cwd: root,
        command: fixtureCommand(),
      },
    ],
  };

  try {
    const first = (await executeCapability(
      'task.graph.run',
      spec,
      policy,
      { taskGraphs: store },
    )) as {
      data: {
        graphId: string;
        ok: boolean;
        results: Array<{
          id: string;
          status: string;
          attempts?: number;
          reused?: boolean;
        }>;
      };
    };

    assert.equal(first.data.graphId, 'resume-demo');
    assert.equal(first.data.ok, true);
    assert.equal(first.data.results[0]?.attempts, 1);
    assert.equal(first.data.results[0]?.reused, false);
    assert.equal((await fs.readFile(marker, 'utf8')).trim(), 'ran');

    const resumed = (await executeCapability(
      'task.graph.run',
      {
        ...spec,
        resume: true,
      },
      policy,
      { taskGraphs: store },
    )) as {
      data: {
        resumed: boolean;
        ok: boolean;
        results: Array<{
          status: string;
          attempts?: number;
          reused?: boolean;
        }>;
      };
    };

    assert.equal(resumed.data.resumed, true);
    assert.equal(resumed.data.ok, true);
    assert.equal(resumed.data.results[0]?.status, 'succeeded');
    assert.equal(resumed.data.results[0]?.attempts, 1);
    assert.equal(resumed.data.results[0]?.reused, true);
    assert.equal((await fs.readFile(marker, 'utf8')).trim(), 'ran');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('persistent task graph rejects mismatched resume specifications', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-task-store-mismatch-'),
  );
  const stateFile = path.join(root, 'task-graphs.json');
  const policy = new PathPolicy([root]);
  const store = new TaskGraphStore({ stateFile });
  await store.initialize();

  try {
    await executeCapability(
      'task.graph.run',
      {
        graph_id: 'mismatch-demo',
        jobs: [
          {
            id: 'job',
            shell,
            cwd: root,
            command: 'node -e "console.log(1)"',
          },
        ],
      },
      policy,
      { taskGraphs: store },
    );

    await assert.rejects(
      () =>
        executeCapability(
          'task.graph.run',
          {
            graph_id: 'mismatch-demo',
            resume: true,
            jobs: [
              {
                id: 'job',
                shell,
                cwd: root,
                command: 'node -e "console.log(2)"',
              },
            ],
          },
          policy,
          { taskGraphs: store },
        ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'TASK_GRAPH_SPEC_MISMATCH',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('unknown post-restart jobs require explicit retry_unknown before replay', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-task-store-unknown-'),
  );
  const stateFile = path.join(root, 'task-graphs.json');
  const marker = path.join(root, 'marker.txt');
  const policy = new PathPolicy([root]);

  const firstStore = new TaskGraphStore({ stateFile });
  await firstStore.initialize();
  const prepared = await firstStore.prepare({
    id: 'unknown-demo',
    specHash: 'b'.repeat(64),
    jobs: [{ id: 'job', dependsOn: [] }],
    resume: false,
    retryFailed: false,
    retryUnknown: false,
  });
  prepared.status = 'running';
  prepared.jobs[0]!.status = 'running';
  prepared.jobs[0]!.attempts = 1;
  prepared.jobs[0]!.startedAt = new Date().toISOString();
  await firstStore.save(prepared);

  const recoveredStore = new TaskGraphStore({ stateFile });
  await recoveredStore.initialize();

  const current = recoveredStore.get('unknown-demo');
  assert.equal(current.status, 'interrupted');
  assert.equal(current.jobs[0]?.status, 'unknown');

  // Recreate the exact hash used by runTaskGraph by creating a fresh persisted
  // graph through the public capability, then overwrite only the metadata with
  // an unknown-state checkpoint. This keeps the test coupled to the real
  // fingerprinting rules instead of duplicating them here.
  await recoveredStore.prune({ olderThanMs: 0 });
  const liveStore = new TaskGraphStore({ stateFile });
  await liveStore.initialize();

  const spec = {
    graph_id: 'unknown-live-demo',
    jobs: [
      {
        id: 'job',
        shell,
        cwd: root,
        command: fixtureCommand(),
      },
    ],
  };

  await executeCapability(
    'task.graph.run',
    spec,
    policy,
    { taskGraphs: liveStore },
  );
  await fs.rm(marker, { force: true });

  const checkpoint = liveStore.get('unknown-live-demo');
  checkpoint.status = 'running';
  checkpoint.jobs[0]!.status = 'running';
  checkpoint.jobs[0]!.completedAt = undefined;
  checkpoint.jobs[0]!.exitCode = undefined;
  checkpoint.jobs[0]!.timedOut = undefined;
  await liveStore.save(checkpoint);

  const restarted = new TaskGraphStore({ stateFile });
  await restarted.initialize();

  const noReplay = (await executeCapability(
    'task.graph.run',
    {
      ...spec,
      resume: true,
    },
    policy,
    { taskGraphs: restarted },
  )) as {
    data: {
      ok: boolean;
      summary: { unknown?: number };
      results: Array<{ status: string; reused?: boolean }>;
    };
  };

  assert.equal(noReplay.data.ok, false);
  assert.equal(noReplay.data.summary.unknown, 1);
  assert.equal(noReplay.data.results[0]?.status, 'unknown');
  await assert.rejects(() => fs.readFile(marker, 'utf8'), /ENOENT/);

  const explicitReplay = (await executeCapability(
    'task.graph.run',
    {
      ...spec,
      resume: true,
      retry_unknown: true,
    },
    policy,
    { taskGraphs: restarted },
  )) as {
    data: {
      ok: boolean;
      results: Array<{
        status: string;
        attempts?: number;
        reused?: boolean;
      }>;
    };
  };

  assert.equal(explicitReplay.data.ok, true);
  assert.equal(explicitReplay.data.results[0]?.status, 'succeeded');
  assert.equal(explicitReplay.data.results[0]?.attempts, 2);
  assert.equal(explicitReplay.data.results[0]?.reused, false);
  assert.equal((await fs.readFile(marker, 'utf8')).trim(), 'ran');

  await fs.rm(root, { recursive: true, force: true });
});

test('task graph list/get/prune capabilities expose payload-free metadata', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-task-store-control-'),
  );
  const stateFile = path.join(root, 'task-graphs.json');
  const policy = new PathPolicy([root]);
  const store = new TaskGraphStore({ stateFile });
  await store.initialize();

  try {
    await executeCapability(
      'task.graph.run',
      {
        graph_id: 'control-demo',
        jobs: [
          {
            id: 'job',
            shell,
            cwd: root,
            command: 'node -e "console.log(\'done\')"',
          },
        ],
      },
      policy,
      { taskGraphs: store },
    );

    const listed = (await executeCapability(
      'task.graph.list',
      {},
      policy,
      { taskGraphs: store },
    )) as { data: Array<{ id: string; status: string }> };
    assert.ok(
      listed.data.some(
        (graph) =>
          graph.id === 'control-demo' && graph.status === 'succeeded',
      ),
    );

    const fetched = (await executeCapability(
      'task.graph.get',
      { graph_id: 'control-demo' },
      policy,
      { taskGraphs: store },
    )) as {
      data: {
        id: string;
        jobs: Array<Record<string, unknown>>;
      };
    };
    assert.equal(fetched.data.id, 'control-demo');
    assert.equal('command' in fetched.data.jobs[0]!, false);
    assert.equal('stdout' in fetched.data.jobs[0]!, false);

    const pruned = (await executeCapability(
      'task.graph.prune',
      { older_than_ms: 0 },
      policy,
      { taskGraphs: store },
    )) as { data: { removed: number; remaining: number } };
    assert.equal(pruned.data.removed, 1);
    assert.equal(pruned.data.remaining, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
