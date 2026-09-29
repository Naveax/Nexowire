import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BrowserControlError,
  BrowserManager,
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
