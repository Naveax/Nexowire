import test from 'node:test';
import assert from 'node:assert/strict';
import {
  executeBrowserCapability,
  type BrowserRuntime,
} from '../src/agent/browser-control.js';
import { isReadOnlyCapability } from '../src/protocol/capabilities.js';

class FakeBrowserRuntime implements BrowserRuntime {
  calls: Array<{ method: string; input: unknown }> = [];

  async start(input: unknown) {
    this.calls.push({ method: 'start', input });
    return { id: '11111111-1111-4111-8111-111111111111' };
  }

  list() {
    this.calls.push({ method: 'list', input: {} });
    return [{ id: 'session-1' }];
  }

  async stop(sessionId: string) {
    this.calls.push({ method: 'stop', input: sessionId });
    return { stopped: true };
  }

  async tabs(sessionId: string) {
    this.calls.push({ method: 'tabs', input: sessionId });
    return { tabs: [] };
  }

  async navigate(input: unknown) {
    this.calls.push({ method: 'navigate', input });
    return { url: 'https://example.com/' };
  }

  async snapshot(input: unknown) {
    this.calls.push({ method: 'snapshot', input });
    return { elements: [] };
  }

  async click(input: unknown) {
    this.calls.push({ method: 'click', input });
    return { verified: true };
  }

  async setValue(input: unknown) {
    this.calls.push({ method: 'setValue', input });
    return { verified: true };
  }

  async screenshot(input: unknown) {
    this.calls.push({ method: 'screenshot', input });
    return { mimeType: 'image/png', base64: 'AA==' };
  }
}

test('browser capability dispatcher normalizes inputs', async () => {
  const runtime = new FakeBrowserRuntime();
  const sessionId = '11111111-1111-4111-8111-111111111111';

  await executeBrowserCapability(
    'browser.session.start',
    {
      browser: 'edge',
      headless: false,
      initial_url: 'https://example.com',
      width: 1280,
      height: 720,
    },
    runtime,
  );
  await executeBrowserCapability(
    'browser.navigate',
    {
      session_id: sessionId,
      target_id: 'page-1',
      url: 'https://example.com/next',
      timeout_ms: 12_000,
    },
    runtime,
  );
  await executeBrowserCapability(
    'browser.snapshot',
    {
      session_id: sessionId,
      max_elements: 100,
      include_hidden: true,
    },
    runtime,
  );
  await executeBrowserCapability(
    'browser.click',
    {
      session_id: sessionId,
      selector: '#submit',
      click_count: 2,
    },
    runtime,
  );

  assert.deepEqual(runtime.calls[0], {
    method: 'start',
    input: {
      browser: 'edge',
      headless: false,
      initialUrl: 'https://example.com',
      width: 1280,
      height: 720,
    },
  });
  assert.deepEqual(runtime.calls[1], {
    method: 'navigate',
    input: {
      sessionId,
      targetId: 'page-1',
      url: 'https://example.com/next',
      timeoutMs: 12_000,
    },
  });
  assert.deepEqual(runtime.calls[2], {
    method: 'snapshot',
    input: {
      sessionId,
      maxElements: 100,
      maxTextChars: 20_000,
      maxElementTextChars: 500,
      includeHidden: true,
    },
  });
  assert.deepEqual(runtime.calls[3], {
    method: 'click',
    input: {
      sessionId,
      selector: '#submit',
      button: 'left',
      clickCount: 2,
    },
  });
});

test('browser capability dispatcher rejects malformed session IDs and oversized input', async () => {
  const runtime = new FakeBrowserRuntime();

  await assert.rejects(
    () =>
      executeBrowserCapability(
        'browser.tabs',
        { session_id: 'not-a-uuid' },
        runtime,
      ),
    /Invalid UUID/,
  );

  await assert.rejects(
    () =>
      executeBrowserCapability(
        'browser.set_value',
        {
          session_id: '11111111-1111-4111-8111-111111111111',
          selector: '#input',
          value: 'x'.repeat(20_001),
        },
        runtime,
      ),
  );
});

test('browser read-only capabilities are failover-safe but mutations are not', () => {
  for (const capability of [
    'browser.session.list',
    'browser.tabs',
    'browser.snapshot',
    'browser.screenshot',
  ]) {
    assert.equal(isReadOnlyCapability(capability), true, capability);
  }

  for (const capability of [
    'browser.session.start',
    'browser.session.stop',
    'browser.navigate',
    'browser.click',
    'browser.set_value',
  ]) {
    assert.equal(isReadOnlyCapability(capability), false, capability);
  }
});
