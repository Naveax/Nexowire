import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PlatformSecretError,
  PlatformSecretStore,
  type PlatformSecretRunner,
} from '../src/security/platform-secret-store.js';

class FakeRunner implements PlatformSecretRunner {
  syncCalls: Array<{
    command: string;
    args: string[];
    input?: string;
  }> = [];
  asyncCalls: Array<{
    command: string;
    args: string[];
    input?: string;
  }> = [];

  syncResult = {
    status: 0,
    stdout: 'secret-value\n',
    stderr: '',
  };

  asyncResult = {
    status: 0,
    stdout: '',
    stderr: '',
  };

  runSync(
    command: string,
    args: string[],
    options: { input?: string } = {},
  ) {
    this.syncCalls.push({
      command,
      args: [...args],
      ...(options.input !== undefined
        ? { input: options.input }
        : {}),
    });
    return { ...this.syncResult };
  }

  async run(
    command: string,
    args: string[],
    options: { input?: string } = {},
  ) {
    this.asyncCalls.push({
      command,
      args: [...args],
      ...(options.input !== undefined
        ? { input: options.input }
        : {}),
    });
    return { ...this.asyncResult };
  }
}

test('Linux Secret Service lookup and store use exact attributes and stdin for secret payload', async () => {
  const runner = new FakeRunner();
  const store = new PlatformSecretStore({
    platform: 'linux',
    runner,
  });

  assert.equal(
    store.readSync({
      purpose: 'mcp-bearer-token',
      name: 'primary',
    }),
    'secret-value',
  );

  assert.deepEqual(runner.syncCalls[0], {
    command: 'secret-tool',
    args: [
      'lookup',
      'application',
      'nexowire',
      'purpose',
      'mcp-bearer-token',
      'name',
      'primary',
    ],
  });

  runner.syncResult = {
    status: 1,
    stdout: '',
    stderr: '',
  };

  await store.write(
    {
      purpose: 'mcp-bearer-token',
      name: 'primary',
    },
    'new-secret',
    { overwrite: false },
  );

  assert.deepEqual(runner.asyncCalls[0], {
    command: 'secret-tool',
    args: [
      'store',
      '--label=Nexowire mcp-bearer-token/primary',
      'application',
      'nexowire',
      'purpose',
      'mcp-bearer-token',
      'name',
      'primary',
    ],
    input: 'new-secret',
  });
  assert.equal(
    runner.asyncCalls[0]?.args.includes('new-secret'),
    false,
  );
});

test('macOS Keychain lookup avoids secret arguments and write fails closed', async () => {
  const runner = new FakeRunner();
  const store = new PlatformSecretStore({
    platform: 'darwin',
    runner,
  });

  assert.equal(
    store.readSync({
      purpose: 'agent-bearer-token',
      name: 'primary',
    }),
    'secret-value',
  );
  assert.deepEqual(runner.syncCalls[0], {
    command: '/usr/bin/security',
    args: [
      'find-generic-password',
      '-s',
      'Nexowire/agent-bearer-token',
      '-a',
      'primary',
      '-w',
    ],
  });

  await assert.rejects(
    () =>
      store.write(
        {
          purpose: 'agent-bearer-token',
          name: 'primary',
        },
        'never-in-argv',
      ),
    (error: unknown) =>
      error instanceof PlatformSecretError &&
      error.code === 'PLATFORM_SECRET_WRITE_UNSUPPORTED',
  );
  assert.equal(runner.asyncCalls.length, 0);
});

test('platform secret adapters reject unsupported platforms and unsafe references', () => {
  assert.throws(
    () =>
      new PlatformSecretStore({
        platform: 'win32',
        runner: new FakeRunner(),
      }),
    (error: unknown) =>
      error instanceof PlatformSecretError &&
      error.code === 'PLATFORM_SECRET_UNSUPPORTED',
  );

  const store = new PlatformSecretStore({
    platform: 'linux',
    runner: new FakeRunner(),
  });
  assert.throws(() =>
    store.readSync({
      purpose: '../escape',
      name: 'primary',
    }),
  );
  assert.throws(() =>
    store.readSync({
      purpose: 'mcp-bearer-token',
      name: 'bad/name',
    }),
  );
});

test('platform secret lookup reports not-found and unavailable-tool states without returning stderr as secret', () => {
  const runner = new FakeRunner();
  const store = new PlatformSecretStore({
    platform: 'linux',
    runner,
  });

  runner.syncResult = {
    status: 1,
    stdout: '',
    stderr: '',
  };
  assert.throws(
    () =>
      store.readSync({
        purpose: 'mcp-bearer-token',
        name: 'missing',
      }),
    (error: unknown) =>
      error instanceof PlatformSecretError &&
      error.code === 'PLATFORM_SECRET_NOT_FOUND',
  );

  runner.syncResult = {
    status: null,
    stdout: '',
    stderr: 'spawn secret-tool ENOENT',
    error: Object.assign(new Error('spawn secret-tool ENOENT'), {
      code: 'ENOENT',
    }),
  };
  assert.throws(
    () =>
      store.readSync({
        purpose: 'mcp-bearer-token',
        name: 'missing',
      }),
    (error: unknown) =>
      error instanceof PlatformSecretError &&
      error.code === 'PLATFORM_SECRET_TOOL_UNAVAILABLE',
  );
});

test('platform secret plaintext is bounded and multiline is opt-in', () => {
  const runner = new FakeRunner();
  const store = new PlatformSecretStore({
    platform: 'linux',
    runner,
  });

  runner.syncResult = {
    status: 0,
    stdout: 'line-1\nline-2\n',
    stderr: '',
  };

  assert.throws(
    () =>
      store.readSync({
        purpose: 'mcp-bearer-token',
        name: 'list',
      }),
    (error: unknown) =>
      error instanceof PlatformSecretError &&
      error.code === 'PLATFORM_SECRET_MULTILINE',
  );

  assert.equal(
    store.readSync(
      {
        purpose: 'mcp-bearer-token-list',
        name: 'list',
      },
      { allowMultiline: true },
    ),
    'line-1\nline-2',
  );
});
