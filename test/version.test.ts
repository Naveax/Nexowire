import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { agentVersion } from '../src/agent/native-agent.js';
import { NEXOWIRE_VERSION } from '../src/version.js';

test('runtime version matches package metadata', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {
    version?: string;
  };
  assert.equal(NEXOWIRE_VERSION, pkg.version);
});


test('native agent advertises the runtime package version', () => {
  assert.equal(agentVersion(), NEXOWIRE_VERSION);
});
