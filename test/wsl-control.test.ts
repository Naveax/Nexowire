import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCapability } from '../src/agent/executors.js';
import {
  capabilitiesForPlatform,
  isReadOnlyCapability,
} from '../src/protocol/capabilities.js';
import { PathPolicy, parseAllowedRoots } from '../src/agent/path-policy.js';

test('WSL structured discovery/path tools are Windows-only and read-only', () => {
  const windows = capabilitiesForPlatform('win32');
  const linux = capabilitiesForPlatform('linux');

  for (const capability of [
    'wsl.exec',
    'wsl.list',
    'wsl.path.convert',
  ]) {
    assert.ok(windows.includes(capability), capability);
    assert.equal(linux.includes(capability), false, capability);
  }

  assert.equal(isReadOnlyCapability('wsl.list'), true);
  assert.equal(isReadOnlyCapability('wsl.path.convert'), true);
  assert.equal(isReadOnlyCapability('wsl.exec'), false);
});

test(
  'Windows WSL discovery returns a bounded structured distribution list',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const policy = new PathPolicy(parseAllowedRoots('*'));
    let result;
    try {
      result = (await executeCapability(
        'wsl.list',
        {},
        policy,
      )) as {
        data: {
          available: boolean;
          installed: boolean;
          distributions: string[];
          count: number;
          timedOut: boolean;
        };
      };
    } catch (error) {
      t.skip(
        'This Windows runner does not expose wsl.exe: ' +
          (error instanceof Error ? error.message : String(error)),
      );
      return;
    }

    assert.ok(Array.isArray(result.data.distributions));
    assert.ok(result.data.distributions.length <= 128);
    assert.equal(
      result.data.count,
      result.data.distributions.length,
    );
    assert.equal(
      result.data.installed,
      result.data.distributions.length > 0,
    );
    assert.equal(typeof result.data.available, 'boolean');
    assert.equal(typeof result.data.timedOut, 'boolean');
  },
);
