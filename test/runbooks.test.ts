import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { RunbookStore } from '../src/agent/runbook-store.js';
import { executeDurableRunbook } from '../src/agent/runbooks.js';
import { isReadOnlyCapability } from '../src/protocol/capabilities.js';

async function tempStore() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-runbook-'),
  );
  const stateFile = path.join(root, 'runbooks.json');
  const store = new RunbookStore({ stateFile });
  await store.initialize();
  return { root, stateFile, store };
}

test('durable runbook persists dependency-aware task/assertion steps without payloads', async () => {
  const { root, stateFile, store } = await tempStore();
  const calls: Array<{ kind: string; input: unknown }> = [];

  try {
    const result = (await executeDurableRunbook(
      {
        runbook_id: 'release-1',
        steps: [
          {
            id: 'build',
            kind: 'task_graph',
            task_graph: {
              jobs: [
                {
                  id: 'compile',
                  command: 'echo build',
                },
              ],
            },
          },
          {
            id: 'verify',
            kind: 'assertions',
            depends_on: ['build'],
            assertions: {
              assertions: [
                {
                  id: 'file-check',
                  kind: 'file.exists',
                  path: 'artifact.txt',
                },
              ],
            },
          },
        ],
        max_parallel: 2,
      },
      store,
      {
        runTaskGraph: async (input) => {
          calls.push({ kind: 'task_graph', input });
          return {
            data: {
              ok: true,
              graphId:
                typeof input === 'object' &&
                input !== null &&
                'graph_id' in input
                  ? input.graph_id
                  : undefined,
              summary: {
                total: 1,
                succeeded: 1,
                failed: 0,
                blocked: 0,
              },
            },
          };
        },
        runAssertions: async (input) => {
          calls.push({ kind: 'assertions', input });
          return {
            data: {
              ok: true,
              passed: 1,
              failed: 0,
              skipped: 0,
            },
          };
        },
      },
    )) as {
      data: {
        ok: boolean;
        summary: {
          succeeded: number;
        };
        steps: Array<{
          id: string;
          status: string;
          taskGraphId?: string;
        }>;
      };
    };

    assert.equal(result.data.ok, true);
    assert.equal(result.data.summary.succeeded, 2);
    assert.deepEqual(
      result.data.steps.map((step) => [
        step.id,
        step.status,
      ]),
      [
        ['build', 'succeeded'],
        ['verify', 'succeeded'],
      ],
    );
    assert.equal(calls.length, 2);

    const taskInput = calls[0]?.input as Record<
      string,
      unknown
    >;
    assert.match(
      String(taskInput.graph_id),
      /^rb-[a-f0-9]{32}$/,
    );
    assert.equal(taskInput.resume, false);

    const raw = await fs.readFile(stateFile, 'utf8');
    assert.equal(raw.includes('echo build'), false);
    assert.equal(raw.includes('artifact.txt'), false);

    const reloaded = new RunbookStore({ stateFile });
    await reloaded.initialize();
    const persisted = reloaded.get('release-1');
    assert.equal(persisted.status, 'succeeded');
    assert.equal(persisted.runCount, 1);
    assert.equal(persisted.steps[0]?.status, 'succeeded');
    assert.equal(persisted.steps[1]?.status, 'succeeded');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('unknown assertion steps auto-retry safely after restart', async () => {
  const { root, stateFile, store } = await tempStore();

  const steps = [
    {
      id: 'verify',
      kind: 'assertions' as const,
      assertions: {
        assertions: [
          {
            id: 'alive',
            kind: 'process.pid_alive',
            pid: 1,
          },
        ],
      },
    },
  ];

  try {
    await executeDurableRunbook(
      {
        runbook_id: 'assert-restart',
        steps,
      },
      store,
      {
        runTaskGraph: async () => {
          throw new Error('unexpected task graph call');
        },
        runAssertions: async () => ({
          data: {
            ok: true,
            passed: 1,
            failed: 0,
            skipped: 0,
          },
        }),
      },
    );

    const persisted = JSON.parse(
      await fs.readFile(stateFile, 'utf8'),
    ) as {
      runbooks: Array<{
        id: string;
        status: string;
        steps: Array<{
          status: string;
          completedAt?: string;
          durationMs?: number;
        }>;
      }>;
    };
    const interrupted = persisted.runbooks.find(
      (entry) => entry.id === 'assert-restart',
    )!;
    interrupted.status = 'running';
    interrupted.steps[0]!.status = 'running';
    delete interrupted.steps[0]!.completedAt;
    delete interrupted.steps[0]!.durationMs;
    await fs.writeFile(
      stateFile,
      JSON.stringify(persisted, null, 2) + '\n',
      'utf8',
    );

    const reloaded = new RunbookStore({ stateFile });
    await reloaded.initialize();
    assert.equal(
      reloaded.get('assert-restart').steps[0]?.status,
      'unknown',
    );

    let assertionsCalls = 0;
    const result = (await executeDurableRunbook(
      {
        runbook_id: 'assert-restart',
        resume: true,
        steps,
      },
      reloaded,
      {
        runTaskGraph: async () => {
          throw new Error('unexpected task graph call');
        },
        runAssertions: async () => {
          assertionsCalls++;
          return {
            data: {
              ok: true,
              passed: 1,
              failed: 0,
              skipped: 0,
            },
          };
        },
      },
    )) as { data: { ok: boolean } };

    assert.equal(result.data.ok, true);
    assert.equal(assertionsCalls, 1);
    assert.equal(
      reloaded.get('assert-restart').steps[0]?.status,
      'succeeded',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('unknown task-graph step requires explicit retry_unknown', async () => {
  const { root, stateFile, store } = await tempStore();

  const steps = [
    {
      id: 'build',
      kind: 'task_graph' as const,
      task_graph: {
        jobs: [{ id: 'compile', command: 'echo build' }],
      },
    },
  ];

  try {
    await executeDurableRunbook(
      {
        runbook_id: 'task-restart',
        steps,
      },
      store,
      {
        runTaskGraph: async (input) => ({
          data: {
            ok: true,
            graphId:
              typeof input === 'object' &&
              input !== null &&
              'graph_id' in input
                ? input.graph_id
                : undefined,
            summary: { succeeded: 1 },
          },
        }),
        runAssertions: async () => ({ data: { ok: true } }),
      },
    );

    const persisted = JSON.parse(
      await fs.readFile(stateFile, 'utf8'),
    ) as {
      runbooks: Array<{
        id: string;
        status: string;
        steps: Array<{
          status: string;
          completedAt?: string;
          durationMs?: number;
        }>;
      }>;
    };
    const interrupted = persisted.runbooks.find(
      (entry) => entry.id === 'task-restart',
    )!;
    interrupted.status = 'running';
    interrupted.steps[0]!.status = 'running';
    delete interrupted.steps[0]!.completedAt;
    delete interrupted.steps[0]!.durationMs;
    await fs.writeFile(
      stateFile,
      JSON.stringify(persisted, null, 2) + '\n',
      'utf8',
    );

    const reloaded = new RunbookStore({ stateFile });
    await reloaded.initialize();
    let calls = 0;

    const blocked = (await executeDurableRunbook(
      {
        runbook_id: 'task-restart',
        resume: true,
        steps,
      },
      reloaded,
      {
        runTaskGraph: async () => {
          calls++;
          return { data: { ok: true } };
        },
        runAssertions: async () => ({ data: { ok: true } }),
      },
    )) as {
      data: {
        ok: boolean;
        summary: { unknown: number };
      };
    };

    assert.equal(blocked.data.ok, false);
    assert.equal(blocked.data.summary.unknown, 1);
    assert.equal(calls, 0);

    const retried = (await executeDurableRunbook(
      {
        runbook_id: 'task-restart',
        resume: true,
        retry_unknown: true,
        steps,
      },
      reloaded,
      {
        runTaskGraph: async () => {
          calls++;
          return {
            data: {
              ok: true,
              graphId: 'rb-' + '1'.repeat(32),
              summary: { succeeded: 1 },
            },
          };
        },
        runAssertions: async () => ({ data: { ok: true } }),
      },
    )) as { data: { ok: boolean } };

    assert.equal(retried.data.ok, true);
    assert.equal(calls, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runbook validates dependency cycles before persistence', async () => {
  const { root, store } = await tempStore();

  try {
    await assert.rejects(
      () =>
        executeDurableRunbook(
          {
            runbook_id: 'cycle',
            steps: [
              {
                id: 'a',
                kind: 'assertions',
                depends_on: ['b'],
                assertions: {
                  assertions: [
                    {
                      id: 'x',
                      kind: 'process.pid_alive',
                      pid: 1,
                    },
                  ],
                },
              },
              {
                id: 'b',
                kind: 'assertions',
                depends_on: ['a'],
                assertions: {
                  assertions: [
                    {
                      id: 'y',
                      kind: 'process.pid_alive',
                      pid: 1,
                    },
                  ],
                },
              },
            ],
          },
          store,
          {
            runTaskGraph: async () => ({ data: { ok: true } }),
            runAssertions: async () => ({ data: { ok: true } }),
          },
        ),
      /dependency cycle/,
    );
    assert.deepEqual(store.list(), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('runbook list/get are read-only while run/prune are mutations', () => {
  assert.equal(isReadOnlyCapability('runbook.list'), true);
  assert.equal(isReadOnlyCapability('runbook.get'), true);
  assert.equal(isReadOnlyCapability('runbook.run'), false);
  assert.equal(isReadOnlyCapability('runbook.prune'), false);
});
