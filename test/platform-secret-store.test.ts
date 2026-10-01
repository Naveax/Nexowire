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

  syncResult: {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
  } = {
    status: 0,
    stdout: 'secret-value\n',
    stderr: '',
  };

  asyncResult: {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
  } = {
    status: 0,
    stdout: '',
    stderr: '',
  };

  runSync(
    command: string,
    args: string[],
    options: { input?: string; maxBuffer?: number; timeoutMs?: number } = {},
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
    options: { input?: string; maxBuffer?: number; timeoutMs?: number } = {},
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

test('macOS Keychain lookup and write keep secret plaintext out of argv', async () => {
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

  runner.syncCalls = [];
  runner.syncResult = {
    status: 0,
    stdout: 'never-in-argv\n',
    stderr: '',
  };

  await store.write(
    {
      purpose: 'agent-bearer-token',
      name: 'primary',
    },
    'never-in-argv',
    { overwrite: true },
  );

  assert.equal(runner.asyncCalls.length, 1);
  assert.deepEqual(runner.asyncCalls[0]?.args, ['-q', '-i']);
  assert.equal(
    runner.asyncCalls[0]?.args.includes('never-in-argv'),
    false,
  );
  assert.match(
    runner.asyncCalls[0]?.input ?? '',
    /add-generic-password/,
  );
  assert.match(
    runner.asyncCalls[0]?.input ?? '',
    /never-in-argv/,
  );
  assert.equal(
    (runner.asyncCalls[0]?.input ?? '').includes(' -T '),
    false,
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

test('backend failure stderr is not misclassified as a missing secret', () => {
  const runner = new FakeRunner();
  const store = new PlatformSecretStore({
    platform: 'linux',
    runner,
  });
  runner.syncResult = {
    status: 1,
    stdout: '',
    stderr: 'Error communicating with Secret Service',
  };

  assert.throws(
    () =>
      store.readSync({
        purpose: 'mcp-bearer-token',
        name: 'primary',
      }),
    (error: unknown) =>
      error instanceof PlatformSecretError &&
      error.code === 'PLATFORM_SECRET_COMMAND_FAILED',
  );
});

test('macOS Keychain status 44 maps to not-found without leaking backend text', () => {
  const runner = new FakeRunner();
  const store = new PlatformSecretStore({
    platform: 'darwin',
    runner,
  });
  runner.syncResult = {
    status: 44,
    stdout: '',
    stderr:
      'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.',
  };

  assert.throws(
    () =>
      store.readSync({
        purpose: 'agent-bearer-token',
        name: 'missing',
      }),
    (error: unknown) =>
      error instanceof PlatformSecretError &&
      error.code === 'PLATFORM_SECRET_NOT_FOUND',
  );
});

test('platform secret capabilities expose safe lifecycle support without secret material', () => {
  const linux = new PlatformSecretStore({
    platform: 'linux',
    runner: new FakeRunner(),
  });
  assert.deepEqual(linux.capabilities(), {
    platform: 'linux',
    backend: 'secret-service',
    read: true,
    write: true,
    delete: true,
    secureWriteTransport: 'stdin',
    presenceProbeReadsSecret: true,
  });

  const darwin = new PlatformSecretStore({
    platform: 'darwin',
    runner: new FakeRunner(),
  });
  assert.deepEqual(darwin.capabilities(), {
    platform: 'darwin',
    backend: 'keychain',
    read: true,
    write: true,
    delete: true,
    secureWriteTransport: 'stdin',
    presenceProbeReadsSecret: false,
  });
});

test('macOS platform status checks metadata without requesting password plaintext', () => {
  const runner = new FakeRunner();
  runner.syncResult = {
    status: 0,
    stdout: 'keychain metadata',
    stderr: '',
  };
  const store = new PlatformSecretStore({
    platform: 'darwin',
    runner,
  });

  assert.deepEqual(
    store.status({
      purpose: 'agent-bearer-token',
      name: 'primary',
    }),
    {
      platform: 'darwin',
      backend: 'keychain',
      purpose: 'agent-bearer-token',
      name: 'primary',
      present: true,
      capabilities: {
        platform: 'darwin',
        backend: 'keychain',
        read: true,
        write: true,
        delete: true,
        secureWriteTransport: 'stdin',
        presenceProbeReadsSecret: false,
      },
    },
  );

  assert.deepEqual(runner.syncCalls[0], {
    command: '/usr/bin/security',
    args: [
      'find-generic-password',
      '-s',
      'Nexowire/agent-bearer-token',
      '-a',
      'primary',
    ],
  });
  assert.equal(
    runner.syncCalls[0]?.args.includes('-w'),
    false,
  );
});

test('platform secret backend failures expose hashed diagnostics instead of raw stderr', () => {
  const runner = new FakeRunner();
  const store = new PlatformSecretStore({
    platform: 'linux',
    runner,
  });
  runner.syncResult = {
    status: 2,
    stdout: '',
    stderr: 'sensitive-backend-diagnostic',
  };

  assert.throws(
    () =>
      store.readSync({
        purpose: 'mcp-bearer-token',
        name: 'primary',
      }),
    (error: unknown) => {
      assert.ok(error instanceof PlatformSecretError);
      assert.equal(error.code, 'PLATFORM_SECRET_COMMAND_FAILED');
      const details = error.details ?? {};
      assert.equal(
        JSON.stringify(details).includes(
          'sensitive-backend-diagnostic',
        ),
        false,
      );
      assert.equal(
        typeof (
          details.stderr as { sha256?: unknown } | undefined
        )?.sha256,
        'string',
      );
      return true;
    },
  );
});


test('macOS Keychain write rejects existing items without explicit overwrite', async () => {
  const runner = new FakeRunner();
  runner.syncResult = {
    status: 0,
    stdout: 'metadata only',
    stderr: '',
  };
  const store = new PlatformSecretStore({
    platform: 'darwin',
    runner,
  });

  await assert.rejects(
    () =>
      store.write(
        {
          purpose: 'agent-bearer-token',
          name: 'primary',
        },
        'new-secret',
      ),
    (error: unknown) =>
      error instanceof PlatformSecretError &&
      error.code === 'PLATFORM_SECRET_EXISTS',
  );
  assert.equal(runner.asyncCalls.length, 0);
  assert.equal(
    runner.syncCalls[0]?.args.includes('-w'),
    false,
  );
});

test('macOS Keychain interactive write rejects multiline and oversized command payloads', async () => {
  const runner = new FakeRunner();
  runner.syncResult = {
    status: 0,
    stdout: 'line-1\nline-2\n',
    stderr: '',
  };
  const store = new PlatformSecretStore({
    platform: 'darwin',
    runner,
  });

  await assert.rejects(
    () =>
      store.write(
        {
          purpose: 'agent-bearer-token',
          name: 'primary',
        },
        'line-1\nline-2',
        { overwrite: true, allowMultiline: true },
      ),
    (error: unknown) =>
      error instanceof PlatformSecretError &&
      error.code === 'PLATFORM_SECRET_MULTILINE',
  );

  await assert.rejects(
    () =>
      store.write(
        {
          purpose: 'agent-bearer-token',
          name: 'primary',
        },
        'x'.repeat(4096),
        { overwrite: true },
      ),
    (error: unknown) =>
      error instanceof PlatformSecretError &&
      error.code === 'PLATFORM_SECRET_TOO_LARGE',
  );
});
