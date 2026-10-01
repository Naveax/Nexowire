import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCapability } from '../src/agent/executors.js';
import { PathPolicy } from '../src/agent/path-policy.js';

const live =
  process.platform === 'win32' &&
  process.env.NEXOWIRE_LIVE_WSL_TEST === '1';

const distro =
  process.env.NEXOWIRE_WSL_TEST_DISTRO?.trim() || 'Ubuntu';

test(
  'real WSL2 distro executes through Nexowire wsl.exec with distro/cwd/unicode semantics',
  { skip: !live },
  async () => {
    const result = (await executeCapability(
      'wsl.exec',
      {
        distro,
        cwd: '/tmp',
        command:
          "printf 'KERNEL=%s\\n' \"$(uname -s)\"; " +
          "printf 'PWD=%s\\n' \"$PWD\"; " +
          "printf 'UTF=ç✓\\n'",
        timeout_ms: 30_000,
        max_output_bytes: 32_768,
      },
      new PathPolicy(['*']),
    )) as {
      stdout: string;
      stderr: string;
      exitCode: number | null;
      truncated: boolean;
      data: { timedOut: boolean };
    };

    assert.equal(result.exitCode, 0);
    assert.equal(result.data.timedOut, false);
    assert.equal(result.truncated, false);
    assert.match(result.stdout, /KERNEL=Linux/);
    assert.match(result.stdout, /PWD=\/tmp/);
    assert.match(result.stdout, /UTF=ç✓/);
    assert.equal(result.stderr, '');
  },
);

test(
  'real WSL2 distro preserves nonzero exit and stderr through Nexowire',
  { skip: !live },
  async () => {
    const result = (await executeCapability(
      'wsl.exec',
      {
        distro,
        command: "printf 'wsl-error\\n' >&2; exit 23",
        timeout_ms: 30_000,
        max_output_bytes: 32_768,
      },
      new PathPolicy(['*']),
    )) as {
      stdout: string;
      stderr: string;
      exitCode: number | null;
      truncated: boolean;
      data: { timedOut: boolean };
    };

    assert.equal(result.exitCode, 23);
    assert.equal(result.data.timedOut, false);
    assert.equal(result.truncated, false);
    assert.match(result.stderr, /wsl-error/);
  },
);

test(
  'real WSL2 output stays bounded and reports truncation',
  { skip: !live },
  async () => {
    const result = (await executeCapability(
      'wsl.exec',
      {
        distro,
        command:
          "head -c 8192 /dev/zero | tr '\\000' x",
        timeout_ms: 30_000,
        max_output_bytes: 1024,
      },
      new PathPolicy(['*']),
    )) as {
      stdout: string;
      stderr: string;
      exitCode: number | null;
      truncated: boolean;
      data: { timedOut: boolean };
    };

    assert.equal(result.exitCode, 0);
    assert.equal(result.data.timedOut, false);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 1024);
  },
);
