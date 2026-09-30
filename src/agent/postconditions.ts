import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import * as z from 'zod';
import type { PathPolicy } from './path-policy.js';

const BaseSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
});

const AssertionSchema = z.discriminatedUnion('kind', [
  BaseSchema.extend({
    kind: z.literal('file.exists'),
    path: z.string().min(1).max(4096),
    expected: z.boolean().default(true),
  }),
  BaseSchema.extend({
    kind: z.literal('file.sha256'),
    path: z.string().min(1).max(4096),
    expected_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
    max_bytes: z
      .number()
      .int()
      .min(1)
      .max(268_435_456)
      .default(67_108_864),
  }),
  BaseSchema.extend({
    kind: z.literal('file.text_contains'),
    path: z.string().min(1).max(4096),
    needle: z.string().min(1).max(16_384),
    expected: z.boolean().default(true),
    max_bytes: z
      .number()
      .int()
      .min(1)
      .max(16_777_216)
      .default(2_097_152),
  }),
  BaseSchema.extend({
    kind: z.literal('process.pid_alive'),
    pid: z.number().int().positive(),
    expected: z.boolean().default(true),
  }),
  BaseSchema.extend({
    kind: z.literal('tcp.open'),
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65_535),
    expected: z.boolean().default(true),
    timeout_ms: z.number().int().min(100).max(30_000).default(3_000),
  }),
  BaseSchema.extend({
    kind: z.literal('http.status'),
    url: z.string().url().max(4096),
    expected_status: z
      .array(z.number().int().min(100).max(599))
      .min(1)
      .max(32),
    timeout_ms: z.number().int().min(100).max(30_000).default(5_000),
  }),
]);

const InputSchema = z.object({
  assertions: z.array(AssertionSchema).min(1).max(32),
  max_parallel: z.number().int().min(1).max(8).default(4),
  stop_on_failure: z.boolean().default(false),
});

export interface PostconditionResult {
  id: string;
  kind: z.infer<typeof AssertionSchema>['kind'];
  passed: boolean;
  durationMs: number;
  observed: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EPERM'
    );
  }
}

async function tcpOpen(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      finish(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

function normalizeError(error: unknown): {
  code: string;
  message: string;
} {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return {
      code: error.code,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    code: 'ASSERTION_ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
}

async function runOne(
  assertion: z.infer<typeof AssertionSchema>,
  policy: PathPolicy,
): Promise<PostconditionResult> {
  const started = Date.now();

  try {
    switch (assertion.kind) {
      case 'file.exists': {
        let exists = true;
        let resolved: string | undefined;
        try {
          resolved = await policy.resolveExisting(assertion.path);
        } catch (error) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
          ) {
            exists = false;
          } else {
            throw error;
          }
        }
        return {
          id: assertion.id,
          kind: assertion.kind,
          passed: exists === assertion.expected,
          durationMs: Date.now() - started,
          observed: {
            exists,
            ...(resolved ? { path: resolved } : {}),
          },
        };
      }

      case 'file.sha256': {
        const target = await policy.resolveExisting(assertion.path);
        const stat = await fs.stat(target);
        if (!stat.isFile()) {
          throw Object.assign(new Error('Hash target is not a file.'), {
            code: 'ASSERTION_NOT_FILE',
          });
        }
        if (stat.size > assertion.max_bytes) {
          throw Object.assign(
            new Error(
              `File size ${stat.size} exceeds assertion max_bytes ${assertion.max_bytes}.`,
            ),
            { code: 'ASSERTION_FILE_TOO_LARGE' },
          );
        }
        const sha256 = createHash('sha256')
          .update(await fs.readFile(target))
          .digest('hex');
        const expected = assertion.expected_sha256.toLowerCase();
        return {
          id: assertion.id,
          kind: assertion.kind,
          passed: sha256 === expected,
          durationMs: Date.now() - started,
          observed: {
            path: target,
            size: stat.size,
            sha256,
            expectedSha256: expected,
          },
        };
      }

      case 'file.text_contains': {
        const target = await policy.resolveExisting(assertion.path);
        const stat = await fs.stat(target);
        if (!stat.isFile()) {
          throw Object.assign(new Error('Text target is not a file.'), {
            code: 'ASSERTION_NOT_FILE',
          });
        }
        if (stat.size > assertion.max_bytes) {
          throw Object.assign(
            new Error(
              `File size ${stat.size} exceeds assertion max_bytes ${assertion.max_bytes}.`,
            ),
            { code: 'ASSERTION_FILE_TOO_LARGE' },
          );
        }
        const content = await fs.readFile(target, 'utf8');
        const contains = content.includes(assertion.needle);
        return {
          id: assertion.id,
          kind: assertion.kind,
          passed: contains === assertion.expected,
          durationMs: Date.now() - started,
          observed: {
            path: target,
            size: stat.size,
            contains,
            expected: assertion.expected,
            needleChars: assertion.needle.length,
            needleSha256: createHash('sha256')
              .update(assertion.needle, 'utf8')
              .digest('hex'),
          },
        };
      }

      case 'process.pid_alive': {
        const alive = isPidAlive(assertion.pid);
        return {
          id: assertion.id,
          kind: assertion.kind,
          passed: alive === assertion.expected,
          durationMs: Date.now() - started,
          observed: {
            pid: assertion.pid,
            alive,
            expected: assertion.expected,
          },
        };
      }

      case 'tcp.open': {
        const open = await tcpOpen(
          assertion.host,
          assertion.port,
          assertion.timeout_ms,
        );
        return {
          id: assertion.id,
          kind: assertion.kind,
          passed: open === assertion.expected,
          durationMs: Date.now() - started,
          observed: {
            host: assertion.host,
            port: assertion.port,
            open,
            expected: assertion.expected,
          },
        };
      }

      case 'http.status': {
        const parsed = new URL(assertion.url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          throw Object.assign(
            new Error('HTTP assertion permits only http:// and https:// URLs.'),
            { code: 'ASSERTION_URL_SCHEME_DENIED' },
          );
        }
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          assertion.timeout_ms,
        );
        try {
          const response = await fetch(parsed, {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
          });
          const expected = [...assertion.expected_status];
          return {
            id: assertion.id,
            kind: assertion.kind,
            passed: expected.includes(response.status),
            durationMs: Date.now() - started,
            observed: {
              url: parsed.toString(),
              status: response.status,
              expectedStatus: expected,
            },
          };
        } finally {
          clearTimeout(timer);
        }
      }
    }
  } catch (error) {
    return {
      id: assertion.id,
      kind: assertion.kind,
      passed: false,
      durationMs: Date.now() - started,
      observed: {},
      error: normalizeError(error),
    };
  }
}

export async function executePostconditions(
  input: unknown,
  policy: PathPolicy,
): Promise<{
  data: {
    ok: boolean;
    passed: number;
    failed: number;
    skipped: number;
    results: PostconditionResult[];
  };
}> {
  const parsed = InputSchema.parse(input);
  const results: PostconditionResult[] = [];
  let cursor = 0;
  let stop = false;

  const worker = async (): Promise<void> => {
    while (true) {
      if (stop) return;
      const index = cursor++;
      const assertion = parsed.assertions[index];
      if (!assertion) return;
      const result = await runOne(assertion, policy);
      results[index] = result;
      if (parsed.stop_on_failure && !result.passed) stop = true;
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(parsed.max_parallel, parsed.assertions.length) },
      () => worker(),
    ),
  );

  const skipped = parsed.assertions.length - results.filter(Boolean).length;
  for (let index = 0; index < parsed.assertions.length; index++) {
    if (results[index]) continue;
    const assertion = parsed.assertions[index]!;
    results[index] = {
      id: assertion.id,
      kind: assertion.kind,
      passed: false,
      durationMs: 0,
      observed: {},
      error: {
        code: 'ASSERTION_SKIPPED',
        message: 'Skipped because stop_on_failure was triggered.',
      },
    };
  }

  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed - skipped;
  return {
    data: {
      ok: passed === parsed.assertions.length,
      passed,
      failed,
      skipped,
      results,
    },
  };
}
