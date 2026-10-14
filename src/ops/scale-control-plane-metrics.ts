import type {
  D1DatabaseLike, D1PreparedStatementLike, D1ResultLike,
} from '../product/d1-control-plane-store.js';

// No dimensions or labels. Never retain SQL, arguments, URLs, IDs or bodies.
export const SCALE_CONTROL_METRIC_NAMES = [
  'http.requests', 'http.success', 'http.client_denials',
  'http.server_errors', 'http.handler_failures',
  'd1.prepare', 'd1.bind', 'd1.first', 'd1.all', 'd1.run',
  'd1.batch', 'd1.batch_statements', 'd1.failures',
] as const;
export type ScaleControlMetricName = typeof SCALE_CONTROL_METRIC_NAMES[number];

export type ScaleControlMetricTotal = Readonly<{
  events: number;
  totalLatencyMs: number;
  latencyBuckets: readonly [number, number, number, number, number];
}>;
export type ScaleControlSnapshot = Readonly<
  Record<ScaleControlMetricName, ScaleControlMetricTotal>
>;

const limit = Number.MAX_SAFE_INTEGER;
function safeAdd(a: number, b: number): number {
  const result = a + b;
  if (!Number.isSafeInteger(result) || result < 0 || result > limit) {
    throw new Error('Scale v2 measurement overflow');
  }
  return result;
}
function safeRecord(
  metrics: ScaleControlPlaneMetrics,
  name: ScaleControlMetricName,
  elapsedMs = 0,
  events = 1,
): void {
  try { metrics.record(name, elapsedMs, events); } catch {
    // Instrumentation is strictly optional and cannot break real work.
  }
}

function safeTime(now: () => number): number {
  try {
    const value = now();
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}
function safeDuration(now: () => number, started: number): number {
  return Math.max(0, safeTime(now) - started);
}

export class ScaleControlPlaneMetrics {
  private readonly values = new Map<ScaleControlMetricName, {
    events: number;
    totalLatencyMs: number;
    latencyBuckets: [number, number, number, number, number];
  }>();

  record(name: ScaleControlMetricName, elapsedMs = 0, events = 1): void {
    if (!SCALE_CONTROL_METRIC_NAMES.includes(name) ||
        !Number.isFinite(elapsedMs) || elapsedMs < 0 ||
        !Number.isSafeInteger(events) || events < 0) {
      throw new Error('Invalid Scale v2 numeric measurement');
    }
    const rounded = Math.ceil(elapsedMs);
    if (!Number.isSafeInteger(rounded)) throw new Error('Invalid latency');
    const prev = this.values.get(name) ?? {
      events: 0, totalLatencyMs: 0,
      latencyBuckets: [0, 0, 0, 0, 0] as [number,number,number,number,number],
    };
    const index = rounded <= 5 ? 0 : rounded <= 20 ? 1 :
      rounded <= 100 ? 2 : rounded <= 500 ? 3 : 4;
    const buckets = [...prev.latencyBuckets] as
      [number,number,number,number,number];
    buckets[index] = safeAdd(buckets[index], events);
    this.values.set(name, {
      events: safeAdd(prev.events, events),
      totalLatencyMs: safeAdd(prev.totalLatencyMs, rounded * events),
      latencyBuckets: buckets,
    });
  }

  snapshot(): ScaleControlSnapshot {
    return Object.fromEntries(SCALE_CONTROL_METRIC_NAMES.map(name => {
      const value = this.values.get(name) ?? {
        events: 0, totalLatencyMs: 0,
        latencyBuckets: [0,0,0,0,0] as [number,number,number,number,number],
      };
      return [name, {
        events: value.events, totalLatencyMs: value.totalLatencyMs,
        latencyBuckets: [...value.latencyBuckets],
      }];
    })) as unknown as ScaleControlSnapshot;
  }
}

export function withScaleHttpMetrics(
  handler: (request: Request) => Promise<Response>,
  metrics: ScaleControlPlaneMetrics,
  now: () => number = () => performance.now(),
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const started = safeTime(now);
    safeRecord(metrics, 'http.requests');
    try {
      const response = await handler(request);
      const duration = safeDuration(now, started);
      const status = response.status;
      const name: ScaleControlMetricName =
        status >= 500 ? 'http.server_errors' :
        status >= 400 ? 'http.client_denials' : 'http.success';
      safeRecord(metrics, name, duration);
      return response;
    } catch (error) {
      safeRecord(metrics, 'http.handler_failures', safeDuration(now, started));
      throw error;
    }
  };
}

export function instrumentD1Database(
  database: D1DatabaseLike,
  metrics: ScaleControlPlaneMetrics,
  now: () => number = () => performance.now(),
): D1DatabaseLike {
  const unwrapped = new WeakMap<D1PreparedStatementLike,D1PreparedStatementLike>();
  const wrap = (statement: D1PreparedStatementLike): D1PreparedStatementLike => {
    const instrumented: D1PreparedStatementLike = {
      bind(...values: unknown[]) {
        const started = safeTime(now);
        try {
          const next = statement.bind(...values);
          safeRecord(metrics, 'd1.bind', safeDuration(now, started));
          return wrap(next);
        } catch (error) {
          safeRecord(metrics, 'd1.failures');
          throw error;
        }
      },
      async first<T>(): Promise<T|null> {
        const started = safeTime(now);
        try {
          return await statement.first<T>();
        } catch (error) {
          safeRecord(metrics, 'd1.failures');
          throw error;
        } finally {
          safeRecord(metrics, 'd1.first', safeDuration(now, started));
        }
      },
      async all<T>(): Promise<D1ResultLike<T>> {
        const started = safeTime(now);
        try {
          return await statement.all<T>();
        } catch (error) {
          safeRecord(metrics, 'd1.failures');
          throw error;
        } finally {
          safeRecord(metrics, 'd1.all', safeDuration(now, started));
        }
      },
      async run<T>(): Promise<D1ResultLike<T>> {
        const started = safeTime(now);
        try {
          return await statement.run<T>();
        } catch (error) {
          safeRecord(metrics, 'd1.failures');
          throw error;
        } finally {
          safeRecord(metrics, 'd1.run', safeDuration(now, started));
        }
      },
    };
    unwrapped.set(instrumented, statement);
    return instrumented;
  };
  return {
    prepare(sql: string) {
      const started = safeTime(now);
      try {
        const statement = database.prepare(sql);
        safeRecord(metrics, 'd1.prepare', safeDuration(now, started));
        return wrap(statement);
      } catch (error) {
        safeRecord(metrics, 'd1.failures');
        throw error;
      }
    },
    async batch(statements: D1PreparedStatementLike[]) {
      const started = safeTime(now);
      try {
        return await database.batch(statements.map(stmt=>unwrapped.get(stmt)??stmt));
      } catch (error) {
        safeRecord(metrics, 'd1.failures');
        throw error;
      } finally {
        safeRecord(metrics, 'd1.batch', safeDuration(now, started));
        safeRecord(metrics, 'd1.batch_statements', 0, statements.length);
      }
    },
  };
}
