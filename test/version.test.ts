import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { NEXOWIRE_VERSION } from '../src/version.js';

test('runtime version matches package metadata', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {
    version?: string;
  };
  assert.equal(NEXOWIRE_VERSION, pkg.version);
});
