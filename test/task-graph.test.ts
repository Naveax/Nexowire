import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { executeCapability } from '../src/agent/executors.js';
import { PathPolicy } from '../src/agent/path-policy.js';

const shell = process.platform === 'win32' ? 'pwsh' : 'bash';

test('task graph runs independent jobs in parallel and waits for dependencies', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-task-graph-'));
  const policy = new PathPolicy([root]);

  const result = (await executeCapability(
    'task.graph.run',
    {
      max_parallel: 2,
      total_timeout_ms: 10_000,
      jobs: [
        {
          id: 'a',
          shell,
          cwd: root,
          command:
            'node -e "setTimeout(() => { console.log(\'a-done\'); }, 250)"',
        },
        {
          id: 'b',
          shell,
          cwd: root,
          command:
            'node -e "setTimeout(() => { console.log(\'b-done\'); }, 250)"',
        },
        {
          id: 'c',
          shell,
          cwd: root,
          depends_on: ['a', 'b'],
          command: 'node -e "console.log(\'c-done\')"',
        },
      ],
    },
    policy,
  )) as {
    data: {
      ok: boolean;
      summary: {
        total: number;
        succeeded: number;
        failed: number;
        blocked: number;
      };
      results: Array<{
        id: string;
        status: string;
        startedAt?: string;
        completedAt?: string;
        stdout?: string;
      }>;
    };
  };

  assert.equal(result.data.ok, true);
  assert.deepEqual(result.data.summary, {
    total: 3,
    succeeded: 3,
    failed: 0,
    blocked: 0,
  });

  const a = result.data.results.find((item) => item.id === 'a');
  const b = result.data.results.find((item) => item.id === 'b');
  const c = result.data.results.find((item) => item.id === 'c');
  assert.ok(a?.startedAt && a.completedAt);
  assert.ok(b?.startedAt && b.completedAt);
  assert.ok(c?.startedAt && c.completedAt);

  const latestIndependentStart = Math.max(
    Date.parse(a.startedAt),
    Date.parse(b.startedAt),
  );
  const earliestIndependentEnd = Math.min(
    Date.parse(a.completedAt),
    Date.parse(b.completedAt),
  );
  assert.ok(
    latestIndependentStart <= earliestIndependentEnd,
    'independent jobs should overlap',
  );

  assert.ok(
    Date.parse(c.startedAt) >=
      Math.max(Date.parse(a.completedAt), Date.parse(b.completedAt)),
    'dependent job must start only after both dependencies finish',
  );
  assert.match(a.stdout ?? '', /a-done/);
  assert.match(b.stdout ?? '', /b-done/);
  assert.match(c.stdout ?? '', /c-done/);

  await fs.rm(root, { recursive: true, force: true });
});

test('task graph blocks dependents after failure but lets independent work finish', async () => {
  const policy = new PathPolicy(['*']);
  const result = (await executeCapability(
    'task.graph.run',
    {
      max_parallel: 2,
      jobs: [
        {
          id: 'fail',
          shell,
          command: 'node -e "process.exit(7)"',
        },
        {
          id: 'dependent',
          shell,
          depends_on: ['fail'],
          command: 'node -e "console.log(\'must-not-run\')"',
        },
        {
          id: 'independent',
          shell,
          command: 'node -e "console.log(\'independent-ok\')"',
        },
      ],
    },
    policy,
  )) as {
    data: {
      ok: boolean;
      summary: { succeeded: number; failed: number; blocked: number };
      results: Array<{
        id: string;
        status: string;
        exitCode?: number | null;
        stdout?: string;
        blockedBy?: string[];
      }>;
    };
  };

  assert.equal(result.data.ok, false);
  assert.equal(result.data.summary.succeeded, 1);
  assert.equal(result.data.summary.failed, 1);
  assert.equal(result.data.summary.blocked, 1);

  const failed = result.data.results.find((item) => item.id === 'fail');
  const dependent = result.data.results.find((item) => item.id === 'dependent');
  const independent = result.data.results.find(
    (item) => item.id === 'independent',
  );
  assert.equal(failed?.status, 'failed');
  assert.notEqual(failed?.exitCode, 0);
  assert.equal(dependent?.status, 'blocked');
  assert.deepEqual(dependent?.blockedBy, ['fail']);
  assert.equal(dependent?.stdout, undefined);
  assert.equal(independent?.status, 'succeeded');
  assert.match(independent?.stdout ?? '', /independent-ok/);
});

test('task graph stop_on_failure blocks later independent jobs', async () => {
  const policy = new PathPolicy(['*']);
  const result = (await executeCapability(
    'task.graph.run',
    {
      max_parallel: 1,
      stop_on_failure: true,
      jobs: [
        {
          id: 'first',
          shell,
          command: 'node -e "process.exit(2)"',
        },
        {
          id: 'later',
          shell,
          command: 'node -e "console.log(\'must-not-run\')"',
        },
      ],
    },
    policy,
  )) as {
    data: {
      results: Array<{
        id: string;
        status: string;
        blockedBy?: string[];
      }>;
    };
  };

  assert.equal(
    result.data.results.find((item) => item.id === 'first')?.status,
    'failed',
  );
  const later = result.data.results.find((item) => item.id === 'later');
  assert.equal(later?.status, 'blocked');
  assert.deepEqual(later?.blockedBy, ['stop_on_failure']);
});

test('task graph rejects cycles and duplicate ids before executing anything', async () => {
  const policy = new PathPolicy(['*']);

  await assert.rejects(
    () =>
      executeCapability(
        'task.graph.run',
        {
          jobs: [
            {
              id: 'a',
              shell,
              command: 'node -e "console.log(1)"',
              depends_on: ['b'],
            },
            {
              id: 'b',
              shell,
              command: 'node -e "console.log(2)"',
              depends_on: ['a'],
            },
          ],
        },
        policy,
      ),
    /dependency cycle/,
  );

  await assert.rejects(
    () =>
      executeCapability(
        'task.graph.run',
        {
          jobs: [
            { id: 'same', shell, command: 'node -e "console.log(1)"' },
            { id: 'same', shell, command: 'node -e "console.log(2)"' },
          ],
        },
        policy,
      ),
    /Duplicate task graph job id/,
  );
});

test('task graph total timeout bounds a long-running job', async () => {
  const policy = new PathPolicy(['*']);
  const started = Date.now();
  const result = (await executeCapability(
    'task.graph.run',
    {
      total_timeout_ms: 300,
      default_timeout_ms: 5_000,
      jobs: [
        {
          id: 'slow',
          shell,
          command:
            'node -e "setTimeout(() => console.log(\'too-late\'), 5000)"',
        },
      ],
    },
    policy,
  )) as {
    data: {
      ok: boolean;
      totalTimeoutMs: number;
      results: Array<{
        id: string;
        status: string;
        timedOut?: boolean;
      }>;
    };
  };

  assert.equal(result.data.ok, false);
  assert.equal(result.data.totalTimeoutMs, 300);
  const slow = result.data.results[0];
  assert.equal(slow?.status, 'failed');
  assert.equal(slow?.timedOut, true);
  assert.ok(Date.now() - started < 3_000);
});
