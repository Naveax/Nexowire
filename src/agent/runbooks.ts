import { createHash } from 'node:crypto';
import * as z from 'zod';
import type {
  RunbookCheckpoint,
  RunbookCheckpointStep,
  RunbookStore,
} from './runbook-store.js';

const RunbookIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const BaseStepSchema = z.object({
  id: RunbookIdSchema,
  depends_on: z.array(RunbookIdSchema).max(31).default([]),
});

const TaskGraphStepSchema = BaseStepSchema.extend({
  kind: z.literal('task_graph'),
  task_graph: z.record(z.string(), z.unknown()),
});

const AssertionStepSchema = BaseStepSchema.extend({
  kind: z.literal('assertions'),
  assertions: z.record(z.string(), z.unknown()),
});

const StepSchema = z.discriminatedUnion('kind', [
  TaskGraphStepSchema,
  AssertionStepSchema,
]);

const RunInputSchema = z.object({
  runbook_id: RunbookIdSchema,
  resume: z.boolean().default(false),
  retry_failed: z.boolean().default(false),
  retry_unknown: z.boolean().default(false),
  steps: z.array(StepSchema).min(1).max(64),
  max_parallel: z.number().int().min(1).max(8).default(2),
  stop_on_failure: z.boolean().default(false),
  total_timeout_ms: z
    .number()
    .int()
    .min(100)
    .max(7_200_000)
    .default(1_800_000),
});

export interface RunbookExecutionCallbacks {
  runTaskGraph(input: unknown): Promise<unknown>;
  runAssertions(input: unknown): Promise<unknown>;
}

interface RuntimeStep {
  id: string;
  kind: 'task_graph' | 'assertions';
  dependsOn: string[];
  status: RunbookCheckpointStep['status'];
  attempts: number;
  reused?: boolean;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  blockedBy?: string[];
  taskGraphId?: string;
  errorCode?: string;
  result?: Record<string, unknown>;
}

function validateDependencies(
  steps: z.infer<typeof StepSchema>[],
): void {
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) {
      throw new Error('Duplicate runbook step id: ' + step.id);
    }
    ids.add(step.id);
  }

  for (const step of steps) {
    for (const dependency of step.depends_on) {
      if (dependency === step.id) {
        throw new Error(
          `Runbook step "${step.id}" cannot depend on itself.`,
        );
      }
      if (!ids.has(dependency)) {
        throw new Error(
          `Runbook step "${step.id}" depends on unknown step "${dependency}".`,
        );
      }
    }
  }

  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const step of steps) {
    indegree.set(step.id, step.depends_on.length);
    for (const dependency of step.depends_on) {
      const bucket = children.get(dependency) ?? [];
      bucket.push(step.id);
      children.set(dependency, bucket);
    }
  }

  const queue = steps
    .filter((step) => (indegree.get(step.id) ?? 0) === 0)
    .map((step) => step.id);
  let visited = 0;

  while (queue.length > 0) {
    const id = queue.shift()!;
    visited++;
    for (const child of children.get(id) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) queue.push(child);
    }
  }

  if (visited !== steps.length) {
    throw new Error('Runbook contains a dependency cycle.');
  }
}

function taskGraphId(runbookId: string, stepId: string): string {
  return (
    'rb-' +
    createHash('sha256')
      .update(runbookId + '\0' + stepId, 'utf8')
      .digest('hex')
      .slice(0, 32)
  );
}

function resultData(value: unknown): Record<string, unknown> | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('data' in value)
  ) {
    return undefined;
  }
  const data = value.data;
  return typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : undefined;
}

function summarize(
  kind: RuntimeStep['kind'],
  value: unknown,
): {
  ok: boolean;
  summary: Record<string, unknown>;
} {
  const data = resultData(value);
  const ok = data?.ok === true;

  if (kind === 'task_graph') {
    return {
      ok,
      summary: {
        ...(typeof data?.graphId === 'string'
          ? { graphId: data.graphId }
          : {}),
        ...(typeof data?.specHash === 'string'
          ? { specHash: data.specHash }
          : {}),
        ...(typeof data?.resumed === 'boolean'
          ? { resumed: data.resumed }
          : {}),
        ...(typeof data?.durationMs === 'number'
          ? { durationMs: data.durationMs }
          : {}),
        ...(typeof data?.summary === 'object' &&
        data.summary !== null &&
        !Array.isArray(data.summary)
          ? { summary: data.summary }
          : {}),
      },
    };
  }

  return {
    ok,
    summary: {
      ...(typeof data?.passed === 'number'
        ? { passed: data.passed }
        : {}),
      ...(typeof data?.failed === 'number'
        ? { failed: data.failed }
        : {}),
      ...(typeof data?.skipped === 'number'
        ? { skipped: data.skipped }
        : {}),
    },
  };
}

function errorCode(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : 'RUNBOOK_STEP_FAILED';
}

export async function executeDurableRunbook(
  input: unknown,
  store: RunbookStore,
  callbacks: RunbookExecutionCallbacks,
): Promise<unknown> {
  const parsed = RunInputSchema.parse(input);
  validateDependencies(parsed.steps);

  if (parsed.resume === false) {
    if (parsed.retry_failed || parsed.retry_unknown) {
      throw new Error(
        'retry_failed/retry_unknown require resume=true.',
      );
    }
  }

  const normalizedSpec = {
    steps: parsed.steps,
    max_parallel: parsed.max_parallel,
    stop_on_failure: parsed.stop_on_failure,
    total_timeout_ms: parsed.total_timeout_ms,
  };
  const specHash = createHash('sha256')
    .update(JSON.stringify(normalizedSpec), 'utf8')
    .digest('hex');

  let checkpoint = await store.prepare({
    id: parsed.runbook_id,
    specHash,
    steps: parsed.steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      dependsOn: [...step.depends_on],
      ...(step.kind === 'task_graph'
        ? {
            taskGraphId: taskGraphId(
              parsed.runbook_id,
              step.id,
            ),
          }
        : {}),
    })),
    resume: parsed.resume,
    retryFailed: parsed.retry_failed,
    retryUnknown: parsed.retry_unknown,
  });

  const runtime = new Map<string, RuntimeStep>();
  for (const step of parsed.steps) {
    const saved = checkpoint.steps.find(
      (candidate) => candidate.id === step.id,
    );
    if (!saved) {
      throw new Error(
        'Persisted runbook is missing step: ' + step.id,
      );
    }
    runtime.set(step.id, {
      id: step.id,
      kind: step.kind,
      dependsOn: [...step.depends_on],
      status: saved.status,
      attempts: saved.attempts,
      ...(saved.startedAt
        ? { startedAt: saved.startedAt }
        : {}),
      ...(saved.completedAt
        ? { completedAt: saved.completedAt }
        : {}),
      ...(saved.durationMs !== undefined
        ? { durationMs: saved.durationMs }
        : {}),
      ...(saved.blockedBy
        ? { blockedBy: [...saved.blockedBy] }
        : {}),
      ...(saved.taskGraphId
        ? { taskGraphId: saved.taskGraphId }
        : {}),
      ...(saved.errorCode
        ? { errorCode: saved.errorCode }
        : {}),
      ...(saved.status !== 'pending'
        ? { reused: true }
        : {}),
    });
  }

  const persist = async (
    forced?: RunbookCheckpoint['status'],
  ): Promise<void> => {
    const ordered = parsed.steps.map(
      (step) => runtime.get(step.id)!,
    );
    const unknown = ordered.some(
      (step) => step.status === 'unknown',
    );
    const running = ordered.some(
      (step) => step.status === 'running',
    );
    const failed = ordered.some(
      (step) => step.status === 'failed',
    );
    const blocked = ordered.some(
      (step) => step.status === 'blocked',
    );
    const status: RunbookCheckpoint['status'] =
      forced ??
      (unknown
        ? 'interrupted'
        : running
          ? 'running'
          : failed
            ? 'failed'
            : blocked
              ? 'blocked'
              : 'succeeded');

    checkpoint = {
      ...checkpoint,
      status,
      updatedAt: new Date().toISOString(),
      steps: ordered.map((step) => ({
        id: step.id,
        kind: step.kind,
        status: step.status,
        dependsOn: [...step.dependsOn],
        attempts: step.attempts,
        ...(step.startedAt
          ? { startedAt: step.startedAt }
          : {}),
        ...(step.completedAt
          ? { completedAt: step.completedAt }
          : {}),
        ...(step.durationMs !== undefined
          ? { durationMs: step.durationMs }
          : {}),
        ...(step.blockedBy
          ? { blockedBy: [...step.blockedBy] }
          : {}),
        ...(step.taskGraphId
          ? { taskGraphId: step.taskGraphId }
          : {}),
        ...(step.errorCode
          ? { errorCode: step.errorCode }
          : {}),
      })),
    };
    await store.save(checkpoint);
  };

  const startedAt = Date.now();
  const deadline = startedAt + parsed.total_timeout_ms;
  const running = new Map<string, Promise<void>>();

  const start = (
    spec: z.infer<typeof StepSchema>,
  ): void => {
    const step = runtime.get(spec.id)!;
    step.status = 'running';
    step.reused = false;
    step.attempts++;
    step.startedAt = new Date().toISOString();
    delete step.completedAt;
    delete step.durationMs;
    delete step.blockedBy;
    delete step.errorCode;
    delete step.result;
    const stepStarted = Date.now();

    const promise = (async () => {
      await persist('running');
      try {
        let raw: unknown;
        if (spec.kind === 'task_graph') {
          const remainingMs = Math.max(
            100,
            deadline - Date.now(),
          );
          const innerInput = {
            ...spec.task_graph,
            graph_id: step.taskGraphId,
            resume: step.attempts > 1 || parsed.resume,
            retry_failed: parsed.retry_failed,
            retry_unknown: parsed.retry_unknown,
            total_timeout_ms: Math.min(
              remainingMs,
              typeof spec.task_graph.total_timeout_ms === 'number'
                ? spec.task_graph.total_timeout_ms
                : remainingMs,
            ),
          };
          raw = await callbacks.runTaskGraph(innerInput);
        } else {
          raw = await callbacks.runAssertions(
            spec.assertions,
          );
        }

        const summarized = summarize(step.kind, raw);
        step.status = summarized.ok
          ? 'succeeded'
          : 'failed';
        step.result = summarized.summary;
        if (!summarized.ok) {
          step.errorCode =
            step.kind === 'task_graph'
              ? 'TASK_GRAPH_NOT_OK'
              : 'ASSERTIONS_NOT_OK';
        }
      } catch (error) {
        step.status = 'failed';
        step.errorCode = errorCode(error);
        step.result = {
          message:
            error instanceof Error
              ? error.message
              : String(error),
        };
      } finally {
        step.completedAt = new Date().toISOString();
        step.durationMs = Date.now() - stepStarted;
        await persist();
      }
    })().finally(() => {
      running.delete(spec.id);
    });

    running.set(spec.id, promise);
  };

  while (true) {
    let changed = false;
    const anyFailed = [...runtime.values()].some(
      (step) => step.status === 'failed',
    );

    for (const spec of parsed.steps) {
      const step = runtime.get(spec.id)!;
      if (step.status !== 'pending') continue;

      const dependencies = spec.depends_on.map(
        (id) => runtime.get(id)!,
      );
      const blockedBy = dependencies
        .filter(
          (dependency) =>
            dependency.status === 'failed' ||
            dependency.status === 'blocked' ||
            dependency.status === 'unknown',
        )
        .map((dependency) => dependency.id);

      if (blockedBy.length > 0) {
        step.status = 'blocked';
        step.blockedBy = blockedBy;
        step.completedAt = new Date().toISOString();
        step.durationMs = 0;
        changed = true;
        continue;
      }

      if (parsed.stop_on_failure && anyFailed) {
        step.status = 'blocked';
        step.blockedBy = ['stop_on_failure'];
        step.completedAt = new Date().toISOString();
        step.durationMs = 0;
        changed = true;
      }
    }

    if (Date.now() >= deadline) {
      for (const spec of parsed.steps) {
        const step = runtime.get(spec.id)!;
        if (step.status !== 'pending') continue;
        step.status = 'blocked';
        step.blockedBy = ['runbook_timeout'];
        step.completedAt = new Date().toISOString();
        step.durationMs = 0;
        changed = true;
      }
    }

    if (changed) await persist();

    for (const spec of parsed.steps) {
      if (running.size >= parsed.max_parallel) break;
      const step = runtime.get(spec.id)!;
      if (step.status !== 'pending') continue;

      const ready = spec.depends_on.every(
        (dependency) =>
          runtime.get(dependency)?.status === 'succeeded',
      );
      if (!ready) continue;

      start(spec);
      changed = true;
    }

    const unfinished = [...runtime.values()].some(
      (step) =>
        step.status === 'pending' ||
        step.status === 'running',
    );
    if (!unfinished) break;

    if (running.size === 0) {
      if (!changed) {
        throw new Error(
          'Runbook could not make progress despite passing validation.',
        );
      }
      continue;
    }

    await Promise.race(running.values());
  }

  const ordered = parsed.steps.map(
    (spec) => runtime.get(spec.id)!,
  );
  const count = (status: RuntimeStep['status']) =>
    ordered.filter((step) => step.status === status).length;
  const failed = count('failed');
  const blocked = count('blocked');
  const unknown = count('unknown');

  await persist(
    unknown > 0
      ? 'interrupted'
      : failed > 0
        ? 'failed'
        : blocked > 0
          ? 'blocked'
          : 'succeeded',
  );

  return {
    data: {
      runbookId: parsed.runbook_id,
      specHash,
      resumed: parsed.resume,
      ok: failed === 0 && blocked === 0 && unknown === 0,
      runCount: checkpoint.runCount,
      maxParallel: parsed.max_parallel,
      stopOnFailure: parsed.stop_on_failure,
      totalTimeoutMs: parsed.total_timeout_ms,
      durationMs: Date.now() - startedAt,
      summary: {
        total: ordered.length,
        succeeded: count('succeeded'),
        failed,
        blocked,
        unknown,
      },
      steps: ordered.map((step) => ({
        id: step.id,
        kind: step.kind,
        status: step.status,
        dependsOn: [...step.dependsOn],
        attempts: step.attempts,
        ...(step.reused !== undefined
          ? { reused: step.reused }
          : {}),
        ...(step.startedAt
          ? { startedAt: step.startedAt }
          : {}),
        ...(step.completedAt
          ? { completedAt: step.completedAt }
          : {}),
        ...(step.durationMs !== undefined
          ? { durationMs: step.durationMs }
          : {}),
        ...(step.blockedBy
          ? { blockedBy: [...step.blockedBy] }
          : {}),
        ...(step.taskGraphId
          ? { taskGraphId: step.taskGraphId }
          : {}),
        ...(step.errorCode
          ? { errorCode: step.errorCode }
          : {}),
        ...(step.result ? { result: step.result } : {}),
      })),
    },
  };
}
