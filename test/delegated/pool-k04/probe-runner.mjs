#!/usr/bin/env node
// Offline, fixture-only probe of the delegated test runner's file discovery.
// No user files, network, test subprocess or privileged service is executed.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const expected = [
  'nested/nested.test.mjs',
  'nested/nested.test.cjs',
  'nested/nested.test.js',
  'nested/nested.test.ts',
  'watch.test.mjs',
];

const excluded = [
  'nested/ignored.spec.mjs',
  'nested/ignored.test.jsx',
];

export function probeRunner(source) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('Runner source is empty');
  const testRoot = resolve('test/delegated');
  const watchRoot = resolve('scripts/delegated/ci-watch-k13');
  const nested = join(testRoot, 'nested');

  const tree = new Map([
    [testRoot, [{ name: 'nested', directory: true }]],
    [nested, [
      { name: 'nested.test.mjs' },
      { name: 'nested.test.cjs' },
      { name: 'nested.test.js' },
      { name: 'nested.test.ts' },
      { name: 'ignored.spec.mjs' },
      { name: 'ignored.test.jsx' },
    ]],
    [watchRoot, [{ name: 'watch.test.mjs' }]],
  ]);
  const spawned = [];
  const fixtureFs = (path) => {
    const entries = tree.get(path);
    if (!entries) throw new Error(`Unexpected test discovery path: ${path}`);
    return entries.map(({ name, directory = false }) => ({
      name,
      isFile: () => !directory,
      isDirectory: () => directory,
    }));
  };

  // K13's module only imports these three Node builtins. Strip their import
  // declarations and inject safe test doubles; any new import fails closed.
  const body = source.replace(/^import\s+\{[^}]+\}\s+from\s+['"]node:(?:fs|path|child_process)['"];?\s*$/gm, '');
  const vmProcess = { execPath: '/fixture/node', env: {}, exitCode: 0 };
  runInNewContext(body, {
    readdirSync: fixtureFs,
    join,
    resolve,
    spawnSync: (file, args, options) => {
      spawned.push({ file, args, options });
      return { status: 0 };
    },
    process: vmProcess,
    console: { log() {}, error() {} },
  }, { filename: 'delegated-runner-probe.mjs', timeout: 1000 });

  const chosen = spawned.flatMap(({ args }) => args.filter((arg) =>
    typeof arg === 'string' && (arg.startsWith(testRoot) || arg.startsWith(watchRoot))));
  const selected = chosen.map((path) => path.startsWith(nested)
    ? 'nested/' + path.slice(nested.length + 1)
    : path.startsWith(watchRoot) ? path.slice(watchRoot.length + 1) : path);
  const missing = expected.filter((path) => !selected.includes(path));
  const unexpected = excluded.filter((path) => selected.includes(path));
  return {
    selected,
    missing,
    unexpected,
    spawnCount: spawned.length,
    ok: spawned.length === 1 && vmProcess.exitCode === 0 &&
      missing.length === 0 && unexpected.length === 0 &&
      new Set(selected).size === selected.length,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runner = process.argv[2];
  if (!runner) {
    console.error('NOT_RUN: provide an exact local path to K13 run-delegated-tests.mjs');
    process.exitCode = 2;
  } else {
    try {
      const result = probeRunner(readFileSync(resolve(runner), 'utf8'));
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
    } catch (error) {
      console.error('PROBE FAILED:', error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
