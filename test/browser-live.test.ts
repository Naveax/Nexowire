import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { BrowserManager } from '../src/agent/browser-manager.js';

test(
  'native browser manager drives a real local Edge page end-to-end',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'nexowire-browser-live-'),
    );
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
      });
      res.end(
        '<!doctype html><html><body>' +
          '<label>Name <input id="name" value=""></label>' +
          '<button id="go" onclick="document.getElementById(\'status\').textContent=\'clicked:\'+document.getElementById(\'name\').value">Go</button>' +
          '<div id="status">idle</div>' +
          '</body></html>',
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );

    const manager = new BrowserManager({ rootDir: root });
    t.after(async () => {
      await manager.stopAll();
      await new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      await fs.rm(root, { recursive: true, force: true });
    });

    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const url = 'http://127.0.0.1:' + address.port + '/';

    const started = await manager.start({
      browser: 'edge',
      headless: true,
      initialUrl: url,
      width: 800,
      height: 600,
    });

    const tabs = await manager.tabs(started.id);
    assert.ok(tabs.tabs.length >= 1);
    const page = tabs.tabs.find((tab) => tab.url === url) ?? tabs.tabs[0];
    assert.ok(page);

    const navigated = await manager.navigate({
      sessionId: started.id,
      targetId: page.id,
      url,
      timeoutMs: 15_000,
    });
    assert.equal(navigated.url, url);

    const before = await manager.snapshot({
      sessionId: started.id,
      targetId: page.id,
      maxElements: 50,
      maxTextChars: 5_000,
    });
    assert.ok(
      before.elements.some(
        (element) => element.selector === '#name',
      ),
    );
    assert.ok(
      before.elements.some(
        (element) => element.selector === '#go',
      ),
    );

    const value = await manager.setValue({
      sessionId: started.id,
      targetId: page.id,
      selector: '#name',
      value: 'Nexowire✓',
    });
    assert.equal(value.verified, true);
    assert.match(value.valueSha256, /^[a-f0-9]{64}$/);

    const click = await manager.click({
      sessionId: started.id,
      targetId: page.id,
      selector: '#go',
    });
    assert.equal(click.verified, true);

    await new Promise((resolve) => setTimeout(resolve, 100));

    const after = await manager.snapshot({
      sessionId: started.id,
      targetId: page.id,
      maxElements: 50,
      maxTextChars: 5_000,
    });
    assert.ok(
      after.bodyText.text.includes('clicked:Nexowire✓'),
    );

    const visual = await manager.visualVerify({
      sessionId: started.id,
      targetId: page.id,
      selector: '#status',
      expectedText: 'clicked:Nexowire✓',
      textMode: 'exact',
      expectedVisible: true,
      expectedEnabled: true,
      padding: 12,
      maxBytes: 1_000_000,
    });
    assert.equal(visual.verified, true);
    assert.equal(visual.element.visible, true);
    assert.equal(visual.element.hittable, true);
    assert.ok(visual.screenshot.bytes > 100);
    assert.ok(visual.screenshot.width > 0);
    assert.ok(visual.screenshot.height > 0);
    assert.match(visual.screenshot.sha256, /^[a-f0-9]{64}$/);
    assert.ok(visual.screenshot.base64.length > 100);

    const screenshot = await manager.screenshot({
      sessionId: started.id,
      targetId: page.id,
      maxBytes: 2_000_000,
    });
    assert.equal(screenshot.mimeType, 'image/png');
    assert.ok(screenshot.bytes > 100);
    assert.ok(screenshot.width > 0);
    assert.ok(screenshot.height > 0);
    assert.match(screenshot.sha256, /^[a-f0-9]{64}$/);
    assert.ok(screenshot.base64.length > 100);
  },
);
