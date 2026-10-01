import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  capabilitiesForAgent,
  filterRuntimeCapabilities,
} from '../src/agent/native-agent.js';

test('native agent hides browser capabilities when no browser executable is available', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-agent-caps-none-'),
  );

  try {
    const capabilities = await capabilitiesForAgent('linux', {
      PATH: root,
      NEXOWIRE_EDGE_PATH: '',
      NEXOWIRE_CHROME_PATH: '',
    });

    assert.equal(
      capabilities.some((capability) =>
        capability.startsWith('browser.'),
      ),
      false,
    );
    assert.ok(capabilities.includes('machine.snapshot'));
    assert.ok(capabilities.includes('shell.exec'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('native agent advertises browser capabilities when an executable is detected', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-agent-caps-browser-'),
  );
  const executable = path.join(root, 'google-chrome');

  try {
    await fs.writeFile(executable, '#!/bin/sh\nexit 0\n', 'utf8');
    await fs.chmod(executable, 0o755);

    const capabilities = await capabilitiesForAgent('linux', {
      PATH: root,
      NEXOWIRE_EDGE_PATH: '',
      NEXOWIRE_CHROME_PATH: '',
    });

    assert.ok(capabilities.includes('browser.session.start'));
    assert.ok(capabilities.includes('browser.snapshot'));
    assert.ok(capabilities.includes('browser.visual.verify'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('native agent hides wsl.exec when Windows has no installed WSL distro', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-agent-caps-no-wsl-'),
  );

  try {
    const capabilities = await capabilitiesForAgent('win32', {
      PATH: root,
      NEXOWIRE_EDGE_PATH: '',
      NEXOWIRE_CHROME_PATH: '',
    });

    assert.equal(capabilities.includes('wsl.exec'), false);
    assert.ok(capabilities.includes('windows.processes'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runtime capability filter retains wsl.exec only when WSL is actually available', () => {
  const available = filterRuntimeCapabilities('win32', {
    browser: false,
    wsl: true,
  });
  assert.ok(available.includes('wsl.exec'));

  const unavailable = filterRuntimeCapabilities('win32', {
    browser: false,
    wsl: false,
  });
  assert.equal(unavailable.includes('wsl.exec'), false);
});
