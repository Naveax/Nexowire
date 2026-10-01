import test from 'node:test';
import assert from 'node:assert/strict';
import { detectWsl } from '../src/agent/wsl-detection.js';

test('WSL detection is unavailable off Windows', () => {
  assert.deepEqual(
    detectWsl({
      platform: 'linux',
      run: () => {
        throw new Error('runner must not be called');
      },
    }),
    { available: false, distros: [] },
  );
});

test('WSL detection parses UTF-16LE distro output and deduplicates names', () => {
  const stdout = Buffer.from(
    'Ubuntu-24.04\r\nDebian\r\nUbuntu-24.04\r\n',
    'utf16le',
  );

  assert.deepEqual(
    detectWsl({
      platform: 'win32',
      run: (command, args) => {
        assert.equal(command, 'wsl.exe');
        assert.deepEqual(args, ['--list', '--quiet']);
        return {
          status: 0,
          stdout,
          stderr: Buffer.alloc(0),
        };
      },
    }),
    {
      available: true,
      distros: ['Ubuntu-24.04', 'Debian'],
    },
  );
});

test('WSL detection fails closed on missing executable, command failure, or empty distro list', () => {
  for (const result of [
    {
      status: null,
      stdout: '',
      stderr: 'ENOENT',
      error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    },
    {
      status: 1,
      stdout: '',
      stderr: 'no distributions',
    },
    {
      status: 0,
      stdout: '\r\n',
      stderr: '',
    },
  ]) {
    assert.deepEqual(
      detectWsl({
        platform: 'win32',
        run: () => result,
      }),
      { available: false, distros: [] },
    );
  }
});
