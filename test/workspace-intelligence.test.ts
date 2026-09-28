import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { executeCapability } from '../src/agent/executors.js';
import { PathPolicy } from '../src/agent/path-policy.js';

test('workspace detection finds Node scripts and structured check ids', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-workspace-detect-'));
  const policy = new PathPolicy([root]);
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture',
        scripts: {
          test: "node -e \"console.log('test-ok')\"",
          build: "node -e \"console.log('build-ok')\"",
          dev: "node -e \"setInterval(() => {}, 1000)\"",
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  await fs.writeFile(path.join(root, 'package-lock.json'), '{}', 'utf8');

  const detected = (await executeCapability(
    'workspace.detect',
    { path: root },
    policy,
  )) as {
    data: {
      root: string;
      gitRoot: boolean;
      kinds: string[];
      manifests: string[];
      packageManager?: string;
      nodeScripts?: string[];
      availableChecks: Array<{
        id: string;
        command: string;
        executableAvailable: boolean;
      }>;
    };
  };

  assert.equal(
    process.platform === 'win32'
      ? detected.data.root.toLowerCase()
      : detected.data.root,
    process.platform === 'win32' ? root.toLowerCase() : root,
  );
  assert.equal(detected.data.gitRoot, false);
  assert.deepEqual(detected.data.kinds, ['node']);
  assert.ok(detected.data.manifests.includes('package.json'));
  assert.equal(detected.data.packageManager, 'npm');
  assert.deepEqual(detected.data.nodeScripts, ['build', 'dev', 'test']);
  assert.ok(detected.data.availableChecks.some((check) => check.id === 'node:test'));
  assert.ok(detected.data.availableChecks.some((check) => check.id === 'node:build'));
  assert.ok(!detected.data.availableChecks.some((check) => check.id === 'node:dev'));

  await fs.rm(root, { recursive: true, force: true });
});

test('workspace checks run advertised independent checks in parallel', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-workspace-checks-'));
  const policy = new PathPolicy([root]);
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      scripts: {
        test: "node -e \"console.log('test-ok')\"",
        build: "node -e \"console.log('build-ok')\"",
      },
    }),
    'utf8',
  );

  const result = (await executeCapability(
    'workspace.checks',
    {
      path: root,
      checks: ['node:test', 'node:build'],
      parallel: true,
      timeout_ms: 30_000,
    },
    policy,
  )) as {
    data: {
      ok: boolean;
      passed: number;
      failed: number;
      results: Array<{
        id: string;
        ok: boolean;
        stdout: string;
        exitCode: number | null;
      }>;
    };
  };

  assert.equal(result.data.ok, true);
  assert.equal(result.data.passed, 2);
  assert.equal(result.data.failed, 0);
  assert.equal(result.data.results.length, 2);
  assert.ok(
    result.data.results.some(
      (check) => check.id === 'node:test' && /test-ok/.test(check.stdout),
    ),
  );
  assert.ok(
    result.data.results.some(
      (check) => check.id === 'node:build' && /build-ok/.test(check.stdout),
    ),
  );

  await assert.rejects(
    () =>
      executeCapability(
        'workspace.checks',
        { path: root, checks: ['node:dev'] },
        policy,
      ),
    /not available/,
  );

  await fs.rm(root, { recursive: true, force: true });
});
