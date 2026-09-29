import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRuntime } from '../src/runtime.js';

test('default runtime registers only the first-party native-agent backend', async () => {
  const stateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-native-runtime-'),
  );

  try {
    const runtime = await createRuntime({
      host: '127.0.0.1',
      port: 43110,
      stateDir,
      skillsDir: path.resolve('skills'),
    });

    assert.deepEqual(
      runtime.context.providers
        .listProviders()
        .map((provider) => provider.id),
      ['native-agent'],
    );
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
