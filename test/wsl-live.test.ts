import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { executeCapability } from '../src/agent/executors.js';
import { PathPolicy } from '../src/agent/path-policy.js';

function wslListVerbose(): string {
  const result = spawnSync(
    'wsl.exe',
    ['--list', '--verbose'],
    {
      windowsHide: true,
      encoding: 'utf16le',
    },
  );
  if (result.status !== 0) {
    throw new Error(
      'wsl --list --verbose failed: ' +
        (result.stderr || result.stdout || ''),
    );
  }
  return (result.stdout || '').replaceAll('\u0000', '');
}

test(
  'wsl.exec runs against a real WSL2 distro with exact distro/cwd semantics',
  {
    skip:
      process.platform !== 'win32' ||
      process.env.NEXOWIRE_LIVE_WSL_TEST !== '1',
  },
  async () => {
    const distro =
      process.env.NEXOWIRE_WSL_TEST_DISTRO?.trim() ||
      'Ubuntu-24.04';

    const verbose = wslListVerbose();
    const line = verbose
      .split(/\r?\n/)
      .map((entry) => entry.trim().replace(/^\*\s*/, ''))
      .find((entry) => entry.startsWith(distro));

    assert.ok(
      line,
      'Expected live WSL distro in wsl --list --verbose: ' +
        distro +
        '\n' +
        verbose,
    );
    assert.match(
      line!,
      /\s2\s*$/,
      'Live integration must exercise WSL2, not WSL1.',
    );

    const policy = new PathPolicy(['*']);

    const prepare = (await executeCapability(
      'wsl.exec',
      {
        distro,
        command: 'mkdir -p /tmp/nexowire-wsl-live',
        timeout_ms: 30_000,
      },
      policy,
    )) as {
      exitCode: number | null;
      stderr: string;
      data: { timedOut: boolean };
    };
    assert.equal(prepare.exitCode, 0, prepare.stderr);
    assert.equal(prepare.data.timedOut, false);

    const result = (await executeCapability(
      'wsl.exec',
      {
        distro,
        cwd: '/tmp/nexowire-wsl-live',
        command:
          "printf 'kernel=%s\\n' \"$(uname -s)\"; printf 'cwd=%s\\n' \"$(pwd)\"; printf 'unicode=%s\\n' 'Nexowire✓'",
        timeout_ms: 30_000,
        max_output_bytes: 64 * 1024,
      },
      policy,
    )) as {
      stdout: string;
      stderr: string;
      exitCode: number | null;
      truncated: boolean;
      data: { timedOut: boolean };
    };

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.data.timedOut, false);
    assert.equal(result.truncated, false);
    assert.match(result.stdout, /kernel=Linux/);
    assert.match(
      result.stdout,
      /cwd=\/tmp\/nexowire-wsl-live/,
    );
    assert.match(result.stdout, /unicode=Nexowire✓/);

    const nonzero = (await executeCapability(
      'wsl.exec',
      {
        distro,
        command:
          "printf 'intentional-wsl-error' >&2; exit 23",
        timeout_ms: 30_000,
      },
      policy,
    )) as {
      stdout: string;
      stderr: string;
      exitCode: number | null;
      data: { timedOut: boolean };
    };
    assert.equal(nonzero.exitCode, 23);
    assert.match(nonzero.stderr, /intentional-wsl-error/);
    assert.equal(nonzero.data.timedOut, false);

    const snapshot = (await executeCapability(
      'machine.snapshot',
      {},
      policy,
    )) as {
      data: { wslDistros: string[] };
    };
    assert.ok(snapshot.data.wslDistros.includes(distro));
  },
);
