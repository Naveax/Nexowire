import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  BrowserControlError,
  BrowserManager,
  browserCapabilitiesAvailable,
  detectBrowserExecutable,
  validateBrowserUrl,
} from '../src/agent/browser-manager.js';

test('browser URL validation allows only HTTP(S) and about:blank', () => {
  assert.equal(validateBrowserUrl('about:blank'), 'about:blank');
  assert.equal(
    validateBrowserUrl('https://example.com/path?q=1'),
    'https://example.com/path?q=1',
  );
  assert.equal(
    validateBrowserUrl('http://localhost:8080/test'),
    'http://localhost:8080/test',
  );

  for (const denied of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hello',
    'ftp://example.com/file',
  ]) {
    assert.throws(
      () => validateBrowserUrl(denied),
      (error: unknown) =>
        error instanceof BrowserControlError &&
        error.code === 'BROWSER_URL_SCHEME_DENIED',
    );
  }

  assert.throws(
    () => validateBrowserUrl('not a url'),
    (error: unknown) =>
      error instanceof BrowserControlError &&
      error.code === 'BROWSER_URL_INVALID',
  );
});

test('browser manager rejects unsafe URL before executable discovery', async () => {
  const manager = new BrowserManager({
    env: {
      ...process.env,
      NEXOWIRE_EDGE_PATH: '',
      NEXOWIRE_CHROME_PATH: '',
    },
  });

  await assert.rejects(
    () =>
      manager.start({
        browser: 'auto',
        initialUrl: 'file:///tmp/secret.txt',
      }),
    (error: unknown) =>
      error instanceof BrowserControlError &&
      error.code === 'BROWSER_URL_SCHEME_DENIED',
  );
});

test('browser manager list begins empty', () => {
  const manager = new BrowserManager();
  assert.deepEqual(manager.list(), []);
});


test('browser executable detection honors explicit executable overrides', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-browser-detect-'),
  );
  const executable = path.join(root, 'custom-browser');
  try {
    await fs.writeFile(executable, '#!/bin/sh\nexit 0\n', 'utf8');
    await fs.chmod(executable, 0o755);

    const detected = await detectBrowserExecutable('chrome', {
      platform: 'linux',
      env: {
        ...process.env,
        NEXOWIRE_CHROME_PATH: executable,
        PATH: '',
      },
      homeDir: root,
    });
    assert.deepEqual(detected, {
      browser: 'chrome',
      executable,
    });
    assert.equal(
      await browserCapabilitiesAvailable({
        platform: 'linux',
        env: {
          ...process.env,
          NEXOWIRE_CHROME_PATH: executable,
          PATH: '',
        },
        homeDir: root,
      }),
      true,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('browser executable detection searches Linux PATH and macOS user Applications', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-browser-platforms-'),
  );
  try {
    const binDir = path.join(root, 'bin');
    await fs.mkdir(binDir, { recursive: true });
    const linuxChrome = path.join(binDir, 'google-chrome');
    await fs.writeFile(linuxChrome, '#!/bin/sh\nexit 0\n', 'utf8');
    await fs.chmod(linuxChrome, 0o755);

    assert.deepEqual(
      await detectBrowserExecutable('auto', {
        platform: 'linux',
        env: {
          PATH: binDir,
          NEXOWIRE_EDGE_PATH: '',
          NEXOWIRE_CHROME_PATH: '',
        },
        homeDir: root,
      }),
      {
        browser: 'chrome',
        executable: linuxChrome,
      },
    );

    const macChrome = path.join(
      root,
      'Applications',
      'Google Chrome.app',
      'Contents',
      'MacOS',
      'Google Chrome',
    );
    await fs.mkdir(path.dirname(macChrome), { recursive: true });
    await fs.writeFile(macChrome, '#!/bin/sh\nexit 0\n', 'utf8');
    await fs.chmod(macChrome, 0o755);

    assert.deepEqual(
      await detectBrowserExecutable('chrome', {
        platform: 'darwin',
        env: {
          NEXOWIRE_EDGE_PATH: '',
          NEXOWIRE_CHROME_PATH: macChrome,
          PATH: '',
        },
        homeDir: root,
      }),
      {
        browser: 'chrome',
        executable: macChrome,
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('browser capability availability is false when no supported executable exists', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-browser-none-'),
  );
  try {
    assert.equal(
      await browserCapabilitiesAvailable({
        platform: 'linux',
        env: {
          PATH: root,
          NEXOWIRE_EDGE_PATH: '',
          NEXOWIRE_CHROME_PATH: '',
        },
        homeDir: root,
      }),
      false,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
